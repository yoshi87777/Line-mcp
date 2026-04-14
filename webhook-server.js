import express from 'express';
import { middleware } from '@line/bot-sdk';
import { GoogleGenAI } from '@google/genai';
import axios from 'axios';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';

dotenv.config();

const app = express();

const channelAccessToken = process.env.CHANNEL_ACCESS_TOKEN;
const channelSecret = process.env.CHANNEL_SECRET;

// Gemini keys rotation (same approach as ARIA)
const GEMINI_KEYS = [
  process.env.GEMINI_API_KEY,
  ...process.env.GEMINI_API_KEYS_EXTRA?.split(',').filter(Boolean) || [],
];
const GEMINI_MODEL = 'gemini-2.5-flash';
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 2000;

// Persist unreplied messages so they can be pushed later via send-unreplied.js.
// Render free/starter tier has ephemeral FS, so we ALSO emit a structured log line
// `[UNREPLIED] {json}` that can be recovered from Render log exports via parse-render-logs.js.
const DATA_DIR = process.env.DATA_DIR || './data';
const UNREPLIED_FILE = path.join(DATA_DIR, 'unreplied.jsonl');

function recordUnreplied(entry) {
  const record = { timestamp: new Date().toISOString(), ...entry };
  // Structured log line — always emitted, survives FS wipes on Render.
  console.log(`[UNREPLIED] ${JSON.stringify(record)}`);
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.appendFileSync(UNREPLIED_FILE, JSON.stringify(record) + '\n');
  } catch (err) {
    console.error('Failed to write unreplied record to disk:', err.message);
  }
}

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
      console.log('Event type:', event.type, event.message?.type);
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

async function callGemini(userMessage) {
  const systemPrompt = `あなたは親切で有用なアシスタントです。日本語で簡潔に回答してください。`;

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
  const { replyToken, message } = event;
  const userId = event.source.userId;
  const userMessage = message.text;

  console.log(`[${userId}] User: ${userMessage}`);

  const geminiResponse = await callGemini(userMessage);

  if (geminiResponse) {
    try {
      await replyLine(replyToken, geminiResponse);
      console.log(`[${userId}] Gemini: ${geminiResponse}`);
    } catch (err) {
      // Reply failed (e.g. replyToken expired, network) — record so we can push later.
      recordUnreplied({
        userId,
        userMessage,
        reason: 'reply_failed',
        error: err.message,
        aiResponse: geminiResponse,
      });
    }
  } else {
    // Gemini produced no response — record the original user message so we can retry later.
    recordUnreplied({
      userId,
      userMessage,
      reason: 'gemini_failed',
    });
    try {
      await replyLine(replyToken, 'AIが応答できませんでした。もう一度試してください。');
    } catch (err) {
      console.error('Fallback reply also failed:', err.message);
    }
  }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Webhook server running on port ${PORT} (model: ${GEMINI_MODEL}, retries: ${MAX_RETRIES})`);
});
