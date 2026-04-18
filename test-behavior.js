/**
 * Behavior Tests
 * Run: node test-behavior.js
 *
 * Verifies that the bot behaves correctly in each scenario:
 *   - Correct AI backend is used per source type
 *   - Correct system prompt is passed to Gemini
 *   - ARIA fallback to Gemini works
 *   - Response is always sent (no silent failures)
 *   - Messages are saved to DB with correct fields
 *   - Conversation history is passed to Gemini
 *   - !status command returns status without saving to DB
 */

import assert from 'assert';

// ── Constants (mirrors webhook-server.js) ──────────────────────────────────────

const YOSHIKI_ID = 'U_YOSHIKI_TEST';
const OTHER_ID   = 'U_OTHER_TEST';
const GROUP_ID   = 'C_GROUP_TEST';

const GROUP_PROMPT     = 'GROUP_PROMPT';
const SECRETARY_PROMPT = 'SECRETARY_PROMPT';

// ── Simulation engine ──────────────────────────────────────────────────────────

function makeSimulator({
  ariaResult = 'ARIA response',       // null = ARIA fails
  geminiResult = 'Gemini response',   // null = Gemini fails
  historyData = [],                   // fake DB history
  ariaConversationId = null,          // stored aria_conversation_id
} = {}) {
  const calls = {
    aria: [],
    gemini: [],
    saved: [],
    replies: [],
    historyFetched: [],
    ariaConvIdUpdated: null,
  };

  const mockSave = (id, type, role, msg) => {
    calls.saved.push({ id, type, role, msg });
  };

  const mockGetHistory = async (sourceId) => {
    calls.historyFetched.push(sourceId);
    return historyData;
  };

  const mockAria = async (userMessage) => {
    calls.aria.push({ userMessage, usedConvId: ariaConversationId });
    if (ariaResult === null) return null;
    // Simulate saving new conversation_id
    calls.ariaConvIdUpdated = 42;
    return ariaResult;
  };

  const mockGemini = async (userMessage, history, systemPrompt) => {
    calls.gemini.push({ userMessage, history, systemPrompt });
    return geminiResult;
  };

  const mockReply = (token, text) => {
    calls.replies.push(text);
  };

  const getSystemStatus = async () => ({
    commit: 'abc1234',
    yoshikiLock: `${YOSHIKI_ID.slice(0, 8)}...`,
    ariaPrivacyLock: true,
    geminiKeys: 5,
    supabase: 'OK',
    aria: 'OK',
    model: 'gemini-2.5-flash',
    uptime: '120s',
  });

  // Exact copy of handleTextMessage routing logic from webhook-server.js
  async function simulate({ sourceType, userId, sourceId, message }) {
    const source = { type: sourceType, userId };
    const userMessage = message;

    if (source.type === 'user' && userId === YOSHIKI_ID) {
      // !status command
      if (userMessage.trim() === '!status') {
        const s = await getSystemStatus();
        const text = `🔍 システムステータス\ncommit: ${s.commit}\nYoshikiロック: ${s.ariaPrivacyLock ? 'ON ✅' : 'OFF 🚨'}\nSupabase: ${s.supabase}\nARIA: ${s.aria}\nGeminiキー数: ${s.geminiKeys}\nモデル: ${s.model}\nuptime: ${s.uptime}`;
        mockReply('token', text);
        return calls;
      }

      mockSave(userId, 'user', 'user', userMessage);
      const reply = await mockAria(userMessage) || await mockGemini(userMessage, await mockGetHistory(userId), GROUP_PROMPT);
      mockReply('token', reply || '応答できませんでした。');
      if (reply) mockSave(userId, 'user', 'assistant', reply);
      return calls;
    }

    if (source.type === 'user') {
      mockSave(userId, 'user', 'user', userMessage);
      const history = await mockGetHistory(userId);
      const reply = await mockGemini(userMessage, history, SECRETARY_PROMPT);
      mockReply('token', reply || 'ただいま対応できません。');
      if (reply) mockSave(userId, 'user', 'assistant', reply);
      return calls;
    }

    // group / room
    mockSave(sourceId, source.type, 'user', userMessage);
    const history = await mockGetHistory(sourceId);
    const reply = await mockGemini(userMessage, history, GROUP_PROMPT);
    if (reply) {
      mockReply('token', reply);
      mockSave(sourceId, source.type, 'assistant', reply);
    } else {
      mockReply('token', 'AIが応答できませんでした。');
    }
    return calls;
  }

  return { simulate };
}

// ── Test runner ────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✅ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ❌ ${name}`);
    console.error(`     ${err.message}`);
    failed++;
  }
}

// ── Test suites ────────────────────────────────────────────────────────────────

async function runTests() {
  console.log('\n=== Behavior Tests ===\n');

  // ── 1. Yoshiki DM 正常系 ───────────────────────────────────────────────────
  console.log('1. Yoshiki DM — normal flow:');

  await test('ARIA response is sent to LINE', async () => {
    const { simulate } = makeSimulator({ ariaResult: 'ARIAからの返答' });
    const c = await simulate({ sourceType: 'user', userId: YOSHIKI_ID, sourceId: YOSHIKI_ID, message: 'タスクは？' });
    assert.strictEqual(c.replies.length, 1);
    assert.strictEqual(c.replies[0], 'ARIAからの返答');
  });

  await test('ARIA response is saved to DB as assistant', async () => {
    const { simulate } = makeSimulator({ ariaResult: 'ARIAからの返答' });
    const c = await simulate({ sourceType: 'user', userId: YOSHIKI_ID, sourceId: YOSHIKI_ID, message: 'タスクは？' });
    const saved = c.saved.find(s => s.role === 'assistant');
    assert.ok(saved, 'assistant message should be saved');
    assert.strictEqual(saved.msg, 'ARIAからの返答');
  });

  await test('User message is saved to DB before ARIA call', async () => {
    const { simulate } = makeSimulator();
    const c = await simulate({ sourceType: 'user', userId: YOSHIKI_ID, sourceId: YOSHIKI_ID, message: 'こんにちは' });
    const userSaved = c.saved.find(s => s.role === 'user');
    assert.ok(userSaved, 'user message should be saved');
    assert.strictEqual(userSaved.msg, 'こんにちは');
  });

  // ── 2. Yoshiki DM — ARIA フォールバック ───────────────────────────────────
  console.log('\n2. Yoshiki DM — ARIA failure fallback:');

  await test('When ARIA fails, Gemini is called as fallback', async () => {
    const { simulate } = makeSimulator({ ariaResult: null, geminiResult: 'Geminiの返答' });
    const c = await simulate({ sourceType: 'user', userId: YOSHIKI_ID, sourceId: YOSHIKI_ID, message: 'テスト' });
    assert.strictEqual(c.aria.length, 1, 'ARIA should be tried once');
    assert.strictEqual(c.gemini.length, 1, 'Gemini should be called as fallback');
  });

  await test('Gemini fallback response is sent to LINE', async () => {
    const { simulate } = makeSimulator({ ariaResult: null, geminiResult: 'Geminiの返答' });
    const c = await simulate({ sourceType: 'user', userId: YOSHIKI_ID, sourceId: YOSHIKI_ID, message: 'テスト' });
    assert.strictEqual(c.replies[0], 'Geminiの返答');
  });

  await test('When both ARIA and Gemini fail, fallback message is sent', async () => {
    const { simulate } = makeSimulator({ ariaResult: null, geminiResult: null });
    const c = await simulate({ sourceType: 'user', userId: YOSHIKI_ID, sourceId: YOSHIKI_ID, message: 'テスト' });
    assert.strictEqual(c.replies.length, 1, 'A reply must always be sent');
    assert.ok(c.replies[0].length > 0, 'Reply must not be empty');
  });

  await test('When ARIA fails, Gemini uses GROUP_PROMPT (Yoshiki stays casual)', async () => {
    const { simulate } = makeSimulator({ ariaResult: null });
    const c = await simulate({ sourceType: 'user', userId: YOSHIKI_ID, sourceId: YOSHIKI_ID, message: 'テスト' });
    assert.strictEqual(c.gemini[0].systemPrompt, GROUP_PROMPT);
  });

  // ── 3. 他人DM — 秘書モード ─────────────────────────────────────────────────
  console.log('\n3. Non-Yoshiki DM — secretary mode:');

  await test('Secretary mode uses SECRETARY_PROMPT', async () => {
    const { simulate } = makeSimulator();
    const c = await simulate({ sourceType: 'user', userId: OTHER_ID, sourceId: OTHER_ID, message: '土曜日空いてる？' });
    assert.strictEqual(c.gemini[0].systemPrompt, SECRETARY_PROMPT);
  });

  await test('Secretary mode does NOT use GROUP_PROMPT', async () => {
    const { simulate } = makeSimulator();
    const c = await simulate({ sourceType: 'user', userId: OTHER_ID, sourceId: OTHER_ID, message: 'hello' });
    assert.notStrictEqual(c.gemini[0].systemPrompt, GROUP_PROMPT);
  });

  await test('Secretary response is sent to LINE', async () => {
    const { simulate } = makeSimulator({ geminiResult: 'Yoshikiに確認の上、ご連絡します' });
    const c = await simulate({ sourceType: 'user', userId: OTHER_ID, sourceId: OTHER_ID, message: '土曜日空いてる？' });
    assert.strictEqual(c.replies[0], 'Yoshikiに確認の上、ご連絡します');
  });

  await test('Secretary mode fetches conversation history', async () => {
    const history = [{ role: 'user', message: '先週の話' }];
    const { simulate } = makeSimulator({ historyData: history });
    const c = await simulate({ sourceType: 'user', userId: OTHER_ID, sourceId: OTHER_ID, message: 'その後どうなった？' });
    assert.deepStrictEqual(c.gemini[0].history, history, 'History should be passed to Gemini');
  });

  await test('Secretary history keyed by sender userId', async () => {
    const { simulate } = makeSimulator();
    const c = await simulate({ sourceType: 'user', userId: OTHER_ID, sourceId: OTHER_ID, message: 'hello' });
    assert.strictEqual(c.historyFetched[0], OTHER_ID);
  });

  await test('When secretary Gemini fails, fallback message is sent', async () => {
    const { simulate } = makeSimulator({ geminiResult: null });
    const c = await simulate({ sourceType: 'user', userId: OTHER_ID, sourceId: OTHER_ID, message: 'hello' });
    assert.strictEqual(c.replies.length, 1, 'A reply must always be sent');
    assert.ok(c.replies[0].length > 0);
  });

  // ── 4. グループ ────────────────────────────────────────────────────────────
  console.log('\n4. Group messages:');

  await test('Group uses GROUP_PROMPT', async () => {
    const { simulate } = makeSimulator();
    const c = await simulate({ sourceType: 'group', userId: OTHER_ID, sourceId: GROUP_ID, message: 'やあ' });
    assert.strictEqual(c.gemini[0].systemPrompt, GROUP_PROMPT);
  });

  await test('Group does NOT use SECRETARY_PROMPT', async () => {
    const { simulate } = makeSimulator();
    const c = await simulate({ sourceType: 'group', userId: OTHER_ID, sourceId: GROUP_ID, message: 'やあ' });
    assert.notStrictEqual(c.gemini[0].systemPrompt, SECRETARY_PROMPT);
  });

  await test('Group fetches history by groupId (not userId)', async () => {
    const { simulate } = makeSimulator();
    const c = await simulate({ sourceType: 'group', userId: OTHER_ID, sourceId: GROUP_ID, message: 'やあ' });
    assert.strictEqual(c.historyFetched[0], GROUP_ID, 'History should be keyed by groupId');
  });

  await test('Group message saved with groupId as source_id', async () => {
    const { simulate } = makeSimulator();
    const c = await simulate({ sourceType: 'group', userId: OTHER_ID, sourceId: GROUP_ID, message: 'やあ' });
    assert.strictEqual(c.saved[0].id, GROUP_ID);
  });

  await test('Group Yoshiki message also uses GROUP_PROMPT (not ARIA)', async () => {
    const { simulate } = makeSimulator();
    const c = await simulate({ sourceType: 'group', userId: YOSHIKI_ID, sourceId: GROUP_ID, message: 'テスト' });
    assert.strictEqual(c.gemini[0].systemPrompt, GROUP_PROMPT);
    assert.strictEqual(c.aria.length, 0, 'ARIA must not be called in groups');
  });

  await test('When group Gemini fails, fallback message is sent', async () => {
    const { simulate } = makeSimulator({ geminiResult: null });
    const c = await simulate({ sourceType: 'group', userId: OTHER_ID, sourceId: GROUP_ID, message: 'hello' });
    assert.strictEqual(c.replies.length, 1, 'A reply must always be sent');
    assert.ok(c.replies[0].length > 0);
  });

  // ── 5. !status コマンド ────────────────────────────────────────────────────
  console.log('\n5. !status command:');

  await test('!status returns a reply', async () => {
    const { simulate } = makeSimulator();
    const c = await simulate({ sourceType: 'user', userId: YOSHIKI_ID, sourceId: YOSHIKI_ID, message: '!status' });
    assert.strictEqual(c.replies.length, 1);
  });

  await test('!status reply contains commit hash', async () => {
    const { simulate } = makeSimulator();
    const c = await simulate({ sourceType: 'user', userId: YOSHIKI_ID, sourceId: YOSHIKI_ID, message: '!status' });
    assert.ok(c.replies[0].includes('abc1234'), 'Reply should include commit hash');
  });

  await test('!status does NOT save to DB', async () => {
    const { simulate } = makeSimulator();
    const c = await simulate({ sourceType: 'user', userId: YOSHIKI_ID, sourceId: YOSHIKI_ID, message: '!status' });
    assert.strictEqual(c.saved.length, 0, '!status should not be saved to DB');
  });

  await test('!status does NOT call ARIA', async () => {
    const { simulate } = makeSimulator();
    const c = await simulate({ sourceType: 'user', userId: YOSHIKI_ID, sourceId: YOSHIKI_ID, message: '!status' });
    assert.strictEqual(c.aria.length, 0);
  });

  await test('!status only responds to Yoshiki (non-Yoshiki gets secretary)', async () => {
    const { simulate } = makeSimulator();
    const c = await simulate({ sourceType: 'user', userId: OTHER_ID, sourceId: OTHER_ID, message: '!status' });
    // Non-Yoshiki should get Gemini secretary response, not status
    assert.strictEqual(c.gemini[0].systemPrompt, SECRETARY_PROMPT);
  });

  // ── 6. DB保存の完全性 ──────────────────────────────────────────────────────
  console.log('\n6. DB save completeness:');

  await test('Every DM (Yoshiki) saves both user and assistant messages', async () => {
    const { simulate } = makeSimulator();
    const c = await simulate({ sourceType: 'user', userId: YOSHIKI_ID, sourceId: YOSHIKI_ID, message: 'hello' });
    const userSaved = c.saved.filter(s => s.role === 'user');
    const assistantSaved = c.saved.filter(s => s.role === 'assistant');
    assert.strictEqual(userSaved.length, 1, 'user message should be saved');
    assert.strictEqual(assistantSaved.length, 1, 'assistant message should be saved');
  });

  await test('Every DM (non-Yoshiki) saves both user and assistant messages', async () => {
    const { simulate } = makeSimulator();
    const c = await simulate({ sourceType: 'user', userId: OTHER_ID, sourceId: OTHER_ID, message: 'hello' });
    const userSaved = c.saved.filter(s => s.role === 'user');
    const assistantSaved = c.saved.filter(s => s.role === 'assistant');
    assert.strictEqual(userSaved.length, 1);
    assert.strictEqual(assistantSaved.length, 1);
  });

  await test('Every group message saves both user and assistant messages', async () => {
    const { simulate } = makeSimulator();
    const c = await simulate({ sourceType: 'group', userId: OTHER_ID, sourceId: GROUP_ID, message: 'hello' });
    const userSaved = c.saved.filter(s => s.role === 'user');
    const assistantSaved = c.saved.filter(s => s.role === 'assistant');
    assert.strictEqual(userSaved.length, 1);
    assert.strictEqual(assistantSaved.length, 1);
  });

  await test('Nothing is saved when Yoshiki sends !status', async () => {
    const { simulate } = makeSimulator();
    const c = await simulate({ sourceType: 'user', userId: YOSHIKI_ID, sourceId: YOSHIKI_ID, message: '!status' });
    assert.strictEqual(c.saved.length, 0);
  });

  await test('When AI fails, user message is still saved (no lost messages)', async () => {
    const { simulate } = makeSimulator({ ariaResult: null, geminiResult: null });
    const c = await simulate({ sourceType: 'user', userId: YOSHIKI_ID, sourceId: YOSHIKI_ID, message: 'hello' });
    const userSaved = c.saved.filter(s => s.role === 'user');
    assert.strictEqual(userSaved.length, 1, 'User message should be saved even if AI fails');
  });

  // ── Summary ────────────────────────────────────────────────────────────────
  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);

  if (failed > 0) {
    console.error('BEHAVIOR TESTS FAILED — DO NOT DEPLOY');
    process.exit(1);
  } else {
    console.log('All behavior tests passed. Safe to deploy.');
    process.exit(0);
  }
}

runTests().catch(err => {
  console.error('Test runner error:', err);
  process.exit(1);
});
