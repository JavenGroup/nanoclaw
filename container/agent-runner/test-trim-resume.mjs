#!/usr/bin/env node
/**
 * Integration test: trim a real session with stub summary, then resume via SDK.
 * Run on the VM: PATH=/Users/lume/local/bin:$PATH node test-trim-resume.mjs <sessionId>
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { query } from '@anthropic-ai/claude-agent-sdk';

const WORKSPACE_BASE = process.env.WORKSPACE_BASE || '/Volumes/My Shared Files';
const RECENT_MESSAGES_KEEP = 20;

function log(msg) { console.error(`[test] ${msg}`); }

function getSessionFilePath(sessionId) {
  const home = process.env.HOME || '/Users/lume';
  const claudeDir = path.join(home, '.claude', 'projects');
  if (!fs.existsSync(claudeDir)) return null;
  for (const projDir of fs.readdirSync(claudeDir)) {
    const candidate = path.join(claudeDir, projDir, `${sessionId}.jsonl`);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function trimSessionWithStubSummary(sessionId) {
  const sessionPath = getSessionFilePath(sessionId);
  if (!sessionPath) { log('Session file not found'); return false; }

  const content = fs.readFileSync(sessionPath, 'utf-8');
  const lines = content.split('\n').filter(l => l.trim());

  const headers = [];
  const conversationEntries = [];
  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      if (obj.type === 'queue-operation') headers.push(line);
      else conversationEntries.push({ line, parsed: obj });
    } catch { headers.push(line); }
  }

  log(`Before trim: ${conversationEntries.length} conversation entries, ${headers.length} headers`);

  const recent = conversationEntries.slice(-RECENT_MESSAGES_KEEP);
  const older = conversationEntries.slice(0, -RECENT_MESSAGES_KEEP);
  const summaryText = `[Test stub summary] This session had ${older.length} earlier messages that were trimmed for testing.`;

  const fakeUserUuid = crypto.randomUUID();
  const fakeAsstUuid = crypto.randomUUID();
  const now = new Date().toISOString();
  const template = recent[0]?.parsed || {};

  const fakeUser = {
    type: 'user',
    message: { role: 'user', content: `[SESSION CONTEXT — Summarized history of earlier conversation]\n\n${summaryText}` },
    uuid: fakeUserUuid, parentUuid: undefined, sessionId,
    timestamp: now, cwd: template.cwd, version: template.version,
    isSidechain: false, userType: 'external', _nanoclaw_summary: true,
  };
  const fakeAsst = {
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text: 'Context loaded.' }] },
    uuid: fakeAsstUuid, parentUuid: fakeUserUuid, sessionId,
    timestamp: now, cwd: template.cwd, version: template.version,
    isSidechain: false, userType: 'external',
  };
  const firstRecent = { ...recent[0].parsed };
  firstRecent.parentUuid = fakeAsstUuid;

  const newLines = [
    ...headers,
    JSON.stringify(fakeUser), JSON.stringify(fakeAsst), JSON.stringify(firstRecent),
    ...recent.slice(1).map(e => e.line),
  ];

  const tmpPath = sessionPath + '.trim.tmp';
  fs.writeFileSync(tmpPath, newLines.join('\n') + '\n');
  fs.renameSync(tmpPath, sessionPath);

  const newSize = fs.statSync(sessionPath).size;
  log(`After trim: ${RECENT_MESSAGES_KEEP + 2} entries, ${(newSize/1024).toFixed(0)}KB`);
  return true;
}

async function testResume(sessionId) {
  log(`Resuming session ${sessionId}...`);

  const groupDir = path.join(WORKSPACE_BASE, 'groups/workspace~t780');
  if (!fs.existsSync(groupDir)) {
    log(`Group dir not found: ${groupDir}, trying fallback`);
  }

  let resultText = '';
  let gotResult = false;

  for await (const message of query({
    prompt: 'Say exactly "TRIM_RESUME_OK" and nothing else.',
    options: {
      cwd: groupDir,
      resume: sessionId,
      model: 'claude-sonnet-4-5-20250929',
      maxTurns: 1,
      permissionMode: 'plan',
      allowedTools: [],
    }
  })) {
    const msgType = message.type === 'system' ? `system/${message.subtype}` : message.type;
    log(`[msg] ${msgType}`);

    if (message.type === 'result') {
      resultText = message.result || '';
      log(`Result: subtype=${message.subtype} text=${resultText.slice(0, 200)}`);
      gotResult = true;
    }
    if (message.type === 'assistant' && 'message' in message) {
      const content = message.message?.content;
      if (Array.isArray(content)) {
        const text = content.filter(c => c.type === 'text').map(c => c.text || '').join('');
        if (text) log(`Assistant: ${text.slice(0, 300)}`);
      }
    }
  }

  return gotResult;
}

async function main() {
  const sessionId = process.argv[2];
  if (!sessionId) {
    console.error('Usage: node test-trim-resume.mjs <sessionId>');
    process.exit(1);
  }

  log(`Session: ${sessionId}`);
  const sessionPath = getSessionFilePath(sessionId);
  log(`File: ${sessionPath}`);

  // Step 1: Trim with stub summary (no SDK call)
  log('=== Step 1: Trim (stub summary) ===');
  const trimmed = trimSessionWithStubSummary(sessionId);
  if (!trimmed) {
    log('FAILED: Trim failed');
    process.exit(1);
  }

  // Step 2: Resume the trimmed session
  log('=== Step 2: Resume ===');
  try {
    const resumed = await testResume(sessionId);
    if (resumed) {
      log('=== PASSED: Trim + Resume works ===');
    } else {
      log('=== FAILED: No result from resume ===');
      process.exit(1);
    }
  } catch (err) {
    log(`=== FAILED: Resume threw: ${err.message} ===`);
    process.exit(1);
  }
}

main().catch(err => {
  log(`Fatal: ${err.message}`);
  process.exit(1);
});
