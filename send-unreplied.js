// Replay script: sends AI responses to users whose original message never got a proper reply.
//
// Usage:
//   node send-unreplied.js               # process ./data/unreplied.jsonl
//   node send-unreplied.js --dry-run     # show what would be sent, don't call LINE
//   node send-unreplied.js --file=x.jsonl
//
// Reads unreplied.jsonl, re-invokes Gemini (unless aiResponse is already present),
// pushes the result via LINE push API, and moves successfully-sent entries to sent.jsonl.
// Failed entries stay in unreplied.jsonl for the next run.

import { GoogleGenAI } from '@google/genai';
import axios from 'axios';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';

dotenv.config();

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const fileArg = args.find((a) => a.startsWith('--file='));
const DATA_DIR = process.env.DATA_DIR || './data';
const UNREPLIED_FILE = fileArg ? fileArg.slice('--file='.length) : path.join(DATA_DIR, 'unreplied.jsonl');
const SENT_FILE = path.join(DATA_DIR, 'sent.jsonl');

const channelAccessToken = process.env.CHANNEL_ACCESS_TOKEN;
const GEMINI_KEYS = [
  process.env.GEMINI_API_KEY,
  ...process.env.GEMINI_API_KEYS_EXTRA?.split(',').filter(Boolean) || [],
];
const GEMINI_MODEL = 'gemini-2.5-flash';
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 2000;

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
          config: { systemInstruction: systemPrompt, temperature: 0.7, maxOutputTokens: 1024 },
        });
        const response = await chat.sendMessage({ message: userMessage });
        const text = response.text?.trim();
        if (text) return text;
      } catch (err) {
        const errStr = String(err);
        if (errStr.includes('503') || errStr.includes('UNAVAILABLE')) {
          await sleep(RETRY_DELAY_MS);
          break;
        }
        if (errStr.includes('quota') || errStr.includes('429')) continue;
        console.error('Gemini error:', err.message);
        return null;
      }
    }
  }
  return null;
}

async function pushLine(userId, text) {
  await axios.post(
    'https://api.line.me/v2/bot/message/push',
    { to: userId, messages: [{ type: 'text', text }] },
    {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${channelAccessToken}`,
      },
    }
  );
}

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        console.warn('Skipping malformed line:', line.slice(0, 120));
        return null;
      }
    })
    .filter(Boolean);
}

function writeJsonl(file, entries) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, entries.map((e) => JSON.stringify(e)).join('\n') + (entries.length ? '\n' : ''));
}

function appendJsonl(file, entry) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(entry) + '\n');
}

async function main() {
  if (!channelAccessToken) {
    console.error('CHANNEL_ACCESS_TOKEN not set. Aborting.');
    process.exit(1);
  }

  const entries = readJsonl(UNREPLIED_FILE);
  if (entries.length === 0) {
    console.log(`No entries in ${UNREPLIED_FILE}. Nothing to do.`);
    return;
  }
  console.log(`Found ${entries.length} unreplied entries in ${UNREPLIED_FILE}.${DRY_RUN ? ' (DRY RUN)' : ''}`);

  const remaining = [];
  let sentCount = 0;

  for (const entry of entries) {
    const { userId, userMessage, aiResponse } = entry;
    if (!userId || !userMessage) {
      console.warn('Skipping entry with missing userId/userMessage:', entry);
      remaining.push(entry);
      continue;
    }

    // Use cached response if we already had one (reply_failed case), else regenerate.
    let responseText = aiResponse;
    if (!responseText) {
      console.log(`[${userId}] Regenerating response for: ${userMessage.slice(0, 60)}`);
      responseText = await callGemini(userMessage);
      if (!responseText) {
        console.warn(`[${userId}] Gemini still failing — keeping entry for next run.`);
        remaining.push(entry);
        continue;
      }
    }

    // Prefix so the user knows this is a delayed reply.
    const prefixed = `[遅延応答] ${responseText}`;

    if (DRY_RUN) {
      console.log(`[DRY] would push to ${userId}: ${prefixed.slice(0, 120)}`);
      remaining.push(entry);
      continue;
    }

    try {
      await pushLine(userId, prefixed);
      console.log(`[${userId}] Push sent (${prefixed.length} chars)`);
      appendJsonl(SENT_FILE, { ...entry, sentAt: new Date().toISOString(), aiResponse: responseText });
      sentCount++;
    } catch (err) {
      const status = err.response?.status;
      const body = err.response?.data;
      console.error(`[${userId}] Push failed (status=${status}):`, body || err.message);
      remaining.push(entry);
    }
  }

  if (!DRY_RUN) {
    writeJsonl(UNREPLIED_FILE, remaining);
  }
  console.log(`Done. Sent: ${sentCount}, remaining: ${remaining.length}`);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
