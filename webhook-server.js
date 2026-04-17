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

  Promise.all(
    events.map((event) => {
      console.log('Event:', JSON.stringify(event.source, null, 2));
      if (event.type === 'message' && event.message.type === 'text') {
        return handleTextMessage(event);
      }
      return Promise.resolve();
    })
  )
    .then(() => res.json({ success: true }))
    .catch((err) => {
      console.error('Error:', err.message);
      res.status(500).send('Internal Server Error');
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

async function callGemini(userMessage, history) {
  const systemPrompt = `あなたは親切で有用なアシスタントです。日本語で簡潔に回答してください。`;

  // Build history string for context
  let contextText = '';
  if (history.length > 0) {
    contextText = '\n\n過去の会話履歴:\n';
    for (const h of history) {
      const label = h.role === 'user' ? 'ユーザー' : 'アシスタント';
      contextText += `${label}: ${h.message}\n`;
    }
    contextText += '\n上記の履歴を踏まえて回答してください。';
  }

  const fullMessage = userMessage + contextText;

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
        });
        const response = await chat.sendMessage({ message: fullMessage });
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

  // Get conversation history
  const history = await getHistory(sourceId);

  // Save user message
  await saveMessage(sourceId, source.type, 'user', userMessage);

  // Call Gemini with history context
  const geminiResponse = await callGemini(userMessage, history);

  if (geminiResponse) {
    await replyLine(replyToken, geminiResponse);
    // Save assistant response
    await saveMessage(sourceId, source.type, 'assistant', geminiResponse);
    console.log(`[${sourceId}] Gemini: ${geminiResponse}`);
  } else {
    await replyLine(replyToken, 'AIが応答できませんでした。もう一度試してください。');
  }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Webhook server running on port ${PORT} (model: ${GEMINI_MODEL}, retries: ${MAX_RETRIES})`);
});
