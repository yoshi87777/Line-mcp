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

const CONTACTS = {
  'popcorn': 'Cb3bc41ff3a128369d5736430d040a590',
  'なかにしよグループ': 'Cb3bc41ff3a128369d5736430d040a590',
  'グループ': 'Cb3bc41ff3a128369d5736430d040a590',
};

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

async function getAriaUser(lineUserId) {
  const { data: existing } = await supabase
    .from('users')
    .select('id, line_command_enabled')
    .eq('line_user_id', lineUserId)
    .single();
  if (existing) return existing;

  const { data: created, error } = await supabase
    .from('users')
    .insert({
      name: `LINE_${lineUserId.slice(0, 8)}`,
      email: `line_${lineUserId}@aria-nova.xyz`,
      password_hash: '',
      line_user_id: lineUserId,
      is_active: true,
      line_command_enabled: false,
    })
    .select('id, line_command_enabled')
    .single();

  if (error) { console.error('Failed to auto-create user:', error.message); return null; }
  console.log(`Auto-created ARIA user ${created.id} for LINE ID ${lineUserId}`);
  return created;
}

// ── ARIA API tools ──────────────────────────────────────────────────────────

async function ariaRequest(method, path, ariaUserId, body = null) {
  const res = await axios({
    method,
    url: `${ARIA_API_URL}${path}`,
    headers: {
      'Content-Type': 'application/json',
      'ARIA-TOKEN': ARIA_API_TOKEN,
      'ARIA-USER-ID': String(ariaUserId),
    },
    data: body,
    timeout: 15000,
  });
  return res.data;
}

async function executeTool(toolName, args, ariaUserId) {
  try {
    switch (toolName) {
      case 'get_tasks': {
        const data = await ariaRequest('GET', '/tasks/today', ariaUserId);
        return JSON.stringify(data);
      }
      case 'add_task': {
        const data = await ariaRequest('POST', '/tasks/add', ariaUserId, { text: args.title });
        return JSON.stringify(data);
      }
      case 'complete_task': {
        const data = await ariaRequest('POST', `/tasks/complete/${args.task_id}`, ariaUserId);
        return JSON.stringify(data);
      }
      case 'get_schedule': {
        const data = await ariaRequest('GET', '/schedule/today', ariaUserId);
        return JSON.stringify(data);
      }
      case 'request_schedule': {
        // Save pending request to Supabase
        const { data: req, error } = await supabase.from('schedule_requests').insert({
          requester_line_id: args._requesterLineId || 'unknown',
          requester_name: args._requesterName || '相手',
          title: args.title,
          event_date: args.event_date || null,
          start_time: args.start_time || null,
          location: args.location || null,
          status: 'pending',
        }).select('id').single();

        if (error) return `登録エラー: ${error.message}`;

        // Notify Yoshiki via LINE DM
        const when = args.start_time ? `${args.event_date} ${args.start_time}` : args.event_date;
        const where = args.location ? ` / ${args.location}` : '';
        const notifyMsg = `📅 スケジュールリクエスト [#${req.id}]\n「${args.title}」\n日時: ${when}${where}\n\n承認: 「承認 ${req.id}」\n拒否: 「拒否 ${req.id}」`;
        await axios.post(
          'https://api.line.me/v2/bot/message/push',
          { to: YOSHIKI_USER_ID, messages: [{ type: 'text', text: notifyMsg }] },
          { headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${channelAccessToken}` } }
        );
        console.log(`[Secretary] Schedule request #${req.id} sent to Yoshiki`);
        return `リクエスト#${req.id}をYoshikiに送りました。`;
      }

      case 'send_line_message': {
        const targetName = args.target.toLowerCase();
        const entry = Object.entries(CONTACTS).find(([name]) =>
          targetName.includes(name) || name.includes(targetName)
        );
        if (!entry) return `送信先「${args.target}」が見つかりません。登録済み: ${Object.keys(CONTACTS).join(', ')}`;
        await axios.post(
          'https://api.line.me/v2/bot/message/push',
          { to: entry[1], messages: [{ type: 'text', text: args.message }] },
          { headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${channelAccessToken}` } }
        );
        return `${entry[0]}にメッセージを送信しました。`;
      }
      default:
        return 'unknown tool';
    }
  } catch (err) {
    console.error(`Tool ${toolName} error:`, err.message);
    return `エラー: ${err.message}`;
  }
}

// 秘書用ツール定義（スケジュールリクエストのみ）
const SECRETARY_TOOLS = [{
  functionDeclarations: [
    {
      name: 'request_schedule',
      description: '日程調整の情報が揃ったら、Yoshikiに承認リクエストを送る。日時・内容が確定した時のみ呼ぶ。',
      parameters: {
        type: 'OBJECT',
        properties: {
          title: { type: 'STRING', description: 'イベント名・内容（例: Popcornとのディナー）' },
          event_date: { type: 'STRING', description: '日付（YYYY-MM-DD形式）' },
          start_time: { type: 'STRING', description: '開始時間（HH:MM形式、不明なら空）' },
          location: { type: 'STRING', description: '場所（不明なら空）' },
        },
        required: ['title', 'event_date'],
      },
    },
  ],
}];

// Yoshiki用のツール定義
const YOSHIKI_TOOLS = [{
  functionDeclarations: [
    {
      name: 'get_tasks',
      description: '今日のタスク一覧を取得する',
      parameters: { type: 'OBJECT', properties: {}, required: [] },
    },
    {
      name: 'add_task',
      description: 'タスクを追加する',
      parameters: {
        type: 'OBJECT',
        properties: { title: { type: 'STRING', description: 'タスクのタイトル' } },
        required: ['title'],
      },
    },
    {
      name: 'complete_task',
      description: 'タスクを完了にする',
      parameters: {
        type: 'OBJECT',
        properties: { task_id: { type: 'INTEGER', description: 'タスクのID' } },
        required: ['task_id'],
      },
    },
    {
      name: 'get_schedule',
      description: '今日のスケジュールを取得する',
      parameters: { type: 'OBJECT', properties: {}, required: [] },
    },
    {
      name: 'send_line_message',
      description: '指定した相手にLINEメッセージを送る',
      parameters: {
        type: 'OBJECT',
        properties: {
          target: { type: 'STRING', description: '送信先の名前（例: Popcorn）' },
          message: { type: 'STRING', description: '送るメッセージ内容' },
        },
        required: ['target', 'message'],
      },
    },
  ],
}];

// ── 会話エージェント ────────────────────────────────────────────────────────

async function runConversationAgent(userMessage, history, systemPrompt, tools, ariaUserId, extraArgs = {}) {
  const chatHistory = history.map((h) => ({
    role: h.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: h.message }],
  }));

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    for (const key of GEMINI_KEYS) {
      if (!key) continue;
      try {
        const ai = new GoogleGenAI({ apiKey: key });
        const config = { systemInstruction: systemPrompt, temperature: 0.7, maxOutputTokens: 1024 };
        if (tools) config.tools = tools;

        const chat = ai.chats.create({ model: GEMINI_MODEL, config, history: chatHistory });
        let response = await chat.sendMessage({ message: userMessage });

        // Function calling loop
        while (response.functionCalls && response.functionCalls.length > 0) {
          const toolResults = [];
          for (const call of response.functionCalls) {
            console.log(`[Tool] ${call.name}(${JSON.stringify(call.args)})`);
            const result = await executeTool(call.name, { ...call.args, ...extraArgs }, ariaUserId);
            toolResults.push({ name: call.name, response: { result } });
          }
          response = await chat.sendMessage({ functionResponses: toolResults });
        }

        const text = response.text?.trim();
        if (text) {
          console.log(`Agent OK (${text.length} chars)`);
          return text;
        }
      } catch (err) {
        const errStr = String(err);
        if (errStr.includes('503') || errStr.includes('UNAVAILABLE')) {
          console.log(`Attempt ${attempt + 1}/${MAX_RETRIES}: 503, retrying...`);
          await sleep(RETRY_DELAY_MS);
          break;
        }
        if (errStr.includes('quota') || errStr.includes('429')) {
          console.log('Key quota exhausted, trying next key...');
          continue;
        }
        console.error('Agent error:', err.message);
        return null;
      }
    }
  }
  return null;
}

// ── ハンドラ ────────────────────────────────────────────────────────────────

const YOSHIKI_SYSTEM_PROMPT = `あなたはYoshikiの個人AIアシスタントです。自然な関西弁（軽め）で簡潔に答えてください。
タスク確認・追加・完了、スケジュール確認、LINEメッセージ送信などのツールを使えます。必要に応じて使ってください。`;

const SECRETARY_SYSTEM_PROMPT = `あなたはYoshikiの個人秘書です。丁寧で落ち着いた自然な日本語で対応してください。
- 雑談・質問には自然に応じる
- 食事・飲み会などの誘いは日時・場所を確認し「Yoshikiに確認の上、折り返しご連絡いたします」と伝える
- Yoshikiの個人情報・予定詳細は一切開示しない
- 判断できないことは「Yoshikiに確認してご連絡いたします」と伝える`;

// Yoshikiの承認/拒否コマンドを処理
async function handleApproval(replyToken, userMessage) {
  const approveMatch = userMessage.match(/^承認\s*(\d+)/);
  const rejectMatch = userMessage.match(/^拒否\s*(\d+)/);
  const match = approveMatch || rejectMatch;
  if (!match) return false;

  const reqId = parseInt(match[1]);
  const approved = !!approveMatch;

  const { data: req, error } = await supabase
    .from('schedule_requests')
    .update({ status: approved ? 'approved' : 'rejected', updated_at: new Date().toISOString() })
    .eq('id', reqId)
    .eq('status', 'pending')
    .select('*')
    .single();

  if (error || !req) {
    await replyLine(replyToken, `リクエスト#${reqId}が見つかりません。`);
    return true;
  }

  if (approved) {
    // Confirm to Yoshiki
    await replyLine(replyToken, `✅ #${reqId}「${req.title}」を承認しました。`);
    // Notify requester via push
    const msg = `Yoshikiより確認が取れました。\n「${req.title}」（${req.event_date}${req.location ? ' / ' + req.location : ''}）\nよろしくお願いいたします。`;
    await axios.post(
      'https://api.line.me/v2/bot/message/push',
      { to: req.requester_line_id, messages: [{ type: 'text', text: msg }] },
      { headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${channelAccessToken}` } }
    );
  } else {
    await replyLine(replyToken, `❌ #${reqId}「${req.title}」を拒否しました。`);
    const msg = `申し訳ございません。Yoshikiのスケジュールの都合により、「${req.title}」のご要望にお応えできかねます。また改めてご連絡いただければ幸いです。`;
    await axios.post(
      'https://api.line.me/v2/bot/message/push',
      { to: req.requester_line_id, messages: [{ type: 'text', text: msg }] },
      { headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${channelAccessToken}` } }
    );
  }
  return true;
}

async function handleDM(replyToken, lineUserId, userMessage) {
  // Hard lock: only Yoshiki accesses ARIA tools
  if (lineUserId !== YOSHIKI_USER_ID) {
    console.log(`[Secretary] DM from ${lineUserId}`);
    const history = await getHistory(lineUserId);
    await saveMessage(lineUserId, 'user', 'user', userMessage);

    // Inject requester context into tool calls via a wrapper
    const secretaryTools = JSON.parse(JSON.stringify(SECRETARY_TOOLS));
    const reply = await runConversationAgent(
      userMessage, history, SECRETARY_SYSTEM_PROMPT, secretaryTools, null,
      { _requesterLineId: lineUserId }
    );
    await replyLine(replyToken, reply || 'ただいま対応できません。');
    if (reply) await saveMessage(lineUserId, 'user', 'assistant', reply);
    return;
  }

  // Yoshiki: check for approval commands first
  const handled = await handleApproval(replyToken, userMessage);
  if (handled) return;

  // Yoshiki: normal conversation with full ARIA tools
  const ariaUser = await getAriaUser(lineUserId);
  if (!ariaUser) { await replyLine(replyToken, 'エラーが発生しました。'); return; }

  console.log(`[Yoshiki] ariaUserId=${ariaUser.id} message="${userMessage}"`);
  const history = await getHistory(lineUserId);
  await saveMessage(lineUserId, 'user', 'user', userMessage);

  const reply = await runConversationAgent(
    userMessage, history, YOSHIKI_SYSTEM_PROMPT, YOSHIKI_TOOLS, ariaUser.id
  );
  await replyLine(replyToken, reply || 'ただいま応答できません。');
  if (reply) await saveMessage(lineUserId, 'user', 'assistant', reply);
}

async function replyLine(replyToken, text) {
  await axios.post(
    'https://api.line.me/v2/bot/message/reply',
    { replyToken, messages: [{ type: 'text', text }] },
    { headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${channelAccessToken}` } }
  );
  console.log('Reply sent');
}

async function handleTextMessage(event) {
  const { replyToken, message, source } = event;
  const userId = source.userId;
  const sourceId = getSourceId(source);
  const userMessage = message.text;

  console.log(`[${sourceId}] User: ${userMessage}`);

  // DM
  if (source.type === 'user') {
    return handleDM(replyToken, userId, userMessage);
  }

  // Group: conversation only, no ARIA
  await saveMessage(sourceId, source.type, 'user', userMessage);
  const history = await getHistory(sourceId);
  const reply = await runConversationAgent(userMessage, history, YOSHIKI_SYSTEM_PROMPT, null, null);
  if (reply) {
    await replyLine(replyToken, reply);
    await saveMessage(sourceId, source.type, 'assistant', reply);
  } else {
    await replyLine(replyToken, 'AIが応答できませんでした。もう一度試してください。');
  }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Webhook server running on port ${PORT} (model: ${GEMINI_MODEL})`);
});
