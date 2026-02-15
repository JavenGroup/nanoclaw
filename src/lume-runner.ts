/**
 * Lume VM Runner for NanoClaw
 * Runs agent inside a long-lived macOS VM via SSH, using the same
 * stdin/stdout protocol as the container runner.
 */
import { ChildProcess, execSync, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

import {
  CONTAINER_MAX_OUTPUT_SIZE,
  CONTAINER_TIMEOUT,
  DATA_DIR,
  GROUPS_DIR,
  IDLE_TIMEOUT,
  LUME_VM_NAME,
  LUME_VM_USER,
  LUME_WORKSPACE,
} from './config.js';
import { ContainerInput, ContainerOutput } from './container-runner.js';
import { logger } from './logger.js';
import { RegisteredGroup } from './types.js';

const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

/** Absolute path to the nanoclaw project root on the host. */
const PROJECT_ROOT = process.cwd();

/**
 * Where the host project dir appears inside the VM.
 * Lume mounts --shared-dir at /Volumes/My Shared Files/.
 */
const VM_SHARED_DIR = '/Volumes/My Shared Files';

let cachedVmIp: string | null = null;

/** Get the IP address of the Lume VM. */
function getLumeVmIp(): string {
  if (cachedVmIp) return cachedVmIp;

  try {
    const output = execSync(`lume get ${LUME_VM_NAME}`, {
      encoding: 'utf-8',
      timeout: 10000,
    });
    // Parse the table output — IP is in the second-to-last column
    const lines = output.trim().split('\n');
    if (lines.length < 2) throw new Error('No VM data');
    const dataLine = lines[1]; // Skip header
    // IP looks like 192.168.x.x — find it with regex
    const ipMatch = dataLine.match(/(\d+\.\d+\.\d+\.\d+)/);
    if (!ipMatch) throw new Error('No IP found in lume output');
    cachedVmIp = ipMatch[1];
    return cachedVmIp;
  } catch (err) {
    throw new Error(
      `Failed to get Lume VM IP for "${LUME_VM_NAME}": ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** Check that the Lume VM is running and reachable. */
export function ensureLumeVmRunning(): void {
  try {
    const output = execSync(`lume get ${LUME_VM_NAME}`, {
      encoding: 'utf-8',
      timeout: 10000,
    });
    if (!output.includes('running')) {
      logger.info({ vm: LUME_VM_NAME }, 'Lume VM not running, starting...');
      execSync(
        `lume run ${LUME_VM_NAME} --shared-dir "${PROJECT_ROOT}"`,
        { timeout: 60000 },
      );
      // Wait for SSH to become available
      const ip = getLumeVmIp();
      for (let i = 0; i < 30; i++) {
        try {
          execSync(
            `ssh -o ConnectTimeout=2 -o StrictHostKeyChecking=no ${LUME_VM_USER}@${ip} 'echo ok'`,
            { timeout: 5000 },
          );
          break;
        } catch {
          if (i === 29) throw new Error('VM SSH not reachable after 60s');
          execSync('sleep 2');
        }
      }
      logger.info({ vm: LUME_VM_NAME, ip }, 'Lume VM started');
    }
  } catch (err) {
    logger.warn(
      { vm: LUME_VM_NAME, err },
      'Lume VM check failed (Lume may not be installed)',
    );
  }
}

/**
 * Prepare the workspace directories on the host.
 */
function prepareVmWorkspace(group: RegisteredGroup): void {
  // Ensure IPC directories exist on host (shared with VM)
  const groupIpcDir = path.join(DATA_DIR, 'ipc', group.folder);
  fs.mkdirSync(path.join(groupIpcDir, 'messages'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'tasks'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'input'), { recursive: true });

  // Ensure group directory exists
  const groupDir = path.join(GROUPS_DIR, group.folder);
  fs.mkdirSync(groupDir, { recursive: true });

  // Ensure sessions directory exists
  const groupSessionsDir = path.join(
    DATA_DIR,
    'sessions',
    group.folder,
    '.claude',
  );
  fs.mkdirSync(groupSessionsDir, { recursive: true });
}

/** Read auth environment variables from .env for the agent. */
function getAuthEnvVars(): string {
  const envFile = path.join(PROJECT_ROOT, '.env');
  if (!fs.existsSync(envFile)) return '';

  const content = fs.readFileSync(envFile, 'utf-8');
  const allowedVars = ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY'];
  const exports: string[] = [];

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    for (const varName of allowedVars) {
      if (trimmed.startsWith(`${varName}=`)) {
        // Shell-safe: single-quote the value
        const value = trimmed.slice(varName.length + 1).replace(/'/g, "'\\''");
        exports.push(`export ${varName}='${value}'`);
      }
    }
  }

  return exports.join(' && ');
}

/**
 * Build the SSH command to run agent-runner inside the Lume VM.
 * Sets up workspace symlinks pointing to the shared directory, then runs
 * the agent-runner with WORKSPACE_BASE pointing to the workspace root.
 */
function buildSshCommand(
  vmIp: string,
  group: RegisteredGroup,
  isMain: boolean,
): string[] {
  const ws = LUME_WORKSPACE;
  const shared = VM_SHARED_DIR;

  // Build a setup script that creates the workspace symlink structure:
  // {ws}/group/ → shared groups/{folder}/
  // {ws}/ipc/ → shared data/ipc/{folder}/
  // {ws}/global/ → shared groups/global/
  // {ws}/sessions/ → shared data/sessions/{folder}/
  const parts: string[] = [];

  // Auth environment
  const authEnv = getAuthEnvVars();
  if (authEnv) parts.push(authEnv);

  // Setup symlinks
  parts.push(
    `mkdir -p "${ws}"`,
    `rm -f "${ws}/group" "${ws}/ipc" "${ws}/global" "${ws}/sessions"`,
    `ln -sf "${shared}/groups/${group.folder}" "${ws}/group"`,
    `ln -sf "${shared}/data/ipc/${group.folder}" "${ws}/ipc"`,
    `ln -sf "${shared}/groups/global" "${ws}/global"`,
    `ln -sf "${shared}/data/sessions/${group.folder}" "${ws}/sessions"`,
  );

  // Run agent-runner with browser support (headed mode for anti-detection)
  const browserPath = '/Users/lume/Library/Caches/ms-playwright/chromium-1208/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
  parts.push(
    `cd "${ws}" && WORKSPACE_BASE="${ws}" AGENT_BROWSER_EXECUTABLE_PATH='${browserPath}' AGENT_BROWSER_HEADED=1 PATH="${ws}/tools/node_modules/.bin:${ws}/tools:/opt/homebrew/bin:$PATH" node "${ws}/agent-runner/dist/index.js"`,
  );

  return [
    'ssh',
    '-o',
    'StrictHostKeyChecking=no',
    '-o',
    'ServerAliveInterval=30',
    '-o',
    'ServerAliveCountMax=3',
    `${LUME_VM_USER}@${vmIp}`,
    parts.join(' && '),
  ];
}

export async function runLumeAgent(
  group: RegisteredGroup,
  input: ContainerInput,
  onProcess: (proc: ChildProcess, containerName: string) => void,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<ContainerOutput> {
  const startTime = Date.now();
  const vmIp = getLumeVmIp();

  prepareVmWorkspace(group);

  const sshArgs = buildSshCommand(vmIp, group, input.isMain);
  const vmName = `lume-${group.folder}-${Date.now()}`;

  logger.info(
    {
      group: group.name,
      vmName,
      vmIp,
      isMain: input.isMain,
    },
    'Running agent in Lume VM via SSH',
  );

  const logsDir = path.join(GROUPS_DIR, group.folder, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });

  return new Promise((resolve) => {
    const sshProc = spawn(sshArgs[0], sshArgs.slice(1), {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    onProcess(sshProc, vmName);

    let stdout = '';
    let stderr = '';
    let stdoutTruncated = false;
    let stderrTruncated = false;

    // Send input via stdin (same as container protocol)
    sshProc.stdin.write(JSON.stringify(input));
    sshProc.stdin.end();

    // Streaming output parsing (identical to container-runner)
    let parseBuffer = '';
    let newSessionId: string | undefined;
    let outputChain = Promise.resolve();
    let hadStreamingOutput = false;

    sshProc.stdout.on('data', (data) => {
      const chunk = data.toString();

      if (!stdoutTruncated) {
        const remaining = CONTAINER_MAX_OUTPUT_SIZE - stdout.length;
        if (chunk.length > remaining) {
          stdout += chunk.slice(0, remaining);
          stdoutTruncated = true;
        } else {
          stdout += chunk;
        }
      }

      if (onOutput) {
        parseBuffer += chunk;
        let startIdx: number;
        while ((startIdx = parseBuffer.indexOf(OUTPUT_START_MARKER)) !== -1) {
          const endIdx = parseBuffer.indexOf(OUTPUT_END_MARKER, startIdx);
          if (endIdx === -1) break;

          const jsonStr = parseBuffer
            .slice(startIdx + OUTPUT_START_MARKER.length, endIdx)
            .trim();
          parseBuffer = parseBuffer.slice(endIdx + OUTPUT_END_MARKER.length);

          try {
            const parsed: ContainerOutput = JSON.parse(jsonStr);
            if (parsed.newSessionId) {
              newSessionId = parsed.newSessionId;
            }
            hadStreamingOutput = true;
            resetTimeout();
            outputChain = outputChain.then(() => onOutput(parsed));
          } catch (err) {
            logger.warn(
              { group: group.name, error: err },
              'Failed to parse streamed output chunk',
            );
          }
        }
      }
    });

    sshProc.stderr.on('data', (data) => {
      const chunk = data.toString();
      const lines = chunk.trim().split('\n');
      for (const line of lines) {
        if (line) logger.debug({ vm: group.folder }, line);
      }
      if (stderrTruncated) return;
      const remaining = CONTAINER_MAX_OUTPUT_SIZE - stderr.length;
      if (chunk.length > remaining) {
        stderr += chunk.slice(0, remaining);
        stderrTruncated = true;
      } else {
        stderr += chunk;
      }
    });

    let timedOut = false;
    const configTimeout = group.containerConfig?.timeout || CONTAINER_TIMEOUT;
    const timeoutMs = Math.max(configTimeout, IDLE_TIMEOUT + 30_000);

    const killOnTimeout = () => {
      timedOut = true;
      logger.error({ group: group.name, vmName }, 'Lume SSH timeout, killing');
      sshProc.kill('SIGTERM');
      setTimeout(() => sshProc.kill('SIGKILL'), 5000);
    };

    let timeout = setTimeout(killOnTimeout, timeoutMs);

    const resetTimeout = () => {
      clearTimeout(timeout);
      timeout = setTimeout(killOnTimeout, timeoutMs);
    };

    sshProc.on('close', (code) => {
      clearTimeout(timeout);
      const duration = Date.now() - startTime;

      if (timedOut) {
        if (hadStreamingOutput) {
          logger.info(
            { group: group.name, vmName, duration },
            'Lume SSH timed out after output (idle cleanup)',
          );
          outputChain.then(() => {
            resolve({ status: 'success', result: null, newSessionId });
          });
          return;
        }
        resolve({
          status: 'error',
          result: null,
          error: `Lume VM timed out after ${configTimeout}ms`,
        });
        return;
      }

      // Write log
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const logFile = path.join(logsDir, `lume-${timestamp}.log`);
      fs.writeFileSync(
        logFile,
        [
          `=== Lume VM Run Log ===`,
          `Group: ${group.name}`,
          `VM: ${LUME_VM_NAME} (${vmIp})`,
          `Duration: ${duration}ms`,
          `Exit Code: ${code}`,
          ``,
          `=== Stderr ===`,
          stderr,
          ``,
          `=== Stdout ===`,
          stdout,
        ].join('\n'),
      );

      if (code !== 0) {
        logger.error(
          { group: group.name, code, duration, stderr: stderr.slice(-500) },
          'Lume SSH exited with error',
        );
        resolve({
          status: 'error',
          result: null,
          error: `Lume SSH exited with code ${code}: ${stderr.slice(-200)}`,
        });
        return;
      }

      // Streaming mode
      if (onOutput) {
        outputChain.then(() => {
          logger.info(
            { group: group.name, duration, newSessionId },
            'Lume VM completed (streaming mode)',
          );
          resolve({ status: 'success', result: null, newSessionId });
        });
        return;
      }

      // Legacy mode: parse last output
      try {
        const startIdx = stdout.indexOf(OUTPUT_START_MARKER);
        const endIdx = stdout.indexOf(OUTPUT_END_MARKER);
        let jsonLine: string;
        if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
          jsonLine = stdout
            .slice(startIdx + OUTPUT_START_MARKER.length, endIdx)
            .trim();
        } else {
          const lines = stdout.trim().split('\n');
          jsonLine = lines[lines.length - 1];
        }
        const output: ContainerOutput = JSON.parse(jsonLine);
        logger.info({ group: group.name, duration }, 'Lume VM completed');
        resolve(output);
      } catch (err) {
        logger.error(
          { group: group.name, stdout: stdout.slice(-500), error: err },
          'Failed to parse Lume output',
        );
        resolve({
          status: 'error',
          result: null,
          error: `Failed to parse Lume output: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    });

    sshProc.on('error', (err) => {
      clearTimeout(timeout);
      logger.error({ group: group.name, error: err }, 'SSH spawn error');
      resolve({
        status: 'error',
        result: null,
        error: `SSH spawn error: ${err.message}`,
      });
    });
  });
}
