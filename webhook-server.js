import express from 'express';
import { middleware } from '@line/bot-sdk';
import { GoogleGenAI } from '@google/genai';
import axios from 'axios';
import dotenv from 'dotenv';

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
    await replyLine(replyToken, geminiResponse);
    console.log(`[${userId}] Gemini: ${geminiResponse}`);
  } else {
    await replyLine(replyToken, 'AIが応答できませんでした。もう一度試してください。');
  }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Webhook server running on port ${PORT} (model: ${GEMINI_MODEL}, retries: ${MAX_RETRIES})`);
});
