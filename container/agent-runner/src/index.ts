/**
 * NanoClaw Agent Runner
 * Runs inside a container, receives config via stdin, outputs result to stdout
 *
 * Input protocol:
 *   Stdin: Full ContainerInput JSON (read until EOF, like before)
 *   IPC:   Follow-up messages written as JSON files to /workspace/ipc/input/
 *          Files: {type:"message", text:"..."}.json — polled and consumed
 *          Sentinel: /workspace/ipc/input/_close — signals session end
 *
 * Stdout protocol:
 *   Each result is wrapped in OUTPUT_START_MARKER / OUTPUT_END_MARKER pairs.
 *   Multiple results may be emitted (one per agent teams result).
 *   Final marker after loop ends signals completion.
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { query, HookCallback, PreCompactHookInput } from '@anthropic-ai/claude-agent-sdk';
import { fileURLToPath } from 'url';

interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  images?: Array<{ relativePath: string; mediaType: string }>;
}

interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
}

interface SessionEntry {
  sessionId: string;
  fullPath: string;
  summary: string;
  firstPrompt: string;
}

interface SessionsIndex {
  entries: SessionEntry[];
}

type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } };

interface SDKUserMessage {
  type: 'user';
  message: { role: 'user'; content: string | ContentBlock[] };
  parent_tool_use_id: null;
  session_id: string;
}

const WORKSPACE_BASE = process.env.WORKSPACE_BASE || '/workspace';
const IPC_INPUT_DIR = path.join(WORKSPACE_BASE, 'ipc/input');
const IPC_INPUT_CLOSE_SENTINEL = path.join(IPC_INPUT_DIR, '_close');
const IPC_POLL_MS = 500;

// Session trim constants
const RECENT_MESSAGES_KEEP = 20;
const TRIM_MIN_ENTRIES = 30;  // fewer than 30 entries → skip trim

/**
 * Push-based async iterable for streaming user messages to the SDK.
 * Keeps the iterable alive until end() is called, preventing isSingleUserTurn.
 */
class MessageStream {
  private queue: SDKUserMessage[] = [];
  private waiting: (() => void) | null = null;
  private done = false;

  push(content: string | ContentBlock[]): void {
    this.queue.push({
      type: 'user',
      message: { role: 'user', content },
      parent_tool_use_id: null,
      session_id: '',
    });
    this.waiting?.();
  }

  end(): void {
    this.done = true;
    this.waiting?.();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
    while (true) {
      while (this.queue.length > 0) {
        yield this.queue.shift()!;
      }
      if (this.done) return;
      await new Promise<void>(r => { this.waiting = r; });
      this.waiting = null;
    }
  }
}

async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

function writeOutput(output: ContainerOutput): void {
  console.log(OUTPUT_START_MARKER);
  console.log(JSON.stringify(output));
  console.log(OUTPUT_END_MARKER);
}

function log(message: string): void {
  console.error(`[agent-runner] ${message}`);
}

function getSessionSummary(sessionId: string, transcriptPath: string): string | null {
  const projectDir = path.dirname(transcriptPath);
  const indexPath = path.join(projectDir, 'sessions-index.json');

  if (!fs.existsSync(indexPath)) {
    log(`Sessions index not found at ${indexPath}`);
    return null;
  }

  try {
    const index: SessionsIndex = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
    const entry = index.entries.find(e => e.sessionId === sessionId);
    if (entry?.summary) {
      return entry.summary;
    }
  } catch (err) {
    log(`Failed to read sessions index: ${err instanceof Error ? err.message : String(err)}`);
  }

  return null;
}

/**
 * Archive the full transcript to conversations/ before compaction.
 */
function createPreCompactHook(): HookCallback {
  return async (input, _toolUseId, _context) => {
    const preCompact = input as PreCompactHookInput;
    const transcriptPath = preCompact.transcript_path;
    const sessionId = preCompact.session_id;

    if (!transcriptPath || !fs.existsSync(transcriptPath)) {
      log('No transcript found for archiving');
      return {};
    }

    try {
      const content = fs.readFileSync(transcriptPath, 'utf-8');
      const messages = parseTranscript(content);

      if (messages.length === 0) {
        log('No messages to archive');
        return {};
      }

      const summary = getSessionSummary(sessionId, transcriptPath);
      const name = summary ? sanitizeFilename(summary) : generateFallbackName();

      const conversationsDir = path.join(WORKSPACE_BASE, 'group/conversations');
      fs.mkdirSync(conversationsDir, { recursive: true });

      const date = new Date().toISOString().split('T')[0];
      const filename = `${date}-${name}.md`;
      const filePath = path.join(conversationsDir, filename);

      const markdown = formatTranscriptMarkdown(messages, summary);
      fs.writeFileSync(filePath, markdown);

      log(`Archived conversation to ${filePath}`);
    } catch (err) {
      log(`Failed to archive transcript: ${err instanceof Error ? err.message : String(err)}`);
    }

    return {};
  };
}

function sanitizeFilename(summary: string): string {
  return summary
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
}

function generateFallbackName(): string {
  const time = new Date();
  return `conversation-${time.getHours().toString().padStart(2, '0')}${time.getMinutes().toString().padStart(2, '0')}`;
}

interface ParsedMessage {
  role: 'user' | 'assistant';
  content: string;
}

function parseTranscript(content: string): ParsedMessage[] {
  const messages: ParsedMessage[] = [];

  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type === 'user' && entry.message?.content) {
        const text = typeof entry.message.content === 'string'
          ? entry.message.content
          : entry.message.content.map((c: { text?: string }) => c.text || '').join('');
        if (text) messages.push({ role: 'user', content: text });
      } else if (entry.type === 'assistant' && entry.message?.content) {
        const textParts = entry.message.content
          .filter((c: { type: string }) => c.type === 'text')
          .map((c: { text: string }) => c.text);
        const text = textParts.join('');
        if (text) messages.push({ role: 'assistant', content: text });
      }
    } catch {
    }
  }

  return messages;
}

function formatTranscriptMarkdown(messages: ParsedMessage[], title?: string | null): string {
  const now = new Date();
  const formatDateTime = (d: Date) => d.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true
  });

  const lines: string[] = [];
  lines.push(`# ${title || 'Conversation'}`);
  lines.push('');
  lines.push(`Archived: ${formatDateTime(now)}`);
  lines.push('');
  lines.push('---');
  lines.push('');

  for (const msg of messages) {
    const sender = msg.role === 'user' ? 'User' : 'Andy';
    const content = msg.content.length > 2000
      ? msg.content.slice(0, 2000) + '...'
      : msg.content;
    lines.push(`**${sender}**: ${content}`);
    lines.push('');
  }

  return lines.join('\n');
}

// --- Post-query image stripping (microcompaction) ---

const IMAGE_PLACEHOLDER = '[image stripped]';

function stripSessionImages(sessionId: string): void {
  const sessionPath = getSessionFilePath(sessionId);
  if (!sessionPath) return;

  try {
    const content = fs.readFileSync(sessionPath, 'utf-8');
    let strippedCount = 0;
    let savedBytes = 0;

    const newLines = content.split('\n').map(line => {
      if (!line.trim()) return line;
      try {
        const entry = JSON.parse(line);

        // Strip images from user messages (which contain tool_result images)
        if (entry.type === 'user' && entry.message?.content && Array.isArray(entry.message.content)) {
          let modified = false;
          const newContent = entry.message.content.map((block: Record<string, unknown>) => {
            // Direct image blocks
            if (block.type === 'image' && (block.source as Record<string, unknown>)?.data) {
              const data = (block.source as Record<string, string>).data;
              savedBytes += data.length;
              strippedCount++;
              modified = true;
              return { type: 'text', text: IMAGE_PLACEHOLDER };
            }
            // tool_result blocks containing images
            if (block.type === 'tool_result' && Array.isArray(block.content)) {
              const newSubContent = (block.content as Array<Record<string, unknown>>).map(sub => {
                if (sub.type === 'image' && (sub.source as Record<string, unknown>)?.data) {
                  const data = (sub.source as Record<string, string>).data;
                  savedBytes += data.length;
                  strippedCount++;
                  modified = true;
                  return { type: 'text', text: IMAGE_PLACEHOLDER };
                }
                return sub;
              });
              return { ...block, content: newSubContent };
            }
            return block;
          });
          if (modified) {
            entry.message.content = newContent;
            return JSON.stringify(entry);
          }
        }

        // Strip images from assistant messages (vision tool results cached)
        if (entry.type === 'assistant' && entry.message?.content && Array.isArray(entry.message.content)) {
          let modified = false;
          const newContent = entry.message.content.map((block: Record<string, unknown>) => {
            if (block.type === 'image' && (block.source as Record<string, unknown>)?.data) {
              const data = (block.source as Record<string, string>).data;
              savedBytes += data.length;
              strippedCount++;
              modified = true;
              return { type: 'text', text: IMAGE_PLACEHOLDER };
            }
            return block;
          });
          if (modified) {
            entry.message.content = newContent;
            return JSON.stringify(entry);
          }
        }
      } catch { /* not JSON, keep as-is */ }
      return line;
    });

    if (strippedCount > 0) {
      fs.writeFileSync(sessionPath, newLines.join('\n'));
      const newSize = fs.statSync(sessionPath).size;
      log(`Stripped ${strippedCount} images from session (saved ${(savedBytes / 1024 / 1024).toFixed(1)}MB, new size: ${(newSize / 1024 / 1024).toFixed(1)}MB)`);
    }
  } catch (err) {
    log(`Failed to strip session images: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function getSessionFilePath(sessionId: string): string | null {
  const home = process.env.HOME || `/Users/${process.env.USER || 'lume'}`;
  const claudeDir = path.join(home, '.claude', 'projects');

  if (!fs.existsSync(claudeDir)) return null;

  try {
    for (const projDir of fs.readdirSync(claudeDir)) {
      const candidate = path.join(claudeDir, projDir, `${sessionId}.jsonl`);
      if (fs.existsSync(candidate)) return candidate;
    }
  } catch { /* ignore */ }
  return null;
}

function getSessionFileSize(sessionId: string): number {
  const filePath = getSessionFilePath(sessionId);
  if (!filePath) return 0;
  try {
    return fs.statSync(filePath).size;
  } catch {
    return 0;
  }
}

// --- Session Sliding Window Trim ---

async function generateSummary(
  existingSummary: string,
  droppedText: string,
): Promise<string | null> {
  const prompt = existingSummary
    ? `Update this conversation summary to include the new messages being archived.

Current summary:
${existingSummary}

New messages to incorporate:
${droppedText}

Output the updated summary (under 2000 chars). Use the same language as the conversation.`
    : `Summarize this conversation history concisely (under 2000 chars). Include: user identity, key decisions, ongoing tasks, important context. Use the same language as the conversation.

${droppedText}`;

  let result: string | undefined;
  try {
    for await (const message of query({
      prompt,
      options: {
        cwd: path.join(WORKSPACE_BASE, 'group'),
        model: 'claude-sonnet-4-5-20250929',
        maxTurns: 1,
        permissionMode: 'plan',
        allowedTools: [],
      }
    })) {
      if (message.type === 'assistant' && 'message' in message) {
        const content = (message as { message?: { content?: Array<{ type: string; text?: string }> } }).message?.content;
        if (Array.isArray(content)) {
          result = content.filter((c: { type: string; text?: string }) => c.type === 'text').map((c: { type: string; text?: string }) => c.text || '').join('');
        }
      }
    }
  } catch (err) {
    log(`Summary generation failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
  return result || null;
}

async function trimSession(sessionId: string): Promise<void> {
  const sessionPath = getSessionFilePath(sessionId);
  if (!sessionPath) return;

  const content = fs.readFileSync(sessionPath, 'utf-8');
  const lines = content.split('\n').filter(l => l.trim());

  // Separate headers (queue-operation) from conversation entries
  const headers: string[] = [];
  const conversationEntries: Array<{ line: string; parsed: Record<string, unknown> }> = [];

  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      if (obj.type === 'queue-operation') {
        headers.push(line);
      } else {
        conversationEntries.push({ line, parsed: obj });
      }
    } catch {
      headers.push(line); // non-JSON lines go with headers
    }
  }

  if (conversationEntries.length < TRIM_MIN_ENTRIES) {
    log(`Session has ${conversationEntries.length} entries (< ${TRIM_MIN_ENTRIES}), skip trim`);
    return;
  }

  // Split: older + recent
  const recent = conversationEntries.slice(-RECENT_MESSAGES_KEEP);
  const older = conversationEntries.slice(0, -RECENT_MESSAGES_KEEP);

  // Extract existing summary (if previously trimmed, first entry may be a summary)
  let existingSummary = '';
  const olderForSummary: Array<{ line: string; parsed: Record<string, unknown> }> = [];
  for (const entry of older) {
    if (entry.parsed._nanoclaw_summary) {
      const msg = entry.parsed.message as { content?: string } | undefined;
      existingSummary = msg?.content || '';
    } else {
      olderForSummary.push(entry);
    }
  }

  // Format dropped messages as text for summarization
  const droppedText = olderForSummary.map(e => {
    const p = e.parsed;
    const role = p.type === 'user' ? 'User' : 'Assistant';
    const msg = (p.message as { content?: unknown })?.content;
    let text = '';
    if (typeof msg === 'string') text = msg;
    else if (Array.isArray(msg)) {
      text = msg.filter((b: { type: string }) => b.type === 'text').map((b: { text?: string }) => b.text || '').join('');
    }
    return `${role}: ${text.slice(0, 500)}`;
  }).filter(t => t.length > 10).join('\n');

  if (!droppedText && !existingSummary) {
    log('No content to summarize, skip trim');
    return;
  }

  // Generate / update summary
  const summaryText = await generateSummary(existingSummary, droppedText);
  if (!summaryText) return;

  // Build fake summary entries
  const fakeUserUuid = crypto.randomUUID();
  const fakeAsstUuid = crypto.randomUUID();
  const now = new Date().toISOString();
  const template = recent[0]?.parsed || {};

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

  // Patch first recent entry's parentUuid to chain after fake assistant
  const firstRecent = { ...recent[0].parsed };
  firstRecent.parentUuid = fakeAsstUuid;

  // Write to temp file first, then rename (crash safety)
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

  const newSize = fs.statSync(sessionPath).size;
  log(`Trimmed session: ${conversationEntries.length} → ${RECENT_MESSAGES_KEEP + 2} entries, ${older.length} summarized, new size: ${(newSize / 1024).toFixed(0)}KB`);
}

/**
 * Check for _close sentinel.
 */
function shouldClose(): boolean {
  if (fs.existsSync(IPC_INPUT_CLOSE_SENTINEL)) {
    try { fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL); } catch { /* ignore */ }
    return true;
  }
  return false;
}

/**
 * Drain all pending IPC input messages.
 * Returns messages found, or empty array.
 */
function drainIpcInput(): string[] {
  try {
    fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });
    const files = fs.readdirSync(IPC_INPUT_DIR)
      .filter(f => f.endsWith('.json'))
      .sort();

    const messages: string[] = [];
    for (const file of files) {
      const filePath = path.join(IPC_INPUT_DIR, file);
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        fs.unlinkSync(filePath);
        if (data.type === 'message' && data.text) {
          messages.push(data.text);
        }
      } catch (err) {
        log(`Failed to process input file ${file}: ${err instanceof Error ? err.message : String(err)}`);
        try { fs.unlinkSync(filePath); } catch { /* ignore */ }
      }
    }
    return messages;
  } catch (err) {
    log(`IPC drain error: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

/**
 * Wait for a new IPC message or _close sentinel.
 * Returns the messages as a single string, or null if _close.
 */
function waitForIpcMessage(): Promise<string | null> {
  return new Promise((resolve) => {
    const poll = () => {
      if (shouldClose()) {
        resolve(null);
        return;
      }
      const messages = drainIpcInput();
      if (messages.length > 0) {
        resolve(messages.join('\n'));
        return;
      }
      setTimeout(poll, IPC_POLL_MS);
    };
    poll();
  });
}

/**
 * Run a single query and stream results via writeOutput.
 * Uses MessageStream (AsyncIterable) to keep isSingleUserTurn=false,
 * allowing agent teams subagents to run to completion.
 * Also pipes IPC messages into the stream during the query.
 */
async function runQuery(
  prompt: string | ContentBlock[],
  sessionId: string | undefined,
  mcpServerPath: string,
  containerInput: ContainerInput,
  resumeAt?: string,
): Promise<{ newSessionId?: string; lastAssistantUuid?: string; closedDuringQuery: boolean }> {
  const stream = new MessageStream();
  stream.push(prompt);

  // Poll IPC for follow-up messages and _close sentinel during the query
  let ipcPolling = true;
  let closedDuringQuery = false;
  const pollIpcDuringQuery = () => {
    if (!ipcPolling) return;
    if (shouldClose()) {
      log('Close sentinel detected during query, ending stream');
      closedDuringQuery = true;
      stream.end();
      ipcPolling = false;
      return;
    }
    const messages = drainIpcInput();
    for (const text of messages) {
      log(`Piping IPC message into active query (${text.length} chars)`);
      stream.push(text);
    }
    setTimeout(pollIpcDuringQuery, IPC_POLL_MS);
  };
  setTimeout(pollIpcDuringQuery, IPC_POLL_MS);

  let newSessionId: string | undefined;
  let lastAssistantUuid: string | undefined;
  let messageCount = 0;
  let resultCount = 0;

  // Load global CLAUDE.md as additional system context (shared across all sessions)
  const globalClaudeMdPath = path.join(WORKSPACE_BASE, 'global/CLAUDE.md');
  let globalClaudeMd: string | undefined;
  if (fs.existsSync(globalClaudeMdPath)) {
    globalClaudeMd = fs.readFileSync(globalClaudeMdPath, 'utf-8');
  }

  for await (const message of query({
    prompt: stream,
    options: {
      cwd: path.join(WORKSPACE_BASE, 'group'),
      resume: sessionId,
      resumeSessionAt: resumeAt,
      systemPrompt: globalClaudeMd
        ? { type: 'preset' as const, preset: 'claude_code' as const, append: globalClaudeMd }
        : undefined,
      model: 'claude-opus-4-6',
      allowedTools: [
        'Bash',
        'Read', 'Write', 'Edit', 'Glob', 'Grep',
        'WebSearch', 'WebFetch',
        'Task', 'TaskOutput', 'TaskStop',
        'TeamCreate', 'TeamDelete', 'SendMessage',
        'TodoWrite', 'ToolSearch', 'Skill',
        'NotebookEdit',
        'mcp__nanoclaw__*'
      ],
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      settingSources: ['project', 'user'],
      mcpServers: {
        nanoclaw: {
          command: 'node',
          args: [mcpServerPath],
          env: {
            WORKSPACE_BASE,
            NANOCLAW_CHAT_JID: containerInput.chatJid,
            NANOCLAW_GROUP_FOLDER: containerInput.groupFolder,
            NANOCLAW_IS_MAIN: containerInput.isMain ? '1' : '0',
          },
        },
      },
      hooks: {
        PreCompact: [{ hooks: [createPreCompactHook()] }]
      },
    }
  })) {
    messageCount++;
    const msgType = message.type === 'system' ? `system/${(message as { subtype?: string }).subtype}` : message.type;
    log(`[msg #${messageCount}] type=${msgType}`);

    if (message.type === 'assistant' && 'uuid' in message) {
      lastAssistantUuid = (message as { uuid: string }).uuid;
    }

    if (message.type === 'system' && message.subtype === 'init') {
      newSessionId = message.session_id;
      log(`Session initialized: ${newSessionId}`);
    }

    if (message.type === 'system' && (message as { subtype?: string }).subtype === 'task_notification') {
      const tn = message as { task_id: string; status: string; summary: string };
      log(`Task notification: task=${tn.task_id} status=${tn.status} summary=${tn.summary}`);
    }

    if (message.type === 'result') {
      resultCount++;
      const textResult = 'result' in message ? (message as { result?: string }).result : null;
      log(`Result #${resultCount}: subtype=${message.subtype}${textResult ? ` text=${textResult.slice(0, 200)}` : ''}`);

      // Detect retryable API errors (rate limit / overloaded) — report as error
      // so the host-side retry logic (exponential backoff) kicks in automatically.
      const isRetryable = textResult && /rate.limit|overloaded|529|too many requests/i.test(textResult);
      if (isRetryable) {
        log('Retryable API error detected, signaling error for host retry');
        writeOutput({ status: 'error', result: null, newSessionId });
      } else {
        writeOutput({
          status: 'success',
          result: textResult || null,
          newSessionId
        });
      }
    }
  }

  ipcPolling = false;
  log(`Query done. Messages: ${messageCount}, results: ${resultCount}, lastAssistantUuid: ${lastAssistantUuid || 'none'}, closedDuringQuery: ${closedDuringQuery}`);
  return { newSessionId, lastAssistantUuid, closedDuringQuery };
}

async function main(): Promise<void> {
  let containerInput: ContainerInput;

  try {
    const stdinData = await readStdin();
    containerInput = JSON.parse(stdinData);
    log(`Received input for group: ${containerInput.groupFolder}`);
  } catch (err) {
    writeOutput({
      status: 'error',
      result: null,
      error: `Failed to parse input: ${err instanceof Error ? err.message : String(err)}`
    });
    process.exit(1);
  }

  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const mcpServerPath = path.join(__dirname, 'ipc-mcp-stdio.js');

  let sessionId = containerInput.sessionId;
  fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });

  // Clean up stale _close sentinel from previous container runs
  try { fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL); } catch { /* ignore */ }

  // Build initial prompt (drain any pending IPC messages too)
  let promptText = containerInput.prompt;
  if (containerInput.isScheduledTask) {
    promptText = `[SCHEDULED TASK - The following message was sent automatically and is not coming directly from the user or group.]\n\n${promptText}`;
  }
  const pending = drainIpcInput();
  if (pending.length > 0) {
    log(`Draining ${pending.length} pending IPC messages into initial prompt`);
    promptText += '\n' + pending.join('\n');
  }

  // Build multimodal content if images are attached
  let initialPrompt: string | ContentBlock[] = promptText;
  if (containerInput.images && containerInput.images.length > 0) {
    const blocks: ContentBlock[] = [];
    // Resolve image paths: try VM shared dir first, then container mount
    const basePaths = ['/Volumes/My Shared Files', '/workspace/project'];
    for (const img of containerInput.images) {
      let imageData: string | null = null;
      for (const base of basePaths) {
        const fullPath = path.join(base, img.relativePath);
        if (fs.existsSync(fullPath)) {
          try {
            imageData = fs.readFileSync(fullPath).toString('base64');
            log(`Loaded image: ${fullPath} (${imageData.length} base64 chars)`);
          } catch (err) {
            log(`Failed to read image ${fullPath}: ${err instanceof Error ? err.message : String(err)}`);
          }
          break;
        }
      }
      if (imageData) {
        blocks.push({
          type: 'image',
          source: { type: 'base64', media_type: img.mediaType, data: imageData },
        });
      } else {
        log(`Image not found: ${img.relativePath} (tried: ${basePaths.join(', ')})`);
      }
    }
    if (blocks.length > 0) {
      blocks.push({ type: 'text', text: promptText });
      initialPrompt = blocks;
      log(`Built multimodal prompt with ${blocks.length - 1} image(s)`);
    }
  }

  // Query loop: run query → wait for IPC message → run new query → repeat
  let resumeAt: string | undefined;
  let retriedWithoutSession = false;
  try {
    while (true) {
      log(`Starting query (session: ${sessionId || 'new'}, resumeAt: ${resumeAt || 'latest'})...`);

      let queryResult;
      try {
        queryResult = await runQuery(initialPrompt, sessionId, mcpServerPath, containerInput, resumeAt);
      } catch (err) {
        // Resume failed — fallback to new session (try once)
        if (sessionId && !retriedWithoutSession) {
          const errMsg = err instanceof Error ? err.message : String(err);
          log(`Query failed with session ${sessionId}, retrying without resume: ${errMsg}`);
          sessionId = undefined;
          resumeAt = undefined;
          retriedWithoutSession = true;
          continue;
        }
        throw err;
      }
      retriedWithoutSession = false;

      if (queryResult.newSessionId) {
        sessionId = queryResult.newSessionId;
      }
      if (queryResult.lastAssistantUuid) {
        resumeAt = queryResult.lastAssistantUuid;
      }

      // Strip base64 images from session JSONL after each query
      // Screenshots served their purpose during the query; no need to reload on resume
      if (sessionId) {
        stripSessionImages(sessionId);
      }

      // If _close was consumed during the query, exit immediately.
      // Don't emit a session-update marker (it would reset the host's
      // idle timer and cause a 30-min delay before the next _close).
      if (queryResult.closedDuringQuery) {
        log('Close sentinel consumed during query, exiting');
        break;
      }

      // Emit session update so host can track it
      writeOutput({ status: 'success', result: null, newSessionId: sessionId });

      log('Query ended, waiting for next IPC message...');

      // Wait for the next message or _close sentinel
      const nextMessage = await waitForIpcMessage();
      if (nextMessage === null) {
        log('Close sentinel received, exiting');
        break;
      }

      log(`Got new message (${nextMessage.length} chars), starting new query`);
      initialPrompt = nextMessage;
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    log(`Agent error: ${errorMessage}`);
    writeOutput({
      status: 'error',
      result: null,
      newSessionId: sessionId,
      error: errorMessage
    });
    process.exit(1);
  }

  // Trim session at shutdown (sliding window compaction, non-fatal)
  if (sessionId) {
    try {
      await trimSession(sessionId);
    } catch (err) {
      log(`Session trim failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

main();
