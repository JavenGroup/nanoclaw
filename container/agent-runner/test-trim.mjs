#!/usr/bin/env node
/**
 * Standalone smoke tests for trimSession logic.
 * Tests the JSONL parsing/rewriting without the SDK (generateSummary is stubbed).
 *
 * Run: node container/agent-runner/test-trim.mjs
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import os from 'os';

const RECENT_MESSAGES_KEEP = 20;
const TRIM_MIN_ENTRIES = 30;

let passed = 0;
let failed = 0;

function assert(cond, msg) {
  if (!cond) {
    console.error(`  FAIL: ${msg}`);
    failed++;
  } else {
    console.log(`  PASS: ${msg}`);
    passed++;
  }
}

// ---- Inline the pure trim logic (no SDK dependency) ----

function trimSessionSync(sessionPath, stubSummary) {
  const content = fs.readFileSync(sessionPath, 'utf-8');
  const lines = content.split('\n').filter(l => l.trim());

  const headers = [];
  const conversationEntries = [];

  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      if (obj.type === 'queue-operation') {
        headers.push(line);
      } else {
        conversationEntries.push({ line, parsed: obj });
      }
    } catch {
      headers.push(line);
    }
  }

  if (conversationEntries.length < TRIM_MIN_ENTRIES) {
    return { skipped: true, reason: 'below threshold', entryCount: conversationEntries.length };
  }

  const recent = conversationEntries.slice(-RECENT_MESSAGES_KEEP);
  const older = conversationEntries.slice(0, -RECENT_MESSAGES_KEEP);

  let existingSummary = '';
  const olderForSummary = [];
  for (const entry of older) {
    if (entry.parsed._nanoclaw_summary) {
      existingSummary = entry.parsed.message?.content || '';
    } else {
      olderForSummary.push(entry);
    }
  }

  const droppedText = olderForSummary.map(e => {
    const p = e.parsed;
    const role = p.type === 'user' ? 'User' : 'Assistant';
    const msg = p.message?.content;
    let text = '';
    if (typeof msg === 'string') text = msg;
    else if (Array.isArray(msg)) {
      text = msg.filter(b => b.type === 'text').map(b => b.text || '').join('');
    }
    return `${role}: ${text.slice(0, 500)}`;
  }).filter(t => t.length > 10).join('\n');

  if (!droppedText && !existingSummary) {
    return { skipped: true, reason: 'no content' };
  }

  // Use stub summary instead of calling SDK
  const summaryText = stubSummary || `Stub summary of ${olderForSummary.length} messages. Existing: ${existingSummary.slice(0, 50)}`;

  const fakeUserUuid = crypto.randomUUID();
  const fakeAsstUuid = crypto.randomUUID();
  const now = new Date().toISOString();
  const template = recent[0]?.parsed || {};
  const sessionId = template.sessionId || 'test-session';

  const fakeUser = {
    type: 'user',
    message: { role: 'user', content: `[SESSION CONTEXT — Summarized history of earlier conversation]\n\n${summaryText}` },
    uuid: fakeUserUuid,
    parentUuid: undefined,
    sessionId,
    timestamp: now,
    cwd: template.cwd,
    version: template.version,
    isSidechain: false,
    userType: 'external',
    _nanoclaw_summary: true,
  };

  const fakeAsst = {
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text: 'Context loaded.' }] },
    uuid: fakeAsstUuid,
    parentUuid: fakeUserUuid,
    sessionId,
    timestamp: now,
    cwd: template.cwd,
    version: template.version,
    isSidechain: false,
    userType: 'external',
  };

  const firstRecent = { ...recent[0].parsed };
  firstRecent.parentUuid = fakeAsstUuid;

  const newLines = [
    ...headers,
    JSON.stringify(fakeUser),
    JSON.stringify(fakeAsst),
    JSON.stringify(firstRecent),
    ...recent.slice(1).map(e => e.line),
  ];

  const tmpPath = sessionPath + '.trim.tmp';
  fs.writeFileSync(tmpPath, newLines.join('\n') + '\n');
  fs.renameSync(tmpPath, sessionPath);

  return {
    skipped: false,
    originalEntries: conversationEntries.length,
    newEntries: RECENT_MESSAGES_KEEP + 2,
    headerCount: headers.length,
    droppedCount: older.length,
    existingSummary,
    fakeAsstUuid,
  };
}

// ---- Helper: build a fake JSONL ----

function buildJsonl(numMessages, { includeHeader = true, includePriorSummary = false } = {}) {
  const lines = [];
  const sessionId = 'test-' + crypto.randomUUID().slice(0, 8);

  if (includeHeader) {
    lines.push(JSON.stringify({ type: 'queue-operation', op: 'init', sessionId }));
  }

  if (includePriorSummary) {
    lines.push(JSON.stringify({
      type: 'user',
      message: { role: 'user', content: 'Previous summary: user likes cats.' },
      uuid: crypto.randomUUID(),
      sessionId,
      _nanoclaw_summary: true,
    }));
    lines.push(JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Context loaded.' }] },
      uuid: crypto.randomUUID(),
      sessionId,
    }));
  }

  let prevUuid = null;
  for (let i = 0; i < numMessages; i++) {
    const uuid = crypto.randomUUID();
    const isUser = i % 2 === 0;
    const entry = {
      type: isUser ? 'user' : 'assistant',
      message: isUser
        ? { role: 'user', content: `Message ${i}: hello from user` }
        : { role: 'assistant', content: [{ type: 'text', text: `Message ${i}: response from assistant` }] },
      uuid,
      parentUuid: prevUuid,
      sessionId,
      timestamp: new Date().toISOString(),
      cwd: '/workspace/group',
      version: '1.0.0',
      isSidechain: false,
      userType: 'external',
    };
    lines.push(JSON.stringify(entry));
    prevUuid = uuid;
  }

  return { content: lines.join('\n') + '\n', sessionId };
}

function writeTempJsonl(content) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trim-test-'));
  const filePath = path.join(tmpDir, 'session.jsonl');
  fs.writeFileSync(filePath, content);
  return filePath;
}

function readJsonlEntries(filePath) {
  return fs.readFileSync(filePath, 'utf-8').split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
}

function cleanup(filePath) {
  try {
    fs.unlinkSync(filePath);
    fs.rmdirSync(path.dirname(filePath));
  } catch { /* ignore */ }
}

// ---- Tests ----

console.log('\n=== Test 1: Skip trim when below threshold ===');
{
  const { content } = buildJsonl(20);
  const filePath = writeTempJsonl(content);
  const result = trimSessionSync(filePath);
  assert(result.skipped === true, 'should skip trim');
  assert(result.reason === 'below threshold', `reason should be below threshold, got: ${result.reason}`);
  assert(result.entryCount === 20, `entry count should be 20, got: ${result.entryCount}`);
  cleanup(filePath);
}

console.log('\n=== Test 2: Trim 40-message session ===');
{
  const { content } = buildJsonl(40);
  const filePath = writeTempJsonl(content);
  const result = trimSessionSync(filePath);
  assert(!result.skipped, 'should not skip');
  assert(result.originalEntries === 40, `original should be 40, got: ${result.originalEntries}`);
  assert(result.droppedCount === 20, `dropped should be 20, got: ${result.droppedCount}`);

  // Verify output file structure
  const entries = readJsonlEntries(filePath);
  const header = entries.filter(e => e.type === 'queue-operation');
  const summaryUser = entries.find(e => e._nanoclaw_summary === true);
  const summaryAsst = entries.find(e => e.parentUuid === summaryUser?.uuid && e.type === 'assistant');
  const conversation = entries.filter(e => e.type !== 'queue-operation' && !e._nanoclaw_summary);

  assert(header.length === 1, `should have 1 header, got: ${header.length}`);
  assert(summaryUser !== undefined, 'should have summary user entry');
  assert(summaryUser.type === 'user', 'summary entry should be user type');
  assert(summaryAsst !== undefined, 'should have summary assistant entry');
  assert(conversation.length === 21, `should have 21 conversation entries (1 patched + 20 recent), got: ${conversation.length}`);

  // Verify parentUuid chain: first conversation entry → fakeAsst
  const firstConv = entries.find(e => e.type !== 'queue-operation' && !e._nanoclaw_summary && e.parentUuid === result.fakeAsstUuid);
  assert(firstConv !== undefined, 'first recent entry should point to fake assistant UUID');

  // Total entries: 1 header + 2 fake + 20 recent = 23
  assert(entries.length === 23, `total entries should be 23, got: ${entries.length}`);
  cleanup(filePath);
}

console.log('\n=== Test 3: Trim preserves last 20 messages intact ===');
{
  const { content } = buildJsonl(50);
  const originalLines = content.split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
  // Last 20 conversation entries (skip the header at index 0)
  const originalLast20 = originalLines.filter(e => e.type !== 'queue-operation').slice(-20);

  const filePath = writeTempJsonl(content);
  trimSessionSync(filePath);

  const trimmedEntries = readJsonlEntries(filePath);
  // Get only the preserved recent entries (skip header, fakeUser, fakeAsst, then first is patched)
  const summaryUserUuid = trimmedEntries.find(e => e._nanoclaw_summary)?.uuid;
  const summaryAsstUuid = trimmedEntries.find(e => e.parentUuid === summaryUserUuid && e.type === 'assistant')?.uuid;
  const recentEntries = trimmedEntries.filter(e =>
    e.type !== 'queue-operation' && !e._nanoclaw_summary && e.uuid !== summaryAsstUuid
  );

  // First entry (patched) should have same uuid but different parentUuid
  assert(recentEntries[0].uuid === originalLast20[0].uuid,
    `first recent uuid should match original`);
  assert(recentEntries[0].parentUuid === summaryAsstUuid,
    `first recent parentUuid should point to fake assistant`);

  // Remaining 19 should be identical to original
  for (let i = 1; i < 20; i++) {
    assert(recentEntries[i].uuid === originalLast20[i].uuid,
      `entry ${i}: uuid should match`);
  }
  cleanup(filePath);
}

console.log('\n=== Test 4: Second trim detects existing _nanoclaw_summary ===');
{
  const { content } = buildJsonl(40, { includePriorSummary: true });
  const filePath = writeTempJsonl(content);

  // 40 messages + 2 summary entries = 42 conversation entries (excluding header)
  const result = trimSessionSync(filePath);
  assert(!result.skipped, 'should not skip (42 entries)');
  assert(result.existingSummary === 'Previous summary: user likes cats.',
    `should detect existing summary, got: "${result.existingSummary.slice(0, 60)}"`);

  // Verify the trimmed file has exactly one _nanoclaw_summary entry
  const entries = readJsonlEntries(filePath);
  const summaries = entries.filter(e => e._nanoclaw_summary);
  assert(summaries.length === 1, `should have exactly 1 summary entry after retrim, got: ${summaries.length}`);
  cleanup(filePath);
}

console.log('\n=== Test 5: Atomic write (temp file + rename) ===');
{
  const { content } = buildJsonl(40);
  const filePath = writeTempJsonl(content);
  trimSessionSync(filePath);

  // .trim.tmp should not exist after successful trim
  const tmpExists = fs.existsSync(filePath + '.trim.tmp');
  assert(!tmpExists, 'temp file should be cleaned up after rename');

  // Original file should still exist and be valid JSON
  const entries = readJsonlEntries(filePath);
  assert(entries.length > 0, 'trimmed file should be readable');
  cleanup(filePath);
}

console.log('\n=== Test 6: No header session ===');
{
  const { content } = buildJsonl(35, { includeHeader: false });
  const filePath = writeTempJsonl(content);
  const result = trimSessionSync(filePath);
  assert(!result.skipped, 'should trim even without header');
  assert(result.headerCount === 0, `should have 0 headers, got: ${result.headerCount}`);

  const entries = readJsonlEntries(filePath);
  // 2 fake + 20 recent = 22
  assert(entries.length === 22, `should have 22 entries, got: ${entries.length}`);
  cleanup(filePath);
}

// ---- Summary ----

console.log(`\n${'='.repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
console.log('All tests passed!\n');
