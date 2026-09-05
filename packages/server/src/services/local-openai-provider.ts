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
const MAX_PARTIAL_RECORD_LENGTH = 32_000;
const AGENT_EVENT_TYPES = new Set<AgentEvent['type']>([
  'thinking',
  'tool_call',
  'file_read',
  'file_write',
  'file_edit',
  'command',
  'command_output',
  'output',
  'test_result',
  'error',
  'complete',
]);

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

function metadata(extra?: AgentEventMetadata): AgentEventMetadata {
  return { agentType: LOCAL_AGENT_TYPE, ...extra };
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

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringField(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  }
  return undefined;
}

function nestedRecord(record: Record<string, unknown>, keys: string[]): Record<string, unknown> | null {
  for (const key of keys) {
    const nested = asRecord(record[key]);
    if (nested) return nested;
  }
  return null;
}

function stripHarnessPrefix(line: string): string {
  const trimmed = line.trim();
  const withoutAnsi = trimmed.replace(/\x1b\[[0-9;]*m/g, '');
  if (withoutAnsi.startsWith('data:')) return withoutAnsi.slice('data:'.length).trim();
  if (withoutAnsi.startsWith('[dsh]')) return withoutAnsi.slice('[dsh]'.length).trim();
  if (withoutAnsi.startsWith('DSH:')) return withoutAnsi.slice('DSH:'.length).trim();
  return withoutAnsi;
}

function parseJsonRecord(line: string): Record<string, unknown> | null {
  const payload = stripHarnessPrefix(line);
  if (!payload || payload === '[DONE]') return null;
  if (!payload.startsWith('{') && !payload.startsWith('[')) return null;
  try {
    const parsed = JSON.parse(payload);
    const record = asRecord(parsed);
    if (record) return record;
    if (Array.isArray(parsed) && parsed.length === 1) return asRecord(parsed[0]);
  } catch {
    return null;
  }
  return null;
}

function directEventType(value: string | undefined): AgentEvent['type'] | null {
  if (!value) return null;
  const normalized = value.toLowerCase().replace(/[-\s]/g, '_');
  return AGENT_EVENT_TYPES.has(normalized as AgentEvent['type'])
    ? normalized as AgentEvent['type']
    : null;
}

function eventKind(record: Record<string, unknown>): string {
  return [
    stringField(record, ['type', 'event', 'kind', 'action', 'name', 'status']),
    stringField(record, ['tool', 'toolName', 'tool_name', 'operation', 'currentOperation', 'current_operation']),
  ].filter(Boolean).join(' ').toLowerCase();
}

function containsPrivateReasoning(record: Record<string, unknown>): boolean {
  const kind = eventKind(record);
  if (/\b(reasoning|thought|chain_of_thought|cot|analysis)\b/.test(kind)) return true;
  return ['reasoning', 'thought', 'thoughts', 'analysis', 'chainOfThought', 'chain_of_thought']
    .some((key) => typeof record[key] === 'string' && String(record[key]).trim().length > 0);
}

function withoutPrivateReasoning(record: Record<string, unknown>): Record<string, unknown> {
  const filtered: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (/^(reasoning|thoughts?|analysis|chainOfThought|chain_of_thought)$/i.test(key)) continue;
    filtered[key] = value;
  }
  return filtered;
}

function operationContent(args: {
  kind: string;
  command?: string;
  file?: string;
  tool?: string;
}): string {
  if (args.command) return args.command;
  if (args.file) {
    if (/(read|open|view)/.test(args.kind)) return `Read ${args.file}`;
    if (/(write|create|created|save)/.test(args.kind)) return `Wrote ${args.file}`;
    if (/(edit|patch|modify|modified|update|updated)/.test(args.kind)) return `Edited ${args.file}`;
    return args.file;
  }
  return args.tool ?? 'Harness activity';
}

function recordContent(record: Record<string, unknown>, fallback = ''): string {
  const nested = nestedRecord(record, ['data', 'payload', 'message', 'item', 'event']);
  const content = stringField(record, ['content', 'text', 'message', 'summary', 'description', 'output', 'result', 'title']);
  if (content) return content;
  if (nested) {
    const nestedContent = stringField(nested, ['content', 'text', 'message', 'summary', 'description', 'output', 'result', 'title']);
    if (nestedContent) return nestedContent;
  }
  return fallback || JSON.stringify(record);
}

function commandFromRecord(record: Record<string, unknown>): string | undefined {
  const direct = stringField(record, ['command', 'cmd', 'shellCommand', 'shell_command']);
  if (direct) return direct;
  for (const key of ['args', 'arguments', 'input', 'parameters']) {
    const nested = asRecord(record[key]);
    if (!nested) continue;
    const nestedCommand = stringField(nested, ['command', 'cmd', 'shellCommand', 'shell_command']);
    if (nestedCommand) return nestedCommand;
  }
  return undefined;
}

function fileFromRecord(record: Record<string, unknown>): string | undefined {
  const direct = stringField(record, ['file', 'path', 'filePath', 'file_path', 'filename']);
  if (direct) return direct;
  for (const key of ['args', 'arguments', 'input', 'parameters']) {
    const nested = asRecord(record[key]);
    if (!nested) continue;
    const nestedFile = stringField(nested, ['file', 'path', 'filePath', 'file_path', 'filename']);
    if (nestedFile) return nestedFile;
  }
  return undefined;
}

function classifyHarnessJson(record: Record<string, unknown>): Array<{ type: AgentEvent['type']; content: string; metadata?: AgentEventMetadata }> {
  const nested = nestedRecord(record, ['data', 'payload', 'message', 'item', 'event']);
  const source = nested ? { ...record, ...nested } : record;
  const kind = eventKind(source);
  const command = commandFromRecord(source);
  const file = fileFromRecord(source);
  const tool = stringField(source, ['tool', 'toolName', 'tool_name', 'name']);
  const hasPrivateReasoning = containsPrivateReasoning(source);
  const displaySource = hasPrivateReasoning ? withoutPrivateReasoning(source) : source;
  const content = hasPrivateReasoning
    ? operationContent({ kind, command, file, tool })
    : recordContent(displaySource);

  if (hasPrivateReasoning && !command && !file && !tool) return [];

  const directType = directEventType(stringField(source, ['agentEventType', 'agent_event_type', 'eventType', 'event_type']));
  if (directType && directType !== 'thinking') {
    return [{ type: directType, content, metadata: metadata({ command, file }) }];
  }

  if (/(test|pytest|vitest|playwright|validation|gate)/.test(`${kind} ${command ?? ''}`) && /\b(pass|passed|fail|failed|result|complete|completed|success|error)\b/.test(`${kind} ${content}`)) {
    return [{ type: 'test_result', content, metadata: metadata({ command }) }];
  }

  if (/(read|open|view)/.test(kind) && file) {
    return [{ type: 'file_read', content, metadata: metadata({ file }) }];
  }
  if (/(write|create|created|save)/.test(kind) && file) {
    return [{ type: 'file_write', content, metadata: metadata({ file }) }];
  }
  if (/(edit|patch|modify|modified|update|updated)/.test(kind) && file) {
    return [{ type: 'file_edit', content, metadata: metadata({ file }) }];
  }
  if (/(shell|bash|command|exec|run|running)/.test(kind) && command) {
    return [{ type: 'command', content: `bash: ${JSON.stringify({ command, description: content === command ? undefined : content })}`, metadata: metadata({ command }) }];
  }
  if (/(search|grep|rg|find|glob|list)/.test(kind)) {
    const searchCommand = command ?? content;
    return [{ type: 'command', content: `search: ${JSON.stringify({ command: searchCommand })}`, metadata: metadata({ command: searchCommand }) }];
  }
  if (tool) {
    return [{ type: 'tool_call', content: JSON.stringify(displaySource), metadata: metadata({ command: tool, file }) }];
  }
  return [];
}

function classifyHarnessText(line: string): Array<{ type: AgentEvent['type']; content: string; metadata?: AgentEventMetadata }> {
  const content = stripHarnessPrefix(line);
  const fileRead = content.match(/^(?:read|reading|opened|viewed)(?:\s+file)?[:\s]+(.+)$/i);
  if (fileRead) return [{ type: 'file_read', content, metadata: metadata({ file: fileRead[1].trim() }) }];
  const fileWrite = content.match(/^(?:write|writing|wrote|created|saved)(?:\s+file)?[:\s]+(.+)$/i);
  if (fileWrite) return [{ type: 'file_write', content, metadata: metadata({ file: fileWrite[1].trim() }) }];
  const fileEdit = content.match(/^(?:edit|editing|edited|modified|patched|applying patch to)(?:\s+file)?[:\s]+(.+)$/i);
  if (fileEdit) return [{ type: 'file_edit', content, metadata: metadata({ file: fileEdit[1].trim() }) }];
  const command = content.match(/^(?:running|run|executing|execute)(?:\s+command)?[:\s]+(.+)$/i) ?? content.match(/^\$\s+(.+)$/);
  if (command) return [{ type: 'command', content: `bash: ${JSON.stringify({ command: command[1].trim() })}`, metadata: metadata({ command: command[1].trim() }) }];
  const search = content.match(/^(?:searching|search|grep|rg|finding|find)(?::|\s+for)?\s+(.+)$/i);
  if (search) return [{ type: 'command', content: `search: ${JSON.stringify({ command: search[1].trim() })}`, metadata: metadata({ command: search[1].trim() }) }];
  if (/\b(?:tests?|validation|gate)\b.*\b(?:passed|failed|complete|completed|succeeded|errored)\b/i.test(content)) {
    return [{ type: 'test_result', content, metadata: metadata() }];
  }
  return [];
}

function emitHarnessRecord(config: AgentSessionConfig, stream: 'stdout' | 'stderr', line: string): void {
  const json = parseJsonRecord(line);
  const events = json ? classifyHarnessJson(json) : classifyHarnessText(line);
  if (events.length > 0) {
    for (const event of events) emit(config, event.type, event.content, event.metadata);
    return;
  }
  emit(config, stream === 'stdout' ? 'output' : 'command_output', line.endsWith('\n') ? line : `${line}\n`, metadata({
    command: stream === 'stdout' ? 'dsh stdout' : 'dsh stderr',
  }));
}

class HarnessOutputStream {
  private buffered = '';

  constructor(
    private readonly config: AgentSessionConfig,
    private readonly stream: 'stdout' | 'stderr',
  ) {}

  write(chunk: Buffer | string): void {
    this.buffered += chunk.toString();
    let separatorIndex = this.nextSeparatorIndex();
    while (separatorIndex >= 0) {
      const record = this.buffered.slice(0, separatorIndex);
      const separatorLength = this.buffered[separatorIndex] === '\r' && this.buffered[separatorIndex + 1] === '\n' ? 2 : 1;
      this.buffered = this.buffered.slice(separatorIndex + separatorLength);
      if (record.trim()) emitHarnessRecord(this.config, this.stream, record);
      separatorIndex = this.nextSeparatorIndex();
    }
    if (this.buffered.length > MAX_PARTIAL_RECORD_LENGTH) {
      emitHarnessRecord(this.config, this.stream, this.buffered);
      this.buffered = '';
    }
  }

  flush(): void {
    if (!this.buffered.trim()) {
      this.buffered = '';
      return;
    }
    emitHarnessRecord(this.config, this.stream, this.buffered);
    this.buffered = '';
  }

  private nextSeparatorIndex(): number {
    const newline = this.buffered.indexOf('\n');
    const carriage = this.buffered.indexOf('\r');
    if (newline < 0) return carriage;
    if (carriage < 0) return newline;
    return Math.min(newline, carriage);
  }
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
    const stdout = new HarnessOutputStream(this.sessionConfig, 'stdout');
    const stderr = new HarnessOutputStream(this.sessionConfig, 'stderr');

    child.stdout?.on('data', (chunk: Buffer | string) => {
      stdout.write(chunk);
    });
    child.stderr?.on('data', (chunk: Buffer | string) => {
      stderr.write(chunk);
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
        stdout.flush();
        stderr.flush();
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
