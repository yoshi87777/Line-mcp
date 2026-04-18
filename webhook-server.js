import express from 'express';
import { middleware } from '@line/bot-sdk';
import { GoogleGenAI } from '@google/genai';
import { createClient } from '@supabase/supabase-js';
import axios from 'axios';
import { execSync } from 'child_process';
import dotenv from 'dotenv';

dotenv.config();

const app = express();

const channelAccessToken = process.env.CHANNEL_ACCESS_TOKEN;
const channelSecret = process.env.CHANNEL_SECRET;

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const GEMINI_KEYS = [
  process.env.GEMINI_API_KEY,
  ...process.env.GEMINI_API_KEYS_EXTRA?.split(',').filter(Boolean) || [],
];
const GEMINI_MODEL = 'gemini-2.5-flash';
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 2000;
const HISTORY_LIMIT = 20;

const YOSHIKI_USER_ID = process.env.DESTINATION_USER_ID;

const ARIA_API_URL = 'http://127.0.0.1:8000';
const ARIA_API_TOKEN = process.env.ARIA_API_TOKEN || 'aria-mobile-2026';

// ── 起動時セキュリティチェック ───────────────────────────────────────────────

function runStartupChecks() {
  const checks = [];
  let ok = true;

  if (!YOSHIKI_USER_ID) {
    checks.push('FAIL: DESTINATION_USER_ID not set — ARIA privacy lock is DISABLED');
    ok = false;
  } else {
    checks.push(`OK: ARIA privacy lock enabled (${YOSHIKI_USER_ID.slice(0, 8)}...)`);
  }

  if (!process.env.CHANNEL_ACCESS_TOKEN) {
    checks.push('FAIL: CHANNEL_ACCESS_TOKEN not set');
    ok = false;
  } else {
    checks.push('OK: LINE channel token configured');
  }

  if (!process.env.GEMINI_API_KEY) {
    checks.push('WARN: GEMINI_API_KEY not set — Gemini fallback will fail');
  } else {
    checks.push(`OK: Gemini API keys configured (${GEMINI_KEYS.filter(Boolean).length} keys)`);
  }

  if (!process.env.SUPABASE_URL) {
    checks.push('WARN: SUPABASE_URL not set — conversation history disabled');
  } else {
    checks.push('OK: Supabase configured');
  }

  console.log('\n=== STARTUP SECURITY CHECK ===');
  checks.forEach(c => console.log(c));
  if (!ok) {
    console.error('CRITICAL: Startup checks FAILED — server may have privacy issues');
    process.exit(1);
  }
  console.log('==============================\n');
}

function getGitCommit() {
  try {
    return execSync('git rev-parse --short HEAD', { cwd: '/root/Line-mcp' }).toString().trim();
  } catch {
    try {
      return execSync('git rev-parse --short HEAD').toString().trim();
    } catch {
      return 'unknown';
    }
  }
}

async function getSystemStatus() {
  const commit = getGitCommit();

  // Supabase connectivity
  let supabaseOk = false;
  try {
    const { error } = await supabase.from('line_conversations').select('id').limit(1);
    supabaseOk = !error;
  } catch { /* noop */ }

  // ARIA connectivity
  let ariaOk = false;
  try {
    const res = await axios.get(`${ARIA_API_URL}/health`, { timeout: 3000 }).catch(() =>
      axios.get(`${ARIA_API_URL}/`, { timeout: 3000 })
    );
    ariaOk = res.status < 500;
  } catch { /* noop */ }

  return {
    commit,
    yoshikiLock: YOSHIKI_USER_ID ? `${YOSHIKI_USER_ID.slice(0, 8)}...` : 'NOT SET !!!',
    ariaPrivacyLock: !!YOSHIKI_USER_ID,
    geminiKeys: GEMINI_KEYS.filter(Boolean).length,
    supabase: supabaseOk ? 'OK' : 'NG',
    aria: ariaOk ? 'OK' : 'NG',
    model: GEMINI_MODEL,
    uptime: Math.floor(process.uptime()) + 's',
  };
}

// LINE middleware
app.use(middleware({ channelAccessToken, channelSecret }));

// ── /health エンドポイント ────────────────────────────────────────────────────
app.get('/health', async (req, res) => {
  const status = await getSystemStatus();
  const healthy = status.ariaPrivacyLock && status.supabase === 'OK';
  res.status(healthy ? 200 : 503).json({ healthy, ...status });
});

app.post('/webhook', (req, res) => {
  const events = req.body.events;
  console.log(`Received ${events.length} events`);
  res.json({ success: true });
  events.forEach((event) => {
    console.log('Event:', JSON.stringify(event.source, null, 2));
    if (event.type === 'message' && event.message.type === 'text') {
      handleTextMessage(event).catch((err) =>
        console.error('handleTextMessage error:', err.message)
      );
    }
  });
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function getSourceId(source) {
  if (source.type === 'group') return source.groupId;
  if (source.type === 'room') return source.roomId;
  return source.userId;
}

async function saveMessage(sourceId, sourceType, role, message) {
  const { error } = await supabase.from('line_conversations').insert({
    source_id: sourceId,
    source_type: sourceType,
    role,
    message,
  });
  if (error) console.error('Supabase insert error:', error.message);
}

async function getHistory(sourceId) {
  const { data, error } = await supabase
    .from('line_conversations')
    .select('role, message')
    .eq('source_id', sourceId)
    .order('created_at', { ascending: false })
    .limit(HISTORY_LIMIT);
  if (error) { console.error('Supabase select error:', error.message); return []; }
  return (data || []).reverse();
}

// ── ARIA /chat（Yoshikiのみ） ────────────────────────────────────────────────

async function callAriaChat(userMessage) {
  // Get Yoshiki's stored conversation_id
  const { data: user } = await supabase
    .from('users')
    .select('id, aria_conversation_id')
    .eq('line_user_id', YOSHIKI_USER_ID)
    .single();

  const body = {
    message: userMessage,
    context: '必ず日本語で回答してください。',
  };
  if (user?.aria_conversation_id) body.conversation_id = user.aria_conversation_id;

  try {
    const res = await axios.post(
      `${ARIA_API_URL}/chat`,
      body,
      {
        headers: {
          'Content-Type': 'application/json',
          'ARIA-TOKEN': ARIA_API_TOKEN,
        },
        timeout: 25000,
      }
    );

    const reply = res.data?.reply?.trim();
    const convId = res.data?.conversation_id;

    // Save conversation_id
    if (convId && user && convId !== user.aria_conversation_id) {
      await supabase.from('users').update({ aria_conversation_id: convId }).eq('id', user.id);
    }

    if (reply) {
      console.log(`ARIA OK conv=${convId} (${reply.length} chars)`);
      return reply;
    }
  } catch (err) {
    console.error('ARIA chat error:', err.message);
  }
  return null;
}

// ── Gemini（秘書・グループ） ────────────────────────────────────────────────

async function callGemini(userMessage, history, systemPrompt) {
  const chatHistory = history.map((h) => ({
    role: h.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: h.message }],
  }));

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    for (const key of GEMINI_KEYS) {
      if (!key) continue;
      try {
        const ai = new GoogleGenAI({ apiKey: key });
        const chat = ai.chats.create({
          model: GEMINI_MODEL,
          config: { systemInstruction: systemPrompt, temperature: 0.7, maxOutputTokens: 1024 },
          history: chatHistory,
        });
        const response = await chat.sendMessage({ message: userMessage });
        const text = response.text?.trim();
        if (text) {
          console.log(`Gemini OK (${text.length} chars)`);
          return text;
        }
      } catch (err) {
        const errStr = String(err);
        if (errStr.includes('503') || errStr.includes('UNAVAILABLE')) {
          await sleep(RETRY_DELAY_MS); break;
        }
        if (errStr.includes('quota') || errStr.includes('429')) continue;
        console.error('Gemini error:', err.message);
        return null;
      }
    }
  }
  return null;
}

async function replyLine(replyToken, text) {
  await axios.post(
    'https://api.line.me/v2/bot/message/reply',
    { replyToken, messages: [{ type: 'text', text }] },
    { headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${channelAccessToken}` } }
  );
  console.log('Reply sent');
}

// ── プロンプト ───────────────────────────────────────────────────────────────

const GROUP_PROMPT = `あなたは親切なアシスタントです。自然な関西弁（軽め）で簡潔に回答してください。`;

const SECRETARY_PROMPT = `あなたはYoshikiの個人秘書です。丁寧で落ち着いた自然な日本語で対応してください。
- 雑談・質問には自然に応じる
- 食事・飲み会などの誘いは日時・場所を確認し「Yoshikiに確認の上、折り返しご連絡いたします」と伝える
- Yoshikiの個人情報・予定詳細は一切開示しない
- 判断できないことは「Yoshikiに確認してご連絡いたします」と伝える`;

// ── 定期ヘルスチェック（毎朝 8:00 JST にYoshikiへLINE通知） ─────────────────

async function pushStatusToYoshiki() {
  if (!YOSHIKI_USER_ID) return;
  const s = await getSystemStatus();
  const issues = [];
  if (!s.ariaPrivacyLock) issues.push('ARIA プライバシーロック: 未設定！');
  if (s.supabase !== 'OK') issues.push('Supabase: 接続NG');
  if (s.geminiKeys === 0) issues.push('Gemini APIキー: 未設定');

  const icon = issues.length ? '🚨' : '✅';
  const body = issues.length
    ? `問題あり:\n${issues.join('\n')}`
    : '全チェックOK';

  const text = `${icon} デイリーヘルスチェック\n` +
    `commit: ${s.commit}\n` +
    `Yoshikiロック: ${s.ariaPrivacyLock ? 'ON' : 'OFF !!!'}\n` +
    `Supabase: ${s.supabase}\n` +
    `ARIA: ${s.aria}\n` +
    `Geminiキー数: ${s.geminiKeys}\n` +
    `uptime: ${s.uptime}\n\n` +
    body;

  await axios.post(
    'https://api.line.me/v2/bot/message/push',
    { to: YOSHIKI_USER_ID, messages: [{ type: 'text', text }] },
    { headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${channelAccessToken}` } }
  ).catch(err => console.error('Health push error:', err.message));
}

// 毎朝 8:00 JST (= UTC 23:00 前日) に実行
function scheduleDailyHealthCheck() {
  function msUntilNext8amJST() {
    const now = new Date();
    const next = new Date(now);
    // JST = UTC+9
    const jstHour = (now.getUTCHours() + 9) % 24;
    const jstMinute = now.getUTCMinutes();
    let hoursUntil = (8 - jstHour + 24) % 24;
    if (hoursUntil === 0 && jstMinute > 0) hoursUntil = 24;
    return (hoursUntil * 60 - jstMinute) * 60 * 1000;
  }

  function scheduleNext() {
    const delay = msUntilNext8amJST();
    console.log(`Next health check in ${Math.round(delay / 60000)} min`);
    setTimeout(async () => {
      await pushStatusToYoshiki();
      setInterval(pushStatusToYoshiki, 24 * 60 * 60 * 1000);
    }, delay);
  }

  scheduleNext();
}

// ── ハンドラ ─────────────────────────────────────────────────────────────────

async function handleTextMessage(event) {
  const { replyToken, message, source } = event;
  const userId = source.userId;
  const sourceId = getSourceId(source);
  const userMessage = message.text;

  console.log(`[${sourceId}] User: ${userMessage}`);

  // ── Yoshiki DM → ARIA ──
  if (source.type === 'user' && userId === YOSHIKI_USER_ID) {
    // !status コマンド
    if (userMessage.trim() === '!status') {
      const s = await getSystemStatus();
      const text = `🔍 システムステータス\n` +
        `commit: ${s.commit}\n` +
        `Yoshikiロック: ${s.ariaPrivacyLock ? 'ON ✅' : 'OFF 🚨'}\n` +
        `Supabase: ${s.supabase}\n` +
        `ARIA: ${s.aria}\n` +
        `Geminiキー数: ${s.geminiKeys}\n` +
        `モデル: ${s.model}\n` +
        `uptime: ${s.uptime}`;
      await replyLine(replyToken, text);
      return;
    }

    await saveMessage(userId, 'user', 'user', userMessage);
    const reply = await callAriaChat(userMessage)
      || await callGemini(userMessage, await getHistory(userId), GROUP_PROMPT);
    await replyLine(replyToken, reply || '応答できませんでした。');
    if (reply) await saveMessage(userId, 'user', 'assistant', reply);
    return;
  }

  // ── 他人DM → 秘書（Geminiのみ、ARIA触れない） ──
  if (source.type === 'user') {
    console.log(`[Secretary] DM from ${userId}`);
    await saveMessage(userId, 'user', 'user', userMessage);
    const history = await getHistory(userId);
    const reply = await callGemini(userMessage, history, SECRETARY_PROMPT);
    await replyLine(replyToken, reply || 'ただいま対応できません。');
    if (reply) await saveMessage(userId, 'user', 'assistant', reply);
    return;
  }

  // ── グループ → Gemini（ARIA触れない） ──
  await saveMessage(sourceId, source.type, 'user', userMessage);
  const history = await getHistory(sourceId);
  const reply = await callGemini(userMessage, history, GROUP_PROMPT);
  if (reply) {
    await replyLine(replyToken, reply);
    await saveMessage(sourceId, source.type, 'assistant', reply);
  } else {
    await replyLine(replyToken, 'AIが応答できませんでした。');
  }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Webhook server running on port ${PORT} (model: ${GEMINI_MODEL})`);
  runStartupChecks();
  scheduleDailyHealthCheck();
});
