import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { AgentEvent } from '@codewithdan/agent-sdk-core';
import { isValidAgentType } from '@ai-agent-board/shared/constants.js';
import {
  detectLocalOpenAIAgent,
  getLocalOpenAIConfig,
  LocalOpenAIProvider,
  LocalOpenAIToolbox,
} from '../src/services/local-openai-provider.js';

function tempDir(name: string): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), `agentboard-${name}-`));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
}

function sseResponse(frames: unknown[]): Response {
  const encoder = new TextEncoder();
  const body = frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join('') + 'data: [DONE]\n\n';
  return new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(body));
      controller.close();
    },
  }), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

function makeSession(args: {
  dir: string;
  responses: Response[];
  events?: AgentEvent[];
  env?: NodeJS.ProcessEnv;
  urls?: string[];
  headers?: HeadersInit[];
}) {
  const responses = [...args.responses];
  const events = args.events ?? [];
  const provider = new LocalOpenAIProvider({
    env: {
      LOCAL_OPENAI_BASE_URL: 'http://local-llm.test/v1',
      LOCAL_OPENAI_MODEL: 'test-coder',
      ...args.env,
    },
    fetchImpl: async (url, init) => {
      args.urls?.push(String(url));
      args.headers?.push(init?.headers ?? {});
      const response = responses.shift();
      if (!response) throw new Error('unexpected fetch');
      return response;
    },
  });
  return provider.createSession({
    contextId: 'task-1',
    workingDirectory: args.dir,
    systemPrompt: 'system',
    onEvent: (event) => events.push(event),
  });
}

test('AgentType validation accepts local-openai', () => {
  assert.equal(isValidAgentType('local-openai'), true);
  assert.equal(isValidAgentType('local-openai '), false);
});

test('local OpenAI config requires base URL and model', () => {
  assert.equal(getLocalOpenAIConfig({}), null);
  assert.equal(getLocalOpenAIConfig({ LOCAL_OPENAI_BASE_URL: 'http://localhost:1234' }), null);
  assert.deepEqual(getLocalOpenAIConfig({
    LOCAL_OPENAI_BASE_URL: 'http://localhost:1234/v1/',
    LOCAL_OPENAI_MODEL: 'coder',
    LOCAL_OPENAI_DISPLAY_NAME: 'Desk Model',
    LOCAL_OPENAI_MAX_TOKENS: '1234',
  }), {
    baseUrl: 'http://localhost:1234/v1',
    model: 'coder',
    displayName: 'Desk Model',
    maxTokens: 1234,
    apiKey: undefined,
  });
});

test('local OpenAI detection fails closed when config is missing', async () => {
  const info = await detectLocalOpenAIAgent({ env: {} });
  assert.equal(info.name, 'local-openai');
  assert.equal(info.available, false);
  assert.match(info.reason ?? '', /LOCAL_OPENAI_BASE_URL/);
});

test('local OpenAI detection probes /models and only sends auth when configured', async () => {
  const seen: Array<{ url: string; auth: string | null }> = [];
  const info = await detectLocalOpenAIAgent({
    env: {
      LOCAL_OPENAI_BASE_URL: 'http://local-llm.test/v1',
      LOCAL_OPENAI_MODEL: 'coder',
      LOCAL_OPENAI_API_KEY: 'secret',
      LOCAL_OPENAI_DISPLAY_NAME: 'Workshop',
    },
    fetchImpl: async (url, init) => {
      const headers = new Headers(init?.headers);
      seen.push({ url: String(url), auth: headers.get('authorization') });
      return jsonResponse({ data: [] });
    },
  });

  assert.equal(info.available, true);
  assert.equal(info.displayName, 'Workshop');
  assert.equal(info.version, 'coder');
  assert.deepEqual(seen, [{ url: 'http://local-llm.test/v1/models', auth: 'Bearer secret' }]);

  seen.length = 0;
  await detectLocalOpenAIAgent({
    env: { LOCAL_OPENAI_BASE_URL: 'http://local-llm.test/v1', LOCAL_OPENAI_MODEL: 'coder' },
    fetchImpl: async (url, init) => {
      seen.push({ url: String(url), auth: new Headers(init?.headers).get('authorization') });
      return jsonResponse({ data: [] });
    },
  });
  assert.equal(seen[0].auth, null);
});

test('local OpenAI detection reports failed probe as unavailable', async () => {
  const info = await detectLocalOpenAIAgent({
    env: { LOCAL_OPENAI_BASE_URL: 'http://local-llm.test/v1', LOCAL_OPENAI_MODEL: 'coder' },
    fetchImpl: async () => jsonResponse({ error: 'nope' }, { status: 503 }),
  });
  assert.equal(info.available, false);
  assert.match(info.reason ?? '', /HTTP 503/);
});

test('local OpenAI session completes from non-streaming content', async (t) => {
  const { dir, cleanup } = tempDir('local-complete');
  t.after(cleanup);
  const events: AgentEvent[] = [];
  const session = await makeSession({
    dir,
    events,
    responses: [jsonResponse({ choices: [{ message: { content: 'done' } }] })],
  });

  const result = await session.execute('finish task');
  assert.equal(result.status, 'complete');
  assert.equal(events.some((event) => event.type === 'output' && event.content === 'done'), true);
});

test('local OpenAI session preserves streaming output and reasoning_content', async (t) => {
  const { dir, cleanup } = tempDir('local-stream');
  t.after(cleanup);
  const events: AgentEvent[] = [];
  const session = await makeSession({
    dir,
    events,
    responses: [sseResponse([
      { choices: [{ delta: { reasoning_content: 'thinking ' } }] },
      { choices: [{ delta: { content: 'final ' } }] },
      { choices: [{ delta: { content: 'answer' } }] },
    ])],
  });

  const result = await session.execute('finish task');
  assert.equal(result.status, 'complete');
  assert.equal(events.filter((event) => event.type === 'thinking').map((event) => event.content).join(''), 'thinking ');
  assert.equal(events.filter((event) => event.type === 'output').map((event) => event.content).join(''), 'final answer');
});

test('reasoning-only responses are not treated as useful final output', async (t) => {
  const { dir, cleanup } = tempDir('local-reasoning');
  t.after(cleanup);
  const events: AgentEvent[] = [];
  const session = await makeSession({
    dir,
    events,
    responses: [
      jsonResponse({ choices: [{ message: { reasoning_content: 'analysis only' } }] }),
      jsonResponse({ choices: [{ message: { content: 'actual final' } }] }),
    ],
  });

  const result = await session.execute('finish task');
  assert.equal(result.status, 'complete');
  assert.equal(events.some((event) => event.type === 'thinking' && event.content === 'analysis only'), true);
  assert.equal(events.some((event) => event.type === 'output' && event.content === 'actual final'), true);
});

test('file toolbox allows confined read/write and rejects traversal', async (t) => {
  const { dir, cleanup } = tempDir('local-files');
  t.after(cleanup);
  writeFileSync(path.join(dir, 'inside.txt'), 'hello');
  const toolbox = new LocalOpenAIToolbox(dir);

  assert.equal((await toolbox.readFile({ path: 'inside.txt' })).ok, true);
  assert.equal((await toolbox.writeFile({ path: 'created.txt', content: 'new' })).ok, true);
  assert.equal(readFileSync(path.join(dir, 'created.txt'), 'utf8'), 'new');
  await assert.rejects(() => toolbox.readFile({ path: '../outside.txt' }), /escapes working directory/);
  await assert.rejects(() => toolbox.writeFile({ path: '../outside.txt', content: 'bad' }), /escapes working directory/);
});

test('tool loop can modify a repository file', async (t) => {
  const { dir, cleanup } = tempDir('local-tool-loop');
  t.after(cleanup);
  writeFileSync(path.join(dir, 'README.md'), 'before\n');
  const events: AgentEvent[] = [];
  const session = await makeSession({
    dir,
    events,
    responses: [
      jsonResponse({ choices: [{ message: { content: '', tool_calls: [{
        id: 'call-1',
        type: 'function',
        function: { name: 'replace_in_file', arguments: JSON.stringify({ path: 'README.md', old_text: 'before', new_text: 'after' }) },
      }] } }] }),
      jsonResponse({ choices: [{ message: { content: 'changed README' } }] }),
    ],
  });

  const result = await session.execute('change README');
  assert.equal(result.status, 'complete');
  assert.equal(readFileSync(path.join(dir, 'README.md'), 'utf8'), 'after\n');
  assert.equal(events.some((event) => event.type === 'file_edit' && event.metadata?.file === 'README.md'), true);
});

test('streaming tool calls are assembled and executed', async (t) => {
  const { dir, cleanup } = tempDir('local-stream-tools');
  t.after(cleanup);
  const session = await makeSession({
    dir,
    responses: [
      sseResponse([
        { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-1', type: 'function', function: { name: 'write_file', arguments: '{"path":"' } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'note.txt","content":"ok"}' } }] } }] },
      ]),
      jsonResponse({ choices: [{ message: { content: 'wrote file' } }] }),
    ],
  });

  const result = await session.execute('write note');
  assert.equal(result.status, 'complete');
  assert.equal(readFileSync(path.join(dir, 'note.txt'), 'utf8'), 'ok');
});

test('command execution keeps cwd confined and rejects path escapes', async (t) => {
  const { dir, cleanup } = tempDir('local-command');
  t.after(cleanup);
  const toolbox = new LocalOpenAIToolbox(dir);
  const ok = await toolbox.runCommand({ command: 'pwd' }, new AbortController().signal);
  assert.equal(ok.ok, true);
  assert.equal((ok.content as { stdout: string }).stdout.trim(), dir);

  await assert.rejects(
    () => toolbox.runCommand({ command: 'node', args: ['../outside.js'] }, new AbortController().signal),
    /escapes working directory/,
  );
});

test('chat completion HTTP failures fail the session', async (t) => {
  const { dir, cleanup } = tempDir('local-failure');
  t.after(cleanup);
  const events: AgentEvent[] = [];
  const session = await makeSession({
    dir,
    events,
    responses: [jsonResponse({ error: 'bad' }, { status: 500 })],
  });

  const result = await session.execute('finish task');
  assert.equal(result.status, 'failed');
  assert.match(result.error ?? '', /HTTP 500/);
  assert.equal(events.some((event) => event.type === 'error' && event.content.includes('HTTP 500')), true);
});
