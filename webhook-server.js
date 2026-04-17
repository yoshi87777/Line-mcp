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

// Supabase client
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Gemini keys rotation
const GEMINI_KEYS = [
  process.env.GEMINI_API_KEY,
  ...process.env.GEMINI_API_KEYS_EXTRA?.split(',').filter(Boolean) || [],
];
const GEMINI_MODEL = 'gemini-2.5-flash';
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 2000;
const HISTORY_LIMIT = 20; // number of past messages to include as context

// Yoshiki's user ID — messages from this ID in DM are treated as commands
const YOSHIKI_USER_ID = process.env.DESTINATION_USER_ID;

// Contact name → LINE ID mapping (add more as needed)
const CONTACTS = {
  'popcorn': 'Cb3bc41ff3a128369d5736430d040a590',
  'なかにしよグループ': 'Cb3bc41ff3a128369d5736430d040a590',
  'グループ': 'Cb3bc41ff3a128369d5736430d040a590',
};

// ARIA API (on same VPS, port 8000)
const ARIA_API_URL = 'http://127.0.0.1:8000';
const ARIA_API_TOKEN = process.env.ARIA_API_TOKEN || 'aria-mobile-2026';

// LINE middleware for signature validation
app.use(
  middleware({
    channelAccessToken,
    channelSecret,
  })
);

app.post('/webhook', (req, res) => {
  const events = req.body.events;
  console.log(`Received ${events.length} events`);

  // Respond immediately so LINE doesn't timeout and retry
  res.json({ success: true });

  // Process events asynchronously
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

// Get source ID (group ID or user ID)
function getSourceId(source) {
  if (source.type === 'group') return source.groupId;
  if (source.type === 'room') return source.roomId;
  return source.userId;
}

// Save a message to Supabase
async function saveMessage(sourceId, sourceType, role, message) {
  const { error } = await supabase.from('line_conversations').insert({
    source_id: sourceId,
    source_type: sourceType,
    role,
    message,
  });
  if (error) {
    console.error('Supabase insert error:', error.message);
  }
}

// Get conversation history from Supabase
async function getHistory(sourceId) {
  const { data, error } = await supabase
    .from('line_conversations')
    .select('role, message')
    .eq('source_id', sourceId)
    .order('created_at', { ascending: false })
    .limit(HISTORY_LIMIT);

  if (error) {
    console.error('Supabase select error:', error.message);
    return [];
  }

  // Return in chronological order
  return (data || []).reverse();
}

// Call ARIA conversation API (primary)
async function callAriaChat(userMessage) {
  try {
    const res = await axios.post(
      `${ARIA_API_URL}/chat`,
      { message: userMessage, context: '必ず日本語で回答してください。' },
      {
        headers: {
          'Content-Type': 'application/json',
          'ARIA-TOKEN': ARIA_API_TOKEN,
        },
        timeout: 30000,
      }
    );
    const reply = res.data?.reply?.trim();
    if (reply) {
      console.log(`ARIA chat OK (${reply.length} chars)`);
      return reply;
    }
  } catch (err) {
    console.error('ARIA chat error:', err.message);
  }
  return null;
}

// Gemini fallback
async function callGemini(userMessage, history, systemPrompt = null) {
  systemPrompt = systemPrompt || `あなたは親切で有用なアシスタントです。自然な関西弁（軽め）で簡潔に回答してください。ネイティブの関西人が普段使う程度のニュアンスで、語尾に「〜やな」「〜やで」「〜やん」などを自然に混ぜる程度にしてください。強調しすぎないようにしてください。`;

  // Build proper Gemini chat history (role must be 'user' or 'model')
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
          config: {
            systemInstruction: systemPrompt,
            temperature: 0.7,
            maxOutputTokens: 1024,
          },
          history: chatHistory,
        });
        const response = await chat.sendMessage({ message: userMessage });
        const text = response.text?.trim();
        if (text) {
          console.log(`Gemini OK (attempt ${attempt + 1}, ${text.length} chars)`);
          return text;
        }
      } catch (err) {
        const errStr = String(err);
        if (errStr.includes('503') || errStr.includes('UNAVAILABLE')) {
          console.log(`Attempt ${attempt + 1}/${MAX_RETRIES}: 503, retrying in ${RETRY_DELAY_MS}ms...`);
          await sleep(RETRY_DELAY_MS);
          break;
        }
        if (errStr.includes('quota') || errStr.includes('429')) {
          console.log(`Key quota exhausted, trying next key...`);
          continue;
        }
        console.error('Gemini error:', err.message);
        return null;
      }
    }
  }
  return null;
}

async function pushLine(to, text) {
  await axios.post(
    'https://api.line.me/v2/bot/message/push',
    { to, messages: [{ type: 'text', text }] },
    {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${channelAccessToken}`,
      },
    }
  );
  console.log(`Push sent to ${to}`);
}

// Resolve LINE user ID → { id, line_command_enabled } (auto-creates if not registered)
async function getAriaUser(lineUserId) {
  const { data: existing } = await supabase
    .from('users')
    .select('id, line_command_enabled')
    .eq('line_user_id', lineUserId)
    .single();

  if (existing) return existing;

  // Auto-create new user (command disabled by default)
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

  if (error) {
    console.error('Failed to auto-create user:', error.message);
    return null;
  }

  console.log(`Auto-created ARIA user ${created.id} for LINE ID ${lineUserId}`);
  return created;
}

// Secretary conversation for non-linked users
async function handleSecretaryChat(replyToken, userMessage) {
  const secretaryPrompt = `あなたはYoshikiの個人秘書「ARIA」です。以下を厳守してください。

【口調・品位】
- 丁寧で落ち着いた日本語で話す。関西弁は使わない
- Yoshikiの品位・評判を傷つけるような発言は絶対にしない
- 曖昧・軽率な返答を避け、誠実かつプロフェッショナルに対応する

【対応方針】
- 食事・飲み会・ディナーなどの誘いは「Yoshikiのスケジュールを確認の上、折り返しご連絡いたします」と伝え、日時・場所の詳細を確認する
- 日時が決まった場合はスケジュールに登録し、確認済みと伝える
- 伝言・要件は「Yoshikiにお伝えいたします」と答える
- 答えられない・判断できない場合は「Yoshikiに確認してご連絡いたします」と伝える`;

  // ARIA /chat has full scheduling capability
  const reply = await callAriaChat(userMessage)
    || await callGemini(userMessage, [], secretaryPrompt);
  await replyLine(replyToken, reply || 'ただいま対応できません。');
}

// Handle commands from linked users' DM
async function handleCommand(replyToken, lineUserId, userMessage) {
  const ariaUser = await getAriaUser(lineUserId);

  // Not linked → secretary mode
  if (!ariaUser || !ariaUser.line_command_enabled) {
    return handleSecretaryChat(replyToken, userMessage);
  }

  const ariaUserId = ariaUser.id;
  console.log(`[Command] ariaUserId=${ariaUserId} message="${userMessage}"`);

  // ── LINEメッセージ送信だけ特殊処理（ARIAには届かない操作） ──
  const sendMatch = userMessage.match(/(.+?)(?:に(?:メッセージを)?送って)[：: ]\s*(.+)/s);
  if (sendMatch) {
    const targetName = sendMatch[1].trim().toLowerCase();
    const messageToSend = sendMatch[2].trim();
    const entry = Object.entries(CONTACTS).find(([name]) =>
      targetName.includes(name) || name.includes(targetName)
    );
    if (entry) {
      await pushLine(entry[1], messageToSend);
      await replyLine(replyToken, `${entry[0]}に送ったで！`);
    } else {
      const available = Object.keys(CONTACTS).join(', ');
      await replyLine(replyToken, `「${targetName}」が見つからへんかった。登録済み: ${available}`);
    }
    return;
  }

  // ── それ以外は全部ARIAに任せる ──
  const ariaReply = await callAriaChat(userMessage);
  if (ariaReply) {
    await replyLine(replyToken, ariaReply);
  } else {
    const history = await getHistory(ariaUserId.toString());
    const geminiReply = await callGemini(userMessage, history);
    await replyLine(replyToken, geminiReply || 'ただいま応答できません。');
  }
}

async function replyLine(replyToken, text) {
  await axios.post(
    'https://api.line.me/v2/bot/message/reply',
    {
      replyToken,
      messages: [{ type: 'text', text }],
    },
    {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${channelAccessToken}`,
      },
    }
  );
  console.log('Reply sent');
}

async function handleTextMessage(event) {
  const { replyToken, message, source } = event;
  const userId = source.userId;
  const sourceId = getSourceId(source);
  const userMessage = message.text;

  console.log(`[${sourceId}] User: ${userMessage}`);

  // If message is a DM (not group), check if it's a registered command user
  if (source.type === 'user') {
    console.log('[Command mode] DM detected');
    return handleCommand(replyToken, userId, userMessage);
  }

  // Save user message
  await saveMessage(sourceId, source.type, 'user', userMessage);

  // Try ARIA chat first, fall back to Gemini
  let aiResponse = await callAriaChat(userMessage);
  if (!aiResponse) {
    const history = await getHistory(sourceId);
    aiResponse = await callGemini(userMessage, history);
  }

  if (aiResponse) {
    await replyLine(replyToken, aiResponse);
    await saveMessage(sourceId, source.type, 'assistant', aiResponse);
    console.log(`[${sourceId}] AI: ${aiResponse}`);
  } else {
    await replyLine(replyToken, 'AIが応答できませんでした。もう一度試してください。');
  }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Webhook server running on port ${PORT} (model: ${GEMINI_MODEL}, retries: ${MAX_RETRIES})`);
});
