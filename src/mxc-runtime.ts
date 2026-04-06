/**
 * MXC container runtime for NanoClaw.
 * Spawns agent-runner processes inside mxc sandboxes (AppContainer on Windows)
 * instead of Docker containers.
 *
 * Uses @microsoft/mxc-sdk's spawnSandbox() which returns a PTY (node-pty IPty).
 * Input is passed via file (NANOCLAW_INPUT_FILE) since PTY has no stdin EOF.
 * Output markers are parsed from the merged PTY stream.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { randomBytes } from 'crypto';

import { logger } from './logger.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface MxcSdk {
  getPlatformSupport(): { isSupported: boolean; reason?: string };
  spawnSandbox(
    script: string,
    policy: {
      version: string;
      filesystem?: {
        readwritePaths?: string[];
        readonlyPaths?: string[];
        deniedPaths?: string[];
        clearPolicyOnExit?: boolean;
      };
      network?: {
        allowOutbound?: boolean;
        allowLocalNetwork?: boolean;
      };
    },
    options: { debug: boolean },
    workingDirectory: string,
    containerName: string,
    env?: Record<string, string | undefined>,
  ): MxcPty;
}

interface MxcPty {
  onData: (callback: (data: string) => void) => void;
  onExit: (callback: (event: { exitCode: number }) => void) => void;
  write: (data: string) => void;
  kill: () => void;
  pid: number;
}

interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
  script?: string;
}

interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
}

interface MxcSpawnConfig {
  groupFolder: string;
  groupDir: string;
  ipcDir: string;
  projectDir?: string;
  globalDir?: string;
  agentRunnerDir: string;
  containerName: string;
  env: Record<string, string>;
}

// Track active sandboxes for cleanup
const activeSandboxes = new Map<string, MxcPty>();

// ---------------------------------------------------------------------------
// SDK loading
// ---------------------------------------------------------------------------

let mxcSdk: MxcSdk | null = null;

async function loadMxcSdk(): Promise<MxcSdk> {
  if (mxcSdk) return mxcSdk;
  const moduleName = '@microsoft/mxc-sdk';
  try {
    mxcSdk = (await import(moduleName)) as MxcSdk;
    return mxcSdk;
  } catch {
    throw new Error(
      'mxc runtime requires @microsoft/mxc-sdk. Install it with: npm install @microsoft/mxc-sdk',
    );
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Check if mxc is available on this platform. */
export async function isMxcAvailable(): Promise<boolean> {
  try {
    const sdk = await loadMxcSdk();
    return sdk.getPlatformSupport().isSupported;
  } catch {
    return false;
  }
}

/** Kill all tracked mxc sandboxes. */
export function cleanupMxcSandboxes(): void {
  for (const [name, pty] of activeSandboxes) {
    try {
      pty.kill();
      logger.info({ name }, 'Killed mxc sandbox');
    } catch {
      /* already dead */
    }
  }
  activeSandboxes.clear();
}

/** Stop a specific sandbox by name. */
export function stopMxcSandbox(name: string): void {
  const pty = activeSandboxes.get(name);
  if (pty) {
    pty.kill();
    activeSandboxes.delete(name);
  }
}

const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';
const CONTAINER_MAX_OUTPUT_SIZE = 512 * 1024;

/**
 * Spawn the agent-runner inside an mxc sandbox.
 * This is the mxc equivalent of runContainerAgent() in container-runner.ts.
 */
export async function runMxcAgent(
  config: MxcSpawnConfig,
  input: ContainerInput,
  onProcess: (containerName: string, pid: number) => void,
  onOutput?: (output: ContainerOutput) => Promise<void>,
  timeoutMs: number = 300_000,
): Promise<ContainerOutput> {
  const sdk = await loadMxcSdk();
  const startTime = Date.now();

  // Write input to a temp file (PTY has no stdin EOF)
  const inputFile = path.join(
    os.tmpdir(),
    `nanoclaw-input-${config.containerName}.json`,
  );
  fs.writeFileSync(inputFile, JSON.stringify(input));

  // Build filesystem policy
  const readwritePaths = [
    config.groupDir,
    config.ipcDir,
    os.tmpdir(),
    path.join(os.homedir(), 'AppData', 'Local'),
    path.join(os.homedir(), '.copilot'),
  ];
  const readonlyPaths = [
    config.agentRunnerDir,
    process.env.SystemRoot ?? 'C:\\Windows',
    process.env.ProgramFiles ?? 'C:\\Program Files',
    process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)',
    process.env.ProgramData ?? 'C:\\ProgramData',
  ];
  if (config.projectDir) {
    readonlyPaths.push(config.projectDir);
  }
  if (config.globalDir) {
    readonlyPaths.push(config.globalDir);
  }

  // Resolve node.exe path
  const nodeExe = process.execPath;
  const nodeDir = path.dirname(nodeExe);
  readonlyPaths.push(nodeDir);

  // Build env vars for the agent-runner
  const sandboxEnv: Record<string, string | undefined> = {
    ...config.env,
    NANOCLAW_INPUT_FILE: inputFile,
    NANOCLAW_WORKSPACE_GROUP: config.groupDir,
    NANOCLAW_WORKSPACE_IPC: config.ipcDir,
    NANOCLAW_WORKSPACE_PROJECT: config.projectDir,
    NANOCLAW_WORKSPACE_GLOBAL: config.globalDir,
    NANOCLAW_WORKSPACE_EXTRA: undefined,
    NANOCLAW_HOME: os.homedir(),
    NANOCLAW_TEMP: os.tmpdir(),
    // Copilot SDK sandbox flags
    SANDBOX: 'true',
    COPILOT_CLI_ENABLED_FEATURE_FLAGS: 'SANDBOX',
    // Pass through auth
    GITHUB_TOKEN: process.env.GITHUB_TOKEN ?? config.env.GITHUB_TOKEN,
    COPILOT_MODEL: process.env.COPILOT_MODEL ?? config.env.COPILOT_MODEL,
    NANOCLAW_SDK: process.env.NANOCLAW_SDK ?? config.env.NANOCLAW_SDK ?? 'copilot',
    NANOCLAW_SANDBOX: '1',
    // Node/system
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    APPDATA: process.env.APPDATA,
    LOCALAPPDATA: process.env.LOCALAPPDATA,
    USERPROFILE: process.env.USERPROFILE,
    TZ: process.env.TZ ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
  };

  // Build the command: node <agent-runner entry point>
  const entryPoint = path.join(config.agentRunnerDir, 'src', 'index.ts');
  const script = `"${nodeExe}" --import tsx "${entryPoint}"`;

  logger.info(
    {
      containerName: config.containerName,
      script,
      readwritePaths,
      readonlyPaths: readonlyPaths.length,
    },
    'Spawning mxc sandbox for agent',
  );

  const pty = sdk.spawnSandbox(
    script,
    {
      version: '0.4.0-alpha',
      filesystem: {
        readwritePaths,
        readonlyPaths,
        clearPolicyOnExit: true,
      },
      network: { allowOutbound: true },
    },
    { debug: false },
    config.groupDir,
    config.containerName,
    sandboxEnv,
  );

  activeSandboxes.set(config.containerName, pty);
  onProcess(config.containerName, pty.pid);

  return new Promise((resolve) => {
    let output = '';
    let outputTruncated = false;
    let parseBuffer = '';
    let newSessionId: string | undefined;
    let hadStreamingOutput = false;
    let timedOut = false;
    let outputChain = Promise.resolve();

    const killOnTimeout = () => {
      timedOut = true;
      logger.error(
        { containerName: config.containerName },
        'mxc sandbox timeout, killing',
      );
      pty.kill();
    };

    let timeout = setTimeout(killOnTimeout, timeoutMs);

    const resetTimeout = () => {
      clearTimeout(timeout);
      timeout = setTimeout(killOnTimeout, timeoutMs);
    };

    pty.onData((data: string) => {
      // Accumulate for logging (with truncation)
      if (!outputTruncated) {
        const remaining = CONTAINER_MAX_OUTPUT_SIZE - output.length;
        if (data.length > remaining) {
          output += data.slice(0, remaining);
          outputTruncated = true;
        } else {
          output += data;
        }
      }

      // Parse output markers from merged PTY stream
      if (onOutput) {
        parseBuffer += data;
        let startIdx: number;
        while (
          (startIdx = parseBuffer.indexOf(OUTPUT_START_MARKER)) !== -1
        ) {
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
              { containerName: config.containerName, error: err },
              'Failed to parse streamed output chunk',
            );
          }
        }
      }
    });

    pty.onExit((event: { exitCode: number }) => {
      clearTimeout(timeout);
      activeSandboxes.delete(config.containerName);

      // Clean up input file
      try {
        fs.unlinkSync(inputFile);
      } catch {
        /* may already be deleted */
      }

      const duration = Date.now() - startTime;

      if (timedOut) {
        logger.error(
          { containerName: config.containerName, duration },
          'mxc sandbox timed out',
        );
        resolve({
          status: 'error',
          result: null,
          error: 'Agent timed out',
          newSessionId,
        });
        return;
      }

      logger.info(
        {
          containerName: config.containerName,
          exitCode: event.exitCode,
          duration,
          outputLength: output.length,
        },
        'mxc sandbox exited',
      );

      // If we had streaming output, the last streamed result is the answer
      if (hadStreamingOutput) {
        resolve({
          status: 'success',
          result: null,
          newSessionId,
        });
        return;
      }

      // Try to parse final output from accumulated buffer
      const lastStart = output.lastIndexOf(OUTPUT_START_MARKER);
      const lastEnd = output.lastIndexOf(OUTPUT_END_MARKER);
      if (lastStart !== -1 && lastEnd > lastStart) {
        const jsonStr = output
          .slice(lastStart + OUTPUT_START_MARKER.length, lastEnd)
          .trim();
        try {
          resolve(JSON.parse(jsonStr));
          return;
        } catch {
          /* fall through */
        }
      }

      resolve({
        status: event.exitCode === 0 ? 'success' : 'error',
        result: event.exitCode === 0 ? output.trim() : null,
        error:
          event.exitCode !== 0
            ? `Agent exited with code ${event.exitCode}`
            : undefined,
        newSessionId,
      });
    });
  });
}
