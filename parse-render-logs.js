// Recovers unreplied entries from a Render log export.
//
// Render's free/starter filesystem is ephemeral, so ./data/unreplied.jsonl is wiped on restart.
// As a fallback, webhook-server.js also emits structured log lines like:
//   [UNREPLIED] {"timestamp":"...","userId":"U...","userMessage":"...","reason":"gemini_failed"}
// Download logs from the Render dashboard, then run:
//   node parse-render-logs.js < render-logs.txt
// This appends recovered entries to ./data/unreplied.jsonl (deduped by timestamp+userId+userMessage).

import fs from 'fs';
import path from 'path';
import readline from 'readline';

const DATA_DIR = process.env.DATA_DIR || './data';
const UNREPLIED_FILE = path.join(DATA_DIR, 'unreplied.jsonl');

function loadExisting() {
  if (!fs.existsSync(UNREPLIED_FILE)) return { entries: [], keys: new Set() };
  const entries = fs
    .readFileSync(UNREPLIED_FILE, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  const keys = new Set(entries.map((e) => `${e.timestamp}|${e.userId}|${e.userMessage}`));
  return { entries, keys };
}

async function main() {
  const { entries: existing, keys } = loadExisting();
  const recovered = [];

  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of rl) {
    const idx = line.indexOf('[UNREPLIED]');
    if (idx === -1) continue;
    const jsonPart = line.slice(idx + '[UNREPLIED]'.length).trim();
    try {
      const record = JSON.parse(jsonPart);
      const key = `${record.timestamp}|${record.userId}|${record.userMessage}`;
      if (keys.has(key)) continue;
      keys.add(key);
      recovered.push(record);
    } catch (err) {
      console.warn('Skipping malformed [UNREPLIED] line:', jsonPart.slice(0, 120));
    }
  }

  if (recovered.length === 0) {
    console.log(`No new entries to recover. Existing: ${existing.length}.`);
    return;
  }

  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.appendFileSync(UNREPLIED_FILE, recovered.map((e) => JSON.stringify(e)).join('\n') + '\n');
  console.log(`Recovered ${recovered.length} new entries. Total now: ${existing.length + recovered.length}.`);
  console.log(`Next: node send-unreplied.js --dry-run   (then run without --dry-run)`);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
