import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';
import { v4 as uuid } from 'uuid';
import type {
  AgentAttachment,
  AgentProvider,
  AgentResult,
  AgentSession,
  AgentSessionConfig,
} from '@codewithdan/agent-sdk-core';
import type { AgentEvent, AgentEventMetadata } from '@codewithdan/agent-sdk-core';
import type { AgentInfo } from '../types.js';
import { errorMessage } from '../utils.js';

const execFileAsync = promisify(execFile);
const DEFAULT_MAX_TOKENS = 4096;
const MAX_TOOL_TURNS = 40;
const MAX_FILE_BYTES = 512 * 1024;
const MAX_COMMAND_OUTPUT = 128 * 1024;
const MAX_COMMAND_TIMEOUT_MS = 120_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 60_000;

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

interface LocalOpenAIConfig {
  baseUrl: string;
  model: string;
  apiKey?: string;
  displayName: string;
  maxTokens: number;
}

interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
}

interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

interface ModelStep {
  content: string;
  reasoning: string;
  toolCalls: ToolCall[];
}

interface ToolResult {
  ok: boolean;
  content?: unknown;
  error?: string;
}

interface ToolCallAccumulator {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

function trimEnv(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/, '');
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function getLocalOpenAIConfig(env: NodeJS.ProcessEnv = process.env): LocalOpenAIConfig | null {
  const baseUrl = trimEnv(env.LOCAL_OPENAI_BASE_URL);
  const model = trimEnv(env.LOCAL_OPENAI_MODEL);
  if (!baseUrl || !model) return null;
  return {
    baseUrl: normalizeBaseUrl(baseUrl),
    model,
    apiKey: trimEnv(env.LOCAL_OPENAI_API_KEY),
    displayName: trimEnv(env.LOCAL_OPENAI_DISPLAY_NAME) ?? 'Local AI',
    maxTokens: parsePositiveInteger(env.LOCAL_OPENAI_MAX_TOKENS, DEFAULT_MAX_TOKENS),
  };
}

function authHeaders(config: Pick<LocalOpenAIConfig, 'apiKey'>): Record<string, string> {
  return config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {};
}

export async function detectLocalOpenAIAgent(args: {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: FetchLike;
} = {}): Promise<AgentInfo> {
  const config = getLocalOpenAIConfig(args.env ?? process.env);
  const displayName = trimEnv(args.env?.LOCAL_OPENAI_DISPLAY_NAME) ?? 'Local AI';
  if (!config) {
    return {
      name: 'local-openai',
      displayName,
      available: false,
      reason: 'LOCAL_OPENAI_BASE_URL and LOCAL_OPENAI_MODEL are required',
    };
  }

  try {
    const fetchImpl = args.fetchImpl ?? fetch;
    const response = await fetchImpl(`${config.baseUrl}/models`, {
      method: 'GET',
      headers: authHeaders(config),
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) {
      return {
        name: 'local-openai',
        displayName: config.displayName,
        available: false,
        reason: `/models probe failed with HTTP ${response.status}`,
      };
    }
    return {
      name: 'local-openai',
      displayName: config.displayName,
      available: true,
      version: config.model,
    };
  } catch (err: unknown) {
    return {
      name: 'local-openai',
      displayName: config.displayName,
      available: false,
      reason: `/models probe failed: ${errorMessage(err)}`,
    };
  }
}

function emit(config: AgentSessionConfig, type: AgentEvent['type'], content: string, metadata?: AgentEventMetadata): void {
  config.onEvent({
    id: uuid(),
    contextId: config.contextId,
    type,
    content,
    timestamp: Date.now(),
    metadata,
  });
}

function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

function isLikelyPath(value: string): boolean {
  return value.includes('/') || value.includes('\\') || value === '..' || value.startsWith('.');
}

function parseJsonObject(value: string): Record<string, unknown> {
  const parsed = JSON.parse(value || '{}') as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('tool arguments must be a JSON object');
  }
  return parsed as Record<string, unknown>;
}

function stringArg(args: Record<string, unknown>, key: string, fallback = ''): string {
  const value = args[key];
  return typeof value === 'string' ? value : fallback;
}

function booleanArg(args: Record<string, unknown>, key: string, fallback = false): boolean {
  const value = args[key];
  return typeof value === 'boolean' ? value : fallback;
}

function numberArg(args: Record<string, unknown>, key: string, fallback: number): number {
  const value = args[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export class LocalOpenAIToolbox {
  private rootReal: string | null = null;

  constructor(private readonly workingDirectory: string) {}

  private async root(): Promise<string> {
    if (!this.rootReal) {
      this.rootReal = await fs.promises.realpath(this.workingDirectory);
    }
    return this.rootReal;
  }

  private async resolveExistingPath(requestedPath: string): Promise<string> {
    const root = await this.root();
    const resolved = path.resolve(root, requestedPath || '.');
    if (!isInside(root, resolved)) {
      throw new Error('path escapes working directory');
    }
    const real = await fs.promises.realpath(resolved);
    if (!isInside(root, real)) {
      throw new Error('path escapes working directory');
    }
    return real;
  }

  private async resolveWritablePath(requestedPath: string): Promise<string> {
    if (!requestedPath.trim()) throw new Error('path is required');
    const root = await this.root();
    const resolved = path.resolve(root, requestedPath);
    if (!isInside(root, resolved)) {
      throw new Error('path escapes working directory');
    }
    const parentReal = await fs.promises.realpath(path.dirname(resolved));
    if (!isInside(root, parentReal)) {
      throw new Error('path escapes working directory');
    }
    if (fs.existsSync(resolved)) {
      const real = await fs.promises.realpath(resolved);
      if (!isInside(root, real)) {
        throw new Error('path escapes working directory');
      }
    }
    return resolved;
  }

  async listFiles(args: Record<string, unknown>): Promise<ToolResult> {
    const dir = await this.resolveExistingPath(stringArg(args, 'directory', '.'));
    const recursive = booleanArg(args, 'recursive');
    const root = await this.root();
    const results: string[] = [];
    const visit = async (current: string): Promise<void> => {
      const entries = await fs.promises.readdir(current, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name === '.git' || entry.name === 'node_modules') continue;
        const full = path.join(current, entry.name);
        const relative = path.relative(root, full);
        results.push(entry.isDirectory() ? `${relative}/` : relative);
        if (entry.isDirectory() && recursive && results.length < 500) {
          await visit(full);
        }
        if (results.length >= 500) return;
      }
    };
    await visit(dir);
    return { ok: true, content: { files: results } };
  }

  async searchFiles(args: Record<string, unknown>): Promise<ToolResult> {
    const query = stringArg(args, 'query').toLowerCase();
    if (!query) throw new Error('query is required');
    const dir = await this.resolveExistingPath(stringArg(args, 'directory', '.'));
    const root = await this.root();
    const matches: Array<{ file: string; line: number; text: string }> = [];

    const visit = async (current: string): Promise<void> => {
      const entries = await fs.promises.readdir(current, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name === '.git' || entry.name === 'node_modules') continue;
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) {
          await visit(full);
        } else if (entry.isFile()) {
          const stat = await fs.promises.stat(full);
          if (stat.size > MAX_FILE_BYTES) continue;
          const text = await fs.promises.readFile(full, 'utf8').catch(() => '');
          const lines = text.split(/\r?\n/);
          lines.forEach((line, index) => {
            if (matches.length < 100 && line.toLowerCase().includes(query)) {
              matches.push({ file: path.relative(root, full), line: index + 1, text: line.slice(0, 500) });
            }
          });
        }
        if (matches.length >= 100) return;
      }
    };
    await visit(dir);
    return { ok: true, content: { matches } };
  }

  async readFile(args: Record<string, unknown>): Promise<ToolResult> {
    const file = await this.resolveExistingPath(stringArg(args, 'path'));
    const stat = await fs.promises.stat(file);
    if (!stat.isFile()) throw new Error('path is not a file');
    if (stat.size > MAX_FILE_BYTES) throw new Error(`file exceeds ${MAX_FILE_BYTES} byte read limit`);
    const text = await fs.promises.readFile(file, 'utf8');
    const startLine = Math.max(1, Math.floor(numberArg(args, 'start_line', 1)));
    const maxLines = Math.min(1000, Math.max(1, Math.floor(numberArg(args, 'max_lines', 400))));
    const lines = text.split(/\r?\n/).slice(startLine - 1, startLine - 1 + maxLines);
    return { ok: true, content: { content: lines.join('\n'), start_line: startLine } };
  }

  async writeFile(args: Record<string, unknown>): Promise<ToolResult> {
    const requestedPath = stringArg(args, 'path');
    const content = stringArg(args, 'content');
    const file = await this.resolveWritablePath(requestedPath);
    await fs.promises.writeFile(file, content, 'utf8');
    return { ok: true, content: { path: requestedPath, bytes: Buffer.byteLength(content) } };
  }

  async replaceInFile(args: Record<string, unknown>): Promise<ToolResult> {
    const requestedPath = stringArg(args, 'path');
    const oldText = stringArg(args, 'old_text');
    const newText = stringArg(args, 'new_text');
    if (!oldText) throw new Error('old_text is required');
    const file = await this.resolveWritablePath(requestedPath);
    const current = await fs.promises.readFile(file, 'utf8');
    if (!current.includes(oldText)) throw new Error('old_text was not found');
    const next = current.replace(oldText, newText);
    await fs.promises.writeFile(file, next, 'utf8');
    return { ok: true, content: { path: requestedPath, replacements: 1 } };
  }

  private async validateCommand(command: string, args: string[]): Promise<void> {
    if (!command.trim()) throw new Error('command is required');
    if (/[;&|`$<>]/.test(command)) throw new Error('shell metacharacters are not allowed in command');
    const root = await this.root();
    if (isLikelyPath(command)) {
      const resolvedCommand = path.resolve(root, command);
      if (!isInside(root, resolvedCommand)) throw new Error('command path escapes working directory');
    }
    for (const arg of args) {
      if (/[`$]/.test(arg)) throw new Error('shell expansion is not allowed in command arguments');
      const valueParts = arg.includes('=') ? [arg.slice(arg.indexOf('=') + 1)] : [arg];
      for (const part of valueParts) {
        if (!isLikelyPath(part)) continue;
        const resolved = path.resolve(root, part);
        if (!isInside(root, resolved)) {
          throw new Error('command argument path escapes working directory');
        }
      }
    }
  }

  async runCommand(args: Record<string, unknown>, signal: AbortSignal): Promise<ToolResult> {
    const command = stringArg(args, 'command');
    const commandArgsRaw = args.args;
    const commandArgs = Array.isArray(commandArgsRaw)
      ? commandArgsRaw.map((arg) => String(arg))
      : [];
    await this.validateCommand(command, commandArgs);
    const timeoutMs = Math.min(
      MAX_COMMAND_TIMEOUT_MS,
      Math.max(1000, Math.floor(numberArg(args, 'timeout_ms', DEFAULT_COMMAND_TIMEOUT_MS))),
    );
    const started = Date.now();
    try {
      const result = await execFileAsync(command, commandArgs, {
        cwd: await this.root(),
        timeout: timeoutMs,
        maxBuffer: MAX_COMMAND_OUTPUT,
        signal,
        windowsHide: true,
      });
      return {
        ok: true,
        content: {
          stdout: result.stdout.toString(),
          stderr: result.stderr.toString(),
          duration_ms: Date.now() - started,
        },
      };
    } catch (err: unknown) {
      const withOutput = err as Error & { stdout?: Buffer | string; stderr?: Buffer | string; code?: string | number };
      return {
        ok: false,
        error: errorMessage(err),
        content: {
          stdout: withOutput.stdout?.toString() ?? '',
          stderr: withOutput.stderr?.toString() ?? '',
          code: withOutput.code,
          duration_ms: Date.now() - started,
        },
      };
    }
  }
}

const tools = [
  {
    type: 'function',
    function: {
      name: 'list_files',
      description: 'List repository files under the working directory.',
      parameters: {
        type: 'object',
        properties: {
          directory: { type: 'string', description: 'Relative directory path. Defaults to .' },
          recursive: { type: 'boolean' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_files',
      description: 'Search text files under the working directory for a case-insensitive string.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          directory: { type: 'string', description: 'Relative directory path. Defaults to .' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read a UTF-8 file inside the working directory.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          start_line: { type: 'number' },
          max_lines: { type: 'number' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Create or overwrite a UTF-8 file inside the working directory.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          content: { type: 'string' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'replace_in_file',
      description: 'Replace the first exact text occurrence in a file inside the working directory.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          old_text: { type: 'string' },
          new_text: { type: 'string' },
        },
        required: ['path', 'old_text', 'new_text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_command',
      description: 'Run a build, test, git, or repository command with cwd fixed to the working directory. Pass executable and args separately; shell syntax is not supported.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string' },
          args: { type: 'array', items: { type: 'string' } },
          timeout_ms: { type: 'number' },
        },
        required: ['command'],
      },
    },
  },
] as const;

export class LocalOpenAIProvider implements AgentProvider {
  readonly name = 'local-openai' as AgentProvider['name'];
  readonly displayName: string;
  readonly model: string;
  private readonly config: LocalOpenAIConfig;
  private readonly fetchImpl: FetchLike;

  constructor(args: { env?: NodeJS.ProcessEnv; fetchImpl?: FetchLike } = {}) {
    const config = getLocalOpenAIConfig(args.env ?? process.env);
    if (!config) {
      throw new Error('LOCAL_OPENAI_BASE_URL and LOCAL_OPENAI_MODEL are required');
    }
    this.config = config;
    this.displayName = config.displayName;
    this.model = config.model;
    this.fetchImpl = args.fetchImpl ?? fetch;
  }

  async start(): Promise<void> {
    const info = await detectLocalOpenAIAgent({ fetchImpl: this.fetchImpl, env: {
      LOCAL_OPENAI_BASE_URL: this.config.baseUrl,
      LOCAL_OPENAI_MODEL: this.config.model,
      LOCAL_OPENAI_API_KEY: this.config.apiKey,
      LOCAL_OPENAI_DISPLAY_NAME: this.config.displayName,
      LOCAL_OPENAI_MAX_TOKENS: String(this.config.maxTokens),
    } });
    if (!info.available) {
      throw new Error(info.reason ?? 'Local OpenAI-compatible endpoint is unavailable');
    }
  }

  async stop(): Promise<void> {}

  async createSession(config: AgentSessionConfig): Promise<AgentSession> {
    return new LocalOpenAISession(this.config, this.fetchImpl, config);
  }
}

class LocalOpenAISession implements AgentSession {
  readonly sessionId = uuid();
  private readonly abortController = new AbortController();
  private readonly toolbox: LocalOpenAIToolbox;
  private messages: ChatMessage[] = [];

  constructor(
    private readonly localConfig: LocalOpenAIConfig,
    private readonly fetchImpl: FetchLike,
    private readonly sessionConfig: AgentSessionConfig,
  ) {
    this.toolbox = new LocalOpenAIToolbox(sessionConfig.workingDirectory);
  }

  async execute(prompt: string, attachments?: AgentAttachment[]): Promise<AgentResult> {
    this.messages = [
      { role: 'system', content: this.sessionConfig.systemPrompt },
      { role: 'user', content: this.userContent(prompt, attachments) },
    ];
    try {
      return await this.runLoop();
    } catch (err: unknown) {
      const message = errorMessage(err);
      emit(this.sessionConfig, 'error', message, { agentType: 'local-openai' as AgentEventMetadata['agentType'] });
      return { status: 'failed', error: message };
    }
  }

  async send(message: string, attachments?: AgentAttachment[]): Promise<void> {
    this.messages.push({ role: 'user', content: this.userContent(message, attachments) });
    await this.runLoop();
  }

  async abort(): Promise<void> {
    this.abortController.abort();
  }

  async destroy(): Promise<void> {
    this.abortController.abort();
  }

  private userContent(prompt: string, attachments?: AgentAttachment[]): string {
    if (!attachments?.length) return prompt;
    const names = attachments.map((attachment) => attachment.displayName ?? attachment.path ?? attachment.type).join(', ');
    return `${prompt}\n\nAttachments available to Agent Board but not directly readable by local-openai: ${names}`;
  }

  private async runLoop(): Promise<AgentResult> {
    for (let turn = 0; turn < MAX_TOOL_TURNS; turn += 1) {
      const step = await this.chatCompletion();
      const assistantMessage: ChatMessage = {
        role: 'assistant',
        content: step.content || null,
      };
      if (step.toolCalls.length > 0) {
        assistantMessage.tool_calls = step.toolCalls;
      }
      this.messages.push(assistantMessage);

      if (step.toolCalls.length === 0) {
        if (step.content.trim()) return { status: 'complete' };
        if (step.reasoning.trim()) {
          this.messages.push({
            role: 'user',
            content: 'You only produced reasoning. Provide the final task result, or call tools if more work is needed.',
          });
          continue;
        }
        return { status: 'failed', error: 'Local OpenAI-compatible model returned no content or tool calls' };
      }

      for (const toolCall of step.toolCalls) {
        const result = await this.executeTool(toolCall);
        this.messages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: JSON.stringify(result),
        });
      }
    }
    return { status: 'failed', error: `Local OpenAI-compatible model exceeded ${MAX_TOOL_TURNS} tool turns` };
  }

  private requestHeaders(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      ...authHeaders(this.localConfig),
    };
  }

  private async chatCompletion(): Promise<ModelStep> {
    const response = await this.fetchImpl(`${this.localConfig.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: this.requestHeaders(),
      body: JSON.stringify({
        model: this.localConfig.model,
        messages: this.messages,
        tools,
        tool_choice: 'auto',
        stream: true,
        max_tokens: this.localConfig.maxTokens,
      }),
      signal: this.abortController.signal,
    });
    if (!response.ok) {
      throw new Error(`/chat/completions failed with HTTP ${response.status}: ${await response.text().catch(() => '')}`);
    }
    const contentType = response.headers.get('content-type') ?? '';
    if (contentType.includes('text/event-stream')) {
      return this.readStreamingResponse(response);
    }
    const json = await response.json() as {
      choices?: Array<{
        message?: {
          content?: string | null;
          reasoning_content?: string | null;
          tool_calls?: ToolCall[];
        };
      }>;
    };
    const message = json.choices?.[0]?.message;
    const reasoning = message?.reasoning_content ?? '';
    const content = message?.content ?? '';
    if (reasoning) emit(this.sessionConfig, 'thinking', reasoning, { agentType: 'local-openai' as AgentEventMetadata['agentType'] });
    if (content) emit(this.sessionConfig, 'output', content, { agentType: 'local-openai' as AgentEventMetadata['agentType'] });
    return { content, reasoning, toolCalls: message?.tool_calls ?? [] };
  }

  private async readStreamingResponse(response: Response): Promise<ModelStep> {
    if (!response.body) throw new Error('streaming response had no body');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let content = '';
    let reasoning = '';
    const toolCalls = new Map<number, ToolCallAccumulator>();

    const handleFrame = (frame: string) => {
      const data = frame
        .split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trim())
        .join('\n');
      if (!data || data === '[DONE]') return;
      const parsed = JSON.parse(data) as {
        choices?: Array<{
          delta?: {
            content?: string | null;
            reasoning_content?: string | null;
            tool_calls?: Array<{
              index?: number;
              id?: string;
              type?: 'function';
              function?: {
                name?: string;
                arguments?: string;
              };
            }>;
          };
        }>;
      };
      const delta = parsed.choices?.[0]?.delta;
      if (!delta) return;
      if (delta.reasoning_content) {
        reasoning += delta.reasoning_content;
        emit(this.sessionConfig, 'thinking', delta.reasoning_content, { agentType: 'local-openai' as AgentEventMetadata['agentType'] });
      }
      if (delta.content) {
        content += delta.content;
        emit(this.sessionConfig, 'output', delta.content, { agentType: 'local-openai' as AgentEventMetadata['agentType'] });
      }
      for (const part of delta.tool_calls ?? []) {
        const index = part.index ?? 0;
        const existing = toolCalls.get(index) ?? {
          id: part.id ?? `call_${index}`,
          type: 'function' as const,
          function: { name: '', arguments: '' },
        };
        if (part.id) existing.id = part.id;
        if (part.type) existing.type = part.type;
        if (part.function?.name) existing.function.name += part.function.name;
        if (part.function?.arguments) existing.function.arguments += part.function.arguments;
        toolCalls.set(index, existing);
      }
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split(/\r?\n\r?\n/);
      buffer = frames.pop() ?? '';
      for (const frame of frames) handleFrame(frame);
    }
    buffer += decoder.decode();
    if (buffer.trim()) handleFrame(buffer);
    return { content, reasoning, toolCalls: [...toolCalls.values()] };
  }

  private async executeTool(toolCall: ToolCall): Promise<ToolResult> {
    let args: Record<string, unknown>;
    try {
      args = parseJsonObject(toolCall.function.arguments);
    } catch (err: unknown) {
      return { ok: false, error: errorMessage(err) };
    }

    emit(this.sessionConfig, 'tool_call', `${toolCall.function.name}: ${toolCall.function.arguments}`, {
      agentType: 'local-openai' as AgentEventMetadata['agentType'],
    });

    try {
      switch (toolCall.function.name) {
        case 'list_files':
          return await this.toolbox.listFiles(args);
        case 'search_files':
          return await this.toolbox.searchFiles(args);
        case 'read_file': {
          const result = await this.toolbox.readFile(args);
          emit(this.sessionConfig, 'file_read', `read_file: ${toolCall.function.arguments}`, {
            file: stringArg(args, 'path'),
            agentType: 'local-openai' as AgentEventMetadata['agentType'],
          });
          return result;
        }
        case 'write_file': {
          const result = await this.toolbox.writeFile(args);
          emit(this.sessionConfig, 'file_write', `write_file: ${toolCall.function.arguments}`, {
            file: stringArg(args, 'path'),
            agentType: 'local-openai' as AgentEventMetadata['agentType'],
          });
          return result;
        }
        case 'replace_in_file': {
          const result = await this.toolbox.replaceInFile(args);
          emit(this.sessionConfig, 'file_edit', `replace_in_file: ${toolCall.function.arguments}`, {
            file: stringArg(args, 'path'),
            agentType: 'local-openai' as AgentEventMetadata['agentType'],
          });
          return result;
        }
        case 'run_command': {
          const command = stringArg(args, 'command');
          const commandArgsRaw = args.args;
          const commandArgs = Array.isArray(commandArgsRaw) ? commandArgsRaw.map((arg) => String(arg)) : [];
          emit(this.sessionConfig, 'command', [command, ...commandArgs].join(' '), {
            command,
            agentType: 'local-openai' as AgentEventMetadata['agentType'],
          });
          const result = await this.toolbox.runCommand(args, this.abortController.signal);
          emit(this.sessionConfig, 'command_output', JSON.stringify(result.content ?? result.error), {
            command,
            agentType: 'local-openai' as AgentEventMetadata['agentType'],
          });
          return result;
        }
        default:
          return { ok: false, error: `unknown tool: ${toolCall.function.name}` };
      }
    } catch (err: unknown) {
      const result = { ok: false, error: errorMessage(err) };
      emit(this.sessionConfig, 'error', `${toolCall.function.name} failed: ${result.error}`, {
        agentType: 'local-openai' as AgentEventMetadata['agentType'],
      });
      return result;
    }
  }
}
