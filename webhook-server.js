import express from 'express';
import { middleware } from '@line/bot-sdk';
import { GoogleGenAI } from '@google/genai';
import { createClient } from '@supabase/supabase-js';
import axios from 'axios';
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

// LINE middleware
app.use(middleware({ channelAccessToken, channelSecret }));

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

// ── ハンドラ ─────────────────────────────────────────────────────────────────

async function handleTextMessage(event) {
  const { replyToken, message, source } = event;
  const userId = source.userId;
  const sourceId = getSourceId(source);
  const userMessage = message.text;

  console.log(`[${sourceId}] User: ${userMessage}`);

  // ── Yoshiki DM → ARIA ──
  if (source.type === 'user' && userId === YOSHIKI_USER_ID) {
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
});
