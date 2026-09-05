import { spawn } from 'child_process';
import { existsSync, statSync } from 'fs';
import { v4 as uuid } from 'uuid';
import type { Readable } from 'stream';
import type {
  AgentAttachment,
  AgentEvent,
  AgentEventMetadata,
  AgentProvider,
  AgentResult,
  AgentSession,
  AgentSessionConfig,
} from '@codewithdan/agent-sdk-core';
import type { AgentInfo } from '../types.js';
import { errorMessage } from '../utils.js';

const DEFAULT_DSH_HOME = '/root/.dsh';
const DEFAULT_DSH_PROFILE = 'headless';
const LOCAL_AGENT_TYPE = 'local-openai' as AgentEventMetadata['agentType'];
const TERMINATION_GRACE_MS = 2000;

interface LocalOpenAIConfig {
  launcherPath: string;
  dshHome: string;
  profile: string;
  displayName: string;
  model?: string;
}

type SpawnedProcess = {
  stdout?: Readable | null;
  stderr?: Readable | null;
  killed?: boolean;
  kill(signal?: NodeJS.Signals | number): boolean;
  once(event: 'error', listener: (err: Error) => void): SpawnedProcess;
  once(event: 'close', listener: (code: number | null, signal: NodeJS.Signals | null) => void): SpawnedProcess;
};

type SpawnCommand = (
  command: string,
  args: string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    windowsHide: boolean;
    stdio: ['ignore', 'pipe', 'pipe'];
  },
) => SpawnedProcess;

function trimEnv(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

export function getLocalOpenAIConfig(env: NodeJS.ProcessEnv = process.env): LocalOpenAIConfig | null {
  const launcherPath = trimEnv(env.DSH_LAUNCHER_PATH);
  if (!launcherPath) return null;
  return {
    launcherPath,
    dshHome: trimEnv(env.DSH_HOME) ?? DEFAULT_DSH_HOME,
    profile: trimEnv(env.DSH_PROFILE) ?? DEFAULT_DSH_PROFILE,
    displayName: trimEnv(env.LOCAL_OPENAI_DISPLAY_NAME) ?? 'Local AI',
    model: trimEnv(env.LOCAL_OPENAI_MODEL),
  };
}

function launcherValidationError(launcherPath: string): string | null {
  try {
    if (!existsSync(launcherPath)) return 'DSH_LAUNCHER_PATH does not exist';
    const stat = statSync(launcherPath);
    if (!stat.isFile()) return 'DSH_LAUNCHER_PATH must point to a file';
    return null;
  } catch (err: unknown) {
    return `DSH_LAUNCHER_PATH could not be inspected: ${errorMessage(err)}`;
  }
}

export async function detectLocalOpenAIAgent(args: {
  env?: NodeJS.ProcessEnv;
} = {}): Promise<AgentInfo> {
  const env = args.env ?? process.env;
  const config = getLocalOpenAIConfig(env);
  const displayName = trimEnv(env.LOCAL_OPENAI_DISPLAY_NAME) ?? 'Local AI';
  if (!config) {
    return {
      name: 'local-openai',
      displayName,
      available: false,
      reason: 'DSH_LAUNCHER_PATH is required',
    };
  }

  const validationError = launcherValidationError(config.launcherPath);
  if (validationError) {
    return {
      name: 'local-openai',
      displayName: config.displayName,
      available: false,
      reason: validationError,
    };
  }

  return {
    name: 'local-openai',
    displayName: config.displayName,
    available: true,
    version: config.model,
  };
}

function emit(config: AgentSessionConfig, type: AgentEvent['type'], content: string, metadata?: AgentEventMetadata): void {
  const safeContent = sanitizeOutput(content);
  if (!safeContent.trim() && type !== 'complete' && type !== 'error') return;
  config.onEvent({
    id: uuid(),
    contextId: config.contextId,
    type,
    content: safeContent,
    timestamp: Date.now(),
    metadata,
  });
}

function sensitiveEnvValues(env: NodeJS.ProcessEnv = process.env): string[] {
  const names = /(?:KEY|TOKEN|SECRET|PASS|PASSWORD|CREDENTIAL|AUTH|DATABASE_URL)/i;
  const values = new Set<string>();
  for (const [key, value] of Object.entries(env)) {
    if (!value || value.length < 4 || !names.test(key)) continue;
    values.add(value);
  }
  return [...values].sort((a, b) => b.length - a.length);
}

export function sanitizeOutput(value: string): string {
  let sanitized = value.replace(/\S*\.dsh\/\.credentials\.yaml/g, '[DSH credentials file]');
  sanitized = sanitized.replace(/([A-Za-z0-9_.-]*(?:key|token|secret|password|credential|auth)[A-Za-z0-9_.-]*\s*[:=]\s*)(["']?)[^\s"',]+/gi, '$1$2[redacted]');
  for (const secret of sensitiveEnvValues()) {
    sanitized = sanitized.split(secret).join('[redacted]');
  }
  return sanitized;
}

export class LocalOpenAIProvider implements AgentProvider {
  readonly name = 'local-openai' as AgentProvider['name'];
  readonly displayName: string;
  readonly model: string;
  private readonly config: LocalOpenAIConfig;
  private readonly spawnCommand: SpawnCommand;

  constructor(args: { env?: NodeJS.ProcessEnv; spawnCommand?: SpawnCommand } = {}) {
    const config = getLocalOpenAIConfig(args.env ?? process.env);
    if (!config) {
      throw new Error('DSH_LAUNCHER_PATH is required');
    }
    this.config = config;
    this.displayName = config.displayName;
    this.model = config.model ?? 'DeepSeek Harness';
    this.spawnCommand = args.spawnCommand ?? spawn;
  }

  async start(): Promise<void> {
    const validationError = launcherValidationError(this.config.launcherPath);
    if (validationError) {
      throw new Error(validationError);
    }
  }

  async stop(): Promise<void> {}

  async createSession(config: AgentSessionConfig): Promise<AgentSession> {
    return new LocalOpenAISession(this.config, this.spawnCommand, config);
  }
}

class LocalOpenAISession implements AgentSession {
  readonly sessionId = uuid();
  private child: SpawnedProcess | null = null;
  private aborted = false;
  private killTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly localConfig: LocalOpenAIConfig,
    private readonly spawnCommand: SpawnCommand,
    private readonly sessionConfig: AgentSessionConfig,
  ) {}

  async execute(prompt: string, attachments?: AgentAttachment[]): Promise<AgentResult> {
    const taskText = this.userContent([
      this.sessionConfig.systemPrompt.trim(),
      prompt,
    ].filter(Boolean).join('\n\n'), attachments);
    emit(this.sessionConfig, 'command', `DeepSeek Harness headless started with profile ${this.localConfig.profile}.`, {
      agentType: LOCAL_AGENT_TYPE,
      command: 'dsh headless',
    });

    try {
      const result = await this.runHeadless(taskText);
      if (result.status === 'failed') {
        emit(this.sessionConfig, 'error', result.error ?? 'DeepSeek Harness failed.', {
          agentType: LOCAL_AGENT_TYPE,
          command: 'dsh headless',
          error: result.error,
        });
      }
      return result;
    } catch (err: unknown) {
      const message = sanitizeOutput(errorMessage(err));
      emit(this.sessionConfig, 'error', message, {
        agentType: LOCAL_AGENT_TYPE,
        command: 'dsh headless',
        error: message,
      });
      return { status: 'failed', error: message };
    } finally {
      this.clearKillTimer();
      this.child = null;
    }
  }

  async send(): Promise<void> {
    throw new Error('Local AI headless execution does not support follow-up messages while a task is running.');
  }

  async abort(): Promise<void> {
    this.aborted = true;
    this.terminateChild();
  }

  async destroy(): Promise<void> {
    this.aborted = true;
    this.terminateChild();
  }

  private userContent(prompt: string, attachments?: AgentAttachment[]): string {
    if (!attachments?.length) return prompt;
    const names = attachments.map((attachment) => attachment.displayName ?? attachment.path ?? attachment.type).join(', ');
    return `${prompt}\n\nAttachments available to Agent Board but not directly readable by DeepSeek Harness headless: ${names}`;
  }

  private async runHeadless(taskText: string): Promise<AgentResult> {
    const child = this.spawnCommand('node', [
      this.localConfig.launcherPath,
      '--profile',
      this.localConfig.profile,
      taskText,
    ], {
      cwd: this.sessionConfig.workingDirectory,
      env: {
        ...process.env,
        DSH_HOME: this.localConfig.dshHome,
        DSH_PROFILE: this.localConfig.profile,
      },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.child = child;

    child.stdout?.on('data', (chunk: Buffer | string) => {
      emit(this.sessionConfig, 'output', chunk.toString(), {
        agentType: LOCAL_AGENT_TYPE,
        command: 'dsh stdout',
      });
    });
    child.stderr?.on('data', (chunk: Buffer | string) => {
      emit(this.sessionConfig, 'command_output', chunk.toString(), {
        agentType: LOCAL_AGENT_TYPE,
        command: 'dsh stderr',
      });
    });

    return await new Promise<AgentResult>((resolve) => {
      let settled = false;
      const settle = (result: AgentResult) => {
        if (settled) return;
        settled = true;
        resolve(result);
      };

      child.once('error', (err: Error) => {
        settle({ status: 'failed', error: `DeepSeek Harness failed to start: ${sanitizeOutput(errorMessage(err))}` });
      });

      child.once('close', (code: number | null, signal: NodeJS.Signals | null) => {
        if (this.aborted) {
          settle({ status: 'failed', error: 'DeepSeek Harness execution was cancelled.' });
          return;
        }
        if (code === 0) {
          settle({ status: 'complete' });
          return;
        }
        const exit = code == null ? `signal ${signal ?? 'unknown'}` : `exit code ${code}`;
        settle({ status: 'failed', error: `DeepSeek Harness exited with ${exit}.` });
      });
    });
  }

  private terminateChild(): void {
    const child = this.child;
    if (!child || child.killed) return;
    child.kill('SIGTERM');
    this.killTimer = setTimeout(() => {
      if (!child.killed) child.kill('SIGKILL');
    }, TERMINATION_GRACE_MS);
  }

  private clearKillTimer(): void {
    if (!this.killTimer) return;
    clearTimeout(this.killTimer);
    this.killTimer = null;
  }
}
