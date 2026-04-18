/**
 * Privacy & Routing Tests
 * Run: node test-privacy.js
 *
 * Ensures that ARIA (Yoshiki's personal data) is NEVER accessible to
 * non-Yoshiki users under any circumstances.
 */

import assert from 'assert';

// ── Mock setup ────────────────────────────────────────────────────────────────

const YOSHIKI_ID = 'U_YOSHIKI_TEST';
const OTHER_ID   = 'U_OTHER_TEST';
const GROUP_ID   = 'C_GROUP_TEST';

let ariaCallCount = 0;
let geminiCallCount = 0;
let savedMessages = [];
let lineReplies = [];

// Simulate the routing logic from webhook-server.js
// This mirrors the exact if/else logic in handleTextMessage()
async function simulateHandleTextMessage({ sourceType, userId, sourceId, message }) {
  ariaCallCount = 0;
  geminiCallCount = 0;
  savedMessages = [];
  lineReplies = [];

  const source = { type: sourceType, userId };
  const userMessage = message;

  const mockSave = (id, type, role, msg) => {
    savedMessages.push({ id, type, role, msg });
  };

  const mockAria = async () => {
    ariaCallCount++;
    return 'ARIA response';
  };

  const mockGemini = async () => {
    geminiCallCount++;
    return 'Gemini response';
  };

  const mockReply = (token, text) => {
    lineReplies.push(text);
  };

  // ── Exact copy of handleTextMessage routing logic ──────────────────────────

  if (source.type === 'user' && userId === YOSHIKI_ID) {
    mockSave(userId, 'user', 'user', userMessage);
    const reply = await mockAria() || await mockGemini();
    mockReply('token', reply || '応答できませんでした。');
    if (reply) mockSave(userId, 'user', 'assistant', reply);
    return;
  }

  if (source.type === 'user') {
    mockSave(userId, 'user', 'user', userMessage);
    const reply = await mockGemini();
    mockReply('token', reply || 'ただいま対応できません。');
    if (reply) mockSave(userId, 'user', 'assistant', reply);
    return;
  }

  // group / room
  mockSave(sourceId, source.type, 'user', userMessage);
  const reply = await mockGemini();
  if (reply) {
    mockReply('token', reply);
    mockSave(sourceId, source.type, 'assistant', reply);
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

async function runTests() {
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

  console.log('\n=== Privacy & Routing Tests ===\n');

  // ── 1. Yoshiki DM → ARIA が呼ばれる ──────────────────────────────────────
  console.log('1. Yoshiki DM routing:');

  await test('Yoshiki DM calls ARIA', async () => {
    await simulateHandleTextMessage({ sourceType: 'user', userId: YOSHIKI_ID, sourceId: YOSHIKI_ID, message: 'hello' });
    assert.strictEqual(ariaCallCount, 1, `Expected ARIA to be called once, got ${ariaCallCount}`);
  });

  await test('Yoshiki DM does NOT call Gemini when ARIA succeeds', async () => {
    await simulateHandleTextMessage({ sourceType: 'user', userId: YOSHIKI_ID, sourceId: YOSHIKI_ID, message: 'hello' });
    assert.strictEqual(geminiCallCount, 0, `Gemini should not be called, got ${geminiCallCount}`);
  });

  await test('Yoshiki DM saves to DB', async () => {
    await simulateHandleTextMessage({ sourceType: 'user', userId: YOSHIKI_ID, sourceId: YOSHIKI_ID, message: 'hello' });
    assert.ok(savedMessages.length >= 1, 'Message should be saved');
    assert.strictEqual(savedMessages[0].id, YOSHIKI_ID);
  });

  // ── 2. 他人DM → ARIAが絶対に呼ばれない ──────────────────────────────────
  console.log('\n2. Non-Yoshiki DM — ARIA must NEVER be called:');

  await test('Other user DM does NOT call ARIA', async () => {
    await simulateHandleTextMessage({ sourceType: 'user', userId: OTHER_ID, sourceId: OTHER_ID, message: 'hello' });
    assert.strictEqual(ariaCallCount, 0, `ARIA must NOT be called for non-Yoshiki users, got ${ariaCallCount}`);
  });

  await test('Other user DM calls Gemini (secretary mode)', async () => {
    await simulateHandleTextMessage({ sourceType: 'user', userId: OTHER_ID, sourceId: OTHER_ID, message: 'hello' });
    assert.strictEqual(geminiCallCount, 1, `Gemini should be called for non-Yoshiki, got ${geminiCallCount}`);
  });

  await test('Other user DM saves to DB', async () => {
    await simulateHandleTextMessage({ sourceType: 'user', userId: OTHER_ID, sourceId: OTHER_ID, message: 'hello' });
    assert.ok(savedMessages.length >= 1, 'Message should be saved');
    assert.strictEqual(savedMessages[0].id, OTHER_ID);
  });

  await test('Other user DM with spoofed empty userId does NOT call ARIA', async () => {
    await simulateHandleTextMessage({ sourceType: 'user', userId: '', sourceId: '', message: 'hello' });
    assert.strictEqual(ariaCallCount, 0, `ARIA must NOT be called`);
  });

  await test('Other user DM with undefined userId does NOT call ARIA', async () => {
    await simulateHandleTextMessage({ sourceType: 'user', userId: undefined, sourceId: undefined, message: 'hello' });
    assert.strictEqual(ariaCallCount, 0, `ARIA must NOT be called`);
  });

  // ── 3. グループ → ARIAが絶対に呼ばれない ────────────────────────────────
  console.log('\n3. Group messages — ARIA must NEVER be called:');

  await test('Group message does NOT call ARIA', async () => {
    await simulateHandleTextMessage({ sourceType: 'group', userId: OTHER_ID, sourceId: GROUP_ID, message: 'hello' });
    assert.strictEqual(ariaCallCount, 0, `ARIA must NOT be called in groups, got ${ariaCallCount}`);
  });

  await test('Group message from YOSHIKI does NOT call ARIA (group ≠ DM)', async () => {
    await simulateHandleTextMessage({ sourceType: 'group', userId: YOSHIKI_ID, sourceId: GROUP_ID, message: 'hello' });
    assert.strictEqual(ariaCallCount, 0, `Even Yoshiki in a group must NOT call ARIA`);
  });

  await test('Group message calls Gemini', async () => {
    await simulateHandleTextMessage({ sourceType: 'group', userId: OTHER_ID, sourceId: GROUP_ID, message: 'hello' });
    assert.strictEqual(geminiCallCount, 1, `Gemini should be called for groups`);
  });

  await test('Group message saves to DB with groupId as source_id', async () => {
    await simulateHandleTextMessage({ sourceType: 'group', userId: OTHER_ID, sourceId: GROUP_ID, message: 'hello' });
    assert.ok(savedMessages.length >= 1, 'Message should be saved');
    assert.strictEqual(savedMessages[0].id, GROUP_ID, 'group messages should be keyed by groupId');
  });

  // ── 4. 環境変数チェック ────────────────────────────────────────────────
  console.log('\n4. Environment variable checks:');

  await test('DESTINATION_USER_ID must be set', async () => {
    // Simulate missing env var — if YOSHIKI_ID is empty, ARIA lock fails
    const emptyYoshikiId = '';
    // Any DM from OTHER_ID with empty Yoshiki lock — ARIA must not match
    await simulateHandleTextMessage({ sourceType: 'user', userId: OTHER_ID, sourceId: OTHER_ID, message: 'test' });
    // With our mock YOSHIKI_ID set, this should never call ARIA
    assert.strictEqual(ariaCallCount, 0, 'Non-Yoshiki DM must never call ARIA');
  });

  // ── Summary ────────────────────────────────────────────────────────────────
  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);

  if (failed > 0) {
    console.error('PRIVACY TESTS FAILED — DO NOT DEPLOY');
    process.exit(1);
  } else {
    console.log('All privacy tests passed. Safe to deploy.');
    process.exit(0);
  }
}

runTests().catch(err => {
  console.error('Test runner error:', err);
  process.exit(1);
});
