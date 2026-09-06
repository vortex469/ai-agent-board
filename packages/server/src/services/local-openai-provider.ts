import { spawn } from 'child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import path from 'path';
import { zstdDecompressSync } from 'zlib';
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
const SESSION_POLL_MS = 250;
const SESSION_ASSOCIATION_SKEW_MS = 5_000;
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
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

function numberField(record: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return undefined;
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

type AgentEventMetadataWithDsh = AgentEventMetadata & {
  callId?: string;
  toolName?: string;
  state?: 'running' | 'succeeded' | 'failed';
  operation?: string;
  finalOutput?: boolean;
};

type NormalizedHarnessEvent = {
  type: AgentEvent['type'];
  content: string;
  metadata?: AgentEventMetadataWithDsh;
};

function parseArguments(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    try {
      return asRecord(JSON.parse(value)) ?? {};
    } catch {
      return { raw: value };
    }
  }
  return asRecord(value) ?? {};
}

function withoutPrivateFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutPrivateFields);
  const record = asRecord(value);
  if (!record) return value;
  const filtered: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(record)) {
    if (/^(reasoning|thoughts?|analysis|chainOfThought|chain_of_thought|cot)$/i.test(key)) continue;
    filtered[key] = withoutPrivateFields(entry);
  }
  return filtered;
}

function dshMetadata(extra?: AgentEventMetadataWithDsh): AgentEventMetadata {
  return metadata(extra as AgentEventMetadata) as AgentEventMetadata;
}

export function dshProjectDirectoryName(cwd: string): string {
  const normalized = path.resolve(cwd).replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/g, '');
  return `--${normalized.replace(/\/+/g, '-')}--`;
}

function zstdMagicPositions(buffer: Buffer): number[] {
  const positions: number[] = [];
  for (let index = 0; index <= buffer.length - ZSTD_MAGIC.length; index++) {
    if (
      buffer[index] === ZSTD_MAGIC[0] &&
      buffer[index + 1] === ZSTD_MAGIC[1] &&
      buffer[index + 2] === ZSTD_MAGIC[2] &&
      buffer[index + 3] === ZSTD_MAGIC[3]
    ) {
      positions.push(index);
    }
  }
  return positions;
}

export function decodeDurableZstdFrames(buffer: Buffer): { text: string; bytesConsumed: number } {
  const positions = zstdMagicPositions(buffer);
  const chunks: string[] = [];
  let positionIndex = 0;
  let bytesConsumed = 0;

  while (positionIndex < positions.length) {
    const start = positions[positionIndex];
    let decoded = false;
    for (let nextIndex = positionIndex + 1; nextIndex <= positions.length; nextIndex++) {
      const end = nextIndex < positions.length ? positions[nextIndex] : buffer.length;
      try {
        const decodedText = zstdDecompressSync(buffer.subarray(start, end)).toString('utf8');
        if (!decodedText.endsWith('\n')) throw new Error('Incomplete DSH SessionEvent frame');
        chunks.push(decodedText);
        bytesConsumed = end;
        positionIndex = nextIndex;
        decoded = true;
        break;
      } catch {
        // Appending sessions can expose a partial final frame. Apparent magic
        // bytes inside compressed data are handled by trying later boundaries.
      }
    }
    if (!decoded) break;
  }

  return { text: chunks.join(''), bytesConsumed };
}

function extractText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(extractText).filter(Boolean).join('');
  const record = asRecord(value);
  if (!record) return '';
  if (typeof record.text === 'string') return record.text;
  if (typeof record.content === 'string') return record.content;
  if (Array.isArray(record.content)) return extractText(record.content);
  if (typeof record.message === 'string') return record.message;
  return '';
}

function toolResultDetails(record: Record<string, unknown>): {
  callId?: string;
  output: string;
  failed: boolean;
  error?: string;
} {
  const data = asRecord(record.data) ?? record;
  const message = asRecord(data.message);
  const source = message ? asRecord(message.source) : null;
  let callId = stringField(data, ['callId']);
  if (!callId && source) callId = stringField(source, ['callId']);

  const content = message?.content ?? data.message ?? data.content;
  let failed = Boolean(data.error);
  let output = extractText(content);
  let resultCallId: string | undefined;

  if (Array.isArray(content)) {
    for (const item of content) {
      const itemRecord = asRecord(item);
      if (!itemRecord) continue;
      resultCallId = resultCallId ?? stringField(itemRecord, ['toolCallId', 'callId']);
      if (itemRecord.isError === true || typeof itemRecord.error === 'string') failed = true;
    }
  }

  callId = callId ?? resultCallId;
  const error = stringField(data, ['error']) ?? (failed ? stringField(data, ['message']) : undefined);
  if (!output && error) output = error;
  return { callId, output, failed, error };
}

function toolOutputDetails(record: Record<string, unknown>): {
  callId?: string;
  output: string;
  stream?: string;
} {
  const data = asRecord(record.data) ?? record;
  const callId = stringField(data, ['callId', 'toolCallId', 'tool_call_id']);
  const stream = stringField(data, ['stream', 'fd', 'source', 'name']);
  const nested = nestedRecord(data, ['chunk', 'delta', 'output', 'payload', 'message']);
  const output =
    stringField(data, ['text', 'content', 'output', 'stdout', 'stderr', 'delta']) ??
    (nested ? stringField(nested, ['text', 'content', 'output', 'stdout', 'stderr', 'delta']) : undefined) ??
    extractText(data.content ?? data.output ?? data.message);
  return { callId, output: output ?? '', stream };
}

function testLike(command: string | undefined, toolName: string): boolean {
  return /\b(test|tests|pytest|vitest|playwright|jest|mocha|npm\s+(?:run\s+)?test|gate:required)\b/i
    .test(`${toolName} ${command ?? ''}`);
}

function searchLike(command: string | undefined, toolName: string): boolean {
  return /\b(grep|rg|ripgrep|search|find|glob|fd)\b/i.test(`${toolName} ${command ?? ''}`);
}

function searchCommandFromArgs(toolName: string, args: Record<string, unknown>, file?: string): string {
  const query = stringField(args, ['pattern', 'query', 'needle', 'text', 'regex']);
  return [toolName, query, file].filter(Boolean).join(' ');
}

function normalizeToolCall(record: Record<string, unknown>): NormalizedHarnessEvent[] {
  const data = asRecord(record.data) ?? record;
  const callId = stringField(data, ['callId']);
  const toolName = stringField(data, ['name', 'tool', 'toolName', 'tool_name']) ?? 'tool';
  const args = parseArguments(data.arguments ?? data.args);
  let command = commandFromRecord({ ...data, arguments: args });
  const file = fileFromRecord({ ...data, arguments: args });
  if (!command && searchLike(undefined, toolName)) command = searchCommandFromArgs(toolName, args, file);
  const operation = toolName.toLowerCase();
  const base = dshMetadata({ callId, toolName, command, file, state: 'running', operation });

  if (/^(bash|shell|exec|command)$/i.test(toolName) || command) {
    const label = searchLike(command, toolName) && !/^(bash|shell)$/i.test(toolName) ? 'search' : toolName;
    return [{ type: 'command', content: `${label}: ${JSON.stringify({ command: command ?? recordContent(args, toolName) })}`, metadata: base }];
  }
  if (/(read|open|view)/i.test(toolName) && file) {
    return [{ type: 'file_read', content: `Read ${file}`, metadata: base }];
  }
  if (/(write|create|save)/i.test(toolName) && file) {
    return [{ type: 'file_write', content: `Wrote ${file}`, metadata: base }];
  }
  if (/(edit|replace|patch|modify|update)/i.test(toolName) && file) {
    return [{ type: 'file_edit', content: `Edited ${file}`, metadata: base }];
  }
  if (searchLike(command, toolName)) {
    return [{ type: 'command', content: `search: ${JSON.stringify({ command: command ?? recordContent(args, toolName) })}`, metadata: base }];
  }
  return [{ type: 'tool_call', content: JSON.stringify({ name: toolName, arguments: withoutPrivateFields(args) }), metadata: base }];
}

function normalizeToolResult(record: Record<string, unknown>, calls: Map<string, { toolName: string; command?: string }>): NormalizedHarnessEvent[] {
  const { callId, output, failed, error } = toolResultDetails(record);
  const call = callId ? calls.get(callId) : undefined;
  const toolName = call?.toolName ?? 'tool';
  const command = call?.command;
  const base = dshMetadata({
    callId,
    toolName,
    command,
    state: failed ? 'failed' : 'succeeded',
    operation: toolName.toLowerCase(),
    error: error ?? (failed ? output : undefined),
  });
  if (testLike(command, toolName)) {
    return [
      { type: 'command_output', content: output, metadata: base },
      { type: 'test_result', content: output || (failed ? 'Test command failed.' : 'Test command completed.'), metadata: base },
    ];
  }
  return [{ type: 'command_output', content: output || (failed ? 'Tool failed.' : 'Tool completed.'), metadata: base }];
}

function normalizeToolOutput(record: Record<string, unknown>, calls: Map<string, { toolName: string; command?: string }>): NormalizedHarnessEvent[] {
  const { callId, output, stream } = toolOutputDetails(record);
  if (!output) return [];
  const call = callId ? calls.get(callId) : undefined;
  const toolName = call?.toolName ?? stringField(asRecord(record.data) ?? record, ['name', 'tool', 'toolName', 'tool_name']) ?? 'tool';
  const command = call?.command ?? commandFromRecord(asRecord(record.data) ?? record);
  return [{
    type: 'command_output',
    content: output,
    metadata: dshMetadata({
      callId,
      toolName,
      command,
      state: 'running',
      operation: stream ? `${toolName.toLowerCase()}:${stream.toLowerCase()}` : toolName.toLowerCase(),
    }),
  }];
}

function isToolOutputType(type: string | undefined): boolean {
  return type === 'tool/output' ||
    type === 'tool/output_delta' ||
    type === 'tool/output-delta' ||
    type === 'tool/stream' ||
    type === 'tool/stdout' ||
    type === 'tool/stderr';
}

export function normalizeDshSessionEvent(
  record: Record<string, unknown>,
  calls: Map<string, { toolName: string; command?: string }> = new Map(),
): NormalizedHarnessEvent[] {
  const type = stringField(record, ['type']);
  if (type === 'tool/call') {
    const events = normalizeToolCall(record);
    const event = events[0];
    const callId = (event.metadata as AgentEventMetadataWithDsh | undefined)?.callId;
    const toolName = (event.metadata as AgentEventMetadataWithDsh | undefined)?.toolName;
    if (callId && toolName) calls.set(callId, { toolName, command: event.metadata?.command });
    return events;
  }
  if (isToolOutputType(type)) return normalizeToolOutput(record, calls);
  if (type === 'tool/result') return normalizeToolResult(record, calls);
  return [];
}

class DshSessionEventMonitor {
  private sessionFile: string | null = null;
  private offset = 0;
  private partial = '';
  private timer: ReturnType<typeof setInterval> | null = null;
  private warnedAmbiguous = false;
  private readonly emittedSeqs = new Set<string>();
  private readonly emittedCalls = new Set<string>();
  private readonly emittedResults = new Set<string>();
  private readonly calls = new Map<string, { toolName: string; command?: string }>();

  constructor(
    private readonly config: AgentSessionConfig,
    private readonly dshHome: string,
    private readonly launchTime: number,
  ) {}

  start(): void {
    void this.poll();
    this.timer = setInterval(() => void this.poll(), SESSION_POLL_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    void this.poll();
  }

  private async poll(): Promise<void> {
    if (!this.sessionFile) this.sessionFile = this.findSessionFile();
    if (!this.sessionFile) return;
    let buffer: Buffer;
    try {
      buffer = readFileSync(this.sessionFile);
    } catch {
      return;
    }
    if (buffer.length <= this.offset) return;
    const { text, bytesConsumed } = decodeDurableZstdFrames(buffer.subarray(this.offset));
    if (bytesConsumed <= 0) return;
    this.offset += bytesConsumed;
    this.consumeText(text);
  }

  private findSessionFile(): string | null {
    const projectDir = path.join(this.dshHome, 'sessions', dshProjectDirectoryName(this.config.workingDirectory));
    if (!existsSync(projectDir)) return null;
    let sessionDirs: string[];
    try {
      sessionDirs = readdirSync(projectDir);
    } catch {
      return null;
    }

    const matches: string[] = [];
    for (const sessionDir of sessionDirs) {
      const sessionFile = path.join(projectDir, sessionDir, 'session.jsonl.zstd');
      if (!existsSync(sessionFile)) continue;
      let stat;
      try {
        stat = statSync(sessionFile);
      } catch {
        continue;
      }
      if (stat.mtimeMs + SESSION_ASSOCIATION_SKEW_MS < this.launchTime) continue;
      if (this.sessionCwd(sessionFile) === path.resolve(this.config.workingDirectory)) matches.push(sessionFile);
    }

    if (matches.length === 1) return matches[0];
    if (matches.length > 1 && !this.warnedAmbiguous) {
      this.warnedAmbiguous = true;
      emit(this.config, 'error', 'DeepSeek Harness session association is ambiguous; live DSH operational events are disabled for this run.', {
        agentType: LOCAL_AGENT_TYPE,
        command: 'dsh session monitor',
      });
    }
    return null;
  }

  private sessionCwd(sessionFile: string): string | null {
    try {
      const { text } = decodeDurableZstdFrames(readFileSync(sessionFile));
      const firstLine = text.split(/\r?\n/, 1)[0]?.trim();
      if (!firstLine) return null;
      const record = asRecord(JSON.parse(firstLine));
      const cwd = record ? stringField(record, ['cwd']) : undefined;
      return cwd ? path.resolve(cwd) : null;
    } catch {
      return null;
    }
  }

  private consumeText(text: string): void {
    this.partial += text;
    const lines = this.partial.split(/\r?\n/);
    this.partial = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      this.consumeLine(line);
    }
  }

  private consumeLine(line: string): void {
    let record: Record<string, unknown> | null = null;
    try {
      record = asRecord(JSON.parse(line));
    } catch {
      return;
    }
    if (!record) return;
    const type = stringField(record, ['type']);
    if (type !== 'tool/call' && type !== 'tool/result' && !isToolOutputType(type)) return;
    const data = asRecord(record.data) ?? record;
    const callId = stringField(data, ['callId']) ?? toolResultDetails(record).callId;
    const seq = numberField(record, ['seq']) ?? numberField(record, ['seq0']);
    const seqKey = seq === undefined ? undefined : `${type}:${seq}`;
    if (seqKey && this.emittedSeqs.has(seqKey)) return;
    if (type === 'tool/call' && callId && this.emittedCalls.has(callId)) return;
    if (type === 'tool/result' && callId && this.emittedResults.has(callId)) return;

    const events = normalizeDshSessionEvent(record, this.calls);
    if (!events.length) return;
    if (seqKey) this.emittedSeqs.add(seqKey);
    if (type === 'tool/call' && callId) this.emittedCalls.add(callId);
    if (type === 'tool/result' && callId) this.emittedResults.add(callId);
    for (const event of events) emit(this.config, event.type, event.content, event.metadata);
  }
}

class StdoutFinalOutput {
  private buffered = '';

  constructor(private readonly config: AgentSessionConfig) {}

  write(chunk: Buffer | string): void {
    this.buffered += chunk.toString();
    if (this.buffered.length > MAX_PARTIAL_RECORD_LENGTH) {
      this.buffered = this.buffered.slice(-MAX_PARTIAL_RECORD_LENGTH);
    }
  }

  flush(): void {
    const content = this.buffered.trim();
    this.buffered = '';
    if (!content) return;
    emit(this.config, 'output', content.endsWith('\n') ? content : `${content}\n`, dshMetadata({
      command: 'dsh stdout',
      finalOutput: true,
    }));
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
    emit(this.sessionConfig, 'command', `DeepSeek Harness headless started with profile ${this.localConfig.profile}.`, dshMetadata({
      agentType: LOCAL_AGENT_TYPE,
      command: 'dsh headless',
      state: 'running',
    }));

    try {
      const result = await this.runHeadless(taskText);
      if (result.status === 'failed') {
        emit(this.sessionConfig, 'error', result.error ?? 'DeepSeek Harness failed.', dshMetadata({
          agentType: LOCAL_AGENT_TYPE,
          command: 'dsh headless',
          state: 'failed',
          error: result.error,
        }));
      }
      return result;
    } catch (err: unknown) {
      const message = sanitizeOutput(errorMessage(err));
      emit(this.sessionConfig, 'error', message, dshMetadata({
        agentType: LOCAL_AGENT_TYPE,
        command: 'dsh headless',
        state: 'failed',
        error: message,
      }));
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
    const launchTime = Date.now();
    const monitor = new DshSessionEventMonitor(this.sessionConfig, this.localConfig.dshHome, launchTime);
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
    const stdout = new StdoutFinalOutput(this.sessionConfig);
    monitor.start();

    child.stdout?.on('data', (chunk: Buffer | string) => {
      stdout.write(chunk);
    });

    return await new Promise<AgentResult>((resolve) => {
      let settled = false;
      let cleanedUp = false;
      const cleanup = () => {
        if (cleanedUp) return;
        cleanedUp = true;
        monitor.stop();
        stdout.flush();
      };
      const settle = (result: AgentResult) => {
        if (settled) return;
        settled = true;
        cleanup();
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
