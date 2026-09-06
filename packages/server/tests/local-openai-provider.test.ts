import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { setImmediate as tick, setTimeout as delay } from 'node:timers/promises';
import { zstdCompressSync } from 'node:zlib';
import type { AgentEvent } from '@codewithdan/agent-sdk-core';
import { isValidAgentType } from '@ai-agent-board/shared/constants.js';
import {
  decodeDurableZstdFrames,
  detectLocalOpenAIAgent,
  dshProjectDirectoryName,
  getLocalOpenAIConfig,
  LocalOpenAIProvider,
  sanitizeOutput,
} from '../src/services/local-openai-provider.js';

type SpawnCall = {
  command: string;
  args: string[];
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    windowsHide: boolean;
    stdio: ['ignore', 'pipe', 'pipe'];
  };
};

class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  killed = false;
  signals: Array<NodeJS.Signals | number | undefined> = [];

  kill(signal?: NodeJS.Signals | number): boolean {
    this.killed = true;
    this.signals.push(signal);
    return true;
  }

  close(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.emit('close', code, signal);
  }
}

function tempDir(name: string): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), `agentboard-${name}-`));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function makeLauncher(dir: string): string {
  const launcher = path.join(dir, 'dsh-launcher.js');
  writeFileSync(launcher, '#!/usr/bin/env node\n');
  chmodSync(launcher, 0o755);
  return launcher;
}

function makeDshSession(dshHome: string, cwd: string, session = 'session-test', compressed = true): string {
  const sessionDir = path.join(dshHome, 'sessions', dshProjectDirectoryName(cwd), session);
  mkdirSync(sessionDir, { recursive: true });
  const file = path.join(sessionDir, compressed ? 'session.jsonl.zstd' : 'session.jsonl');
  appendDshEvents(file, [{ type: 'session', version: 0, id: session, createdAt: Date.now(), cwd }], compressed);
  return file;
}

function appendDshEvents(file: string, records: Array<Record<string, unknown>>, compressed = true): void {
  for (const record of records) {
    const line = Buffer.from(`${JSON.stringify(record)}\n`, 'utf8');
    appendFileSync(file, compressed ? zstdCompressSync(line) : line);
  }
}

function toolCall(seq: number, callId: string, name: string, args: Record<string, unknown>) {
  return { type: 'tool/call', seq, time: Date.now(), data: { turn: 1, step: 1, callId, name, arguments: JSON.stringify(args) } };
}

function toolResult(seq: number, callId: string, text: string, isError = false) {
  return {
    type: 'tool/result',
    seq,
    time: Date.now(),
    data: {
      turn: 1,
      step: 1,
      message: {
        source: { kind: 'tool', callId },
        content: [{ type: 'tool-result', toolCallId: callId, isError, content: [{ type: 'text', text }] }],
        role: 'user',
      },
    },
  };
}

function toolOutput(seq: number, callId: string, text: string, stream: 'stdout' | 'stderr' = 'stdout') {
  return { type: `tool/${stream}`, seq, time: Date.now(), data: { turn: 1, step: 1, callId, stream, text } };
}

function makeSession(args: {
  dir: string;
  launcherPath: string;
  events?: AgentEvent[];
  calls?: SpawnCall[];
  child?: FakeChild;
  env?: NodeJS.ProcessEnv;
}) {
  const events = args.events ?? [];
  const child = args.child ?? new FakeChild();
  const calls = args.calls ?? [];
  const provider = new LocalOpenAIProvider({
    env: {
      DSH_LAUNCHER_PATH: args.launcherPath,
      DSH_HOME: '/tmp/test-dsh-home',
      DSH_PROFILE: 'headless-test',
      LOCAL_OPENAI_DISPLAY_NAME: 'Local AI',
      LOCAL_OPENAI_MODEL: 'Qwen R9700',
      ...args.env,
    },
    spawnCommand: (command, spawnArgs, options) => {
      calls.push({ command, args: spawnArgs, options });
      return child;
    },
  });
  return {
    child,
    calls,
    events,
    session: provider.createSession({
      contextId: 'task-1',
      workingDirectory: args.dir,
      systemPrompt: 'system prompt',
      onEvent: (event) => events.push(event),
    }),
  };
}

test('AgentType validation accepts local-openai', () => {
  assert.equal(isValidAgentType('local-openai'), true);
  assert.equal(isValidAgentType('local-openai '), false);
});

test('local AI DSH config requires a launcher and defaults headless settings', () => {
  assert.equal(getLocalOpenAIConfig({}), null);
  assert.deepEqual(getLocalOpenAIConfig({
    DSH_LAUNCHER_PATH: '/opt/dsh/bin.js',
    LOCAL_OPENAI_DISPLAY_NAME: 'Local AI / Qwen R9700',
    LOCAL_OPENAI_MODEL: 'Qwen R9700',
  }), {
    launcherPath: '/opt/dsh/bin.js',
    dshHome: '/root/.dsh',
    profile: 'headless',
    displayName: 'Local AI / Qwen R9700',
    model: 'Qwen R9700',
  });
});

test('local AI DSH detection validates the configured launcher path', async (t) => {
  const { dir, cleanup } = tempDir('dsh-detect');
  t.after(cleanup);
  const launcher = makeLauncher(dir);

  const available = await detectLocalOpenAIAgent({
    env: {
      DSH_LAUNCHER_PATH: launcher,
      LOCAL_OPENAI_DISPLAY_NAME: 'Local AI / Qwen R9700',
      LOCAL_OPENAI_MODEL: 'Qwen R9700',
    },
  });
  assert.equal(available.name, 'local-openai');
  assert.equal(available.displayName, 'Local AI / Qwen R9700');
  assert.equal(available.available, true);
  assert.equal(available.version, 'Qwen R9700');

  const missing = await detectLocalOpenAIAgent({ env: { DSH_LAUNCHER_PATH: path.join(dir, 'missing.js') } });
  assert.equal(missing.available, false);
  assert.match(missing.reason ?? '', /does not exist/);
});

test('local AI DSH session passes worktree cwd, DSH env, profile, and one-shot prompt', async (t) => {
  const { dir, cleanup } = tempDir('dsh-contract');
  t.after(cleanup);
  const launcher = makeLauncher(dir);
  const child = new FakeChild();
  const calls: SpawnCall[] = [];
  const { session: sessionPromise } = makeSession({ dir, launcherPath: launcher, calls, child });
  const session = await sessionPromise;

  const resultPromise = session.execute('do the task');
  child.close(0);
  const result = await resultPromise;

  assert.equal(result.status, 'complete');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, 'node');
  assert.equal(calls[0].args[0], launcher);
  assert.deepEqual(calls[0].args.slice(1, 3), ['--profile', 'headless-test']);
  assert.match(calls[0].args[3], /system prompt/);
  assert.match(calls[0].args[3], /do the task/);
  assert.equal(calls[0].options.cwd, dir);
  assert.equal(calls[0].options.env.DSH_HOME, '/tmp/test-dsh-home');
  assert.equal(calls[0].options.env.DSH_PROFILE, 'headless-test');
  assert.deepEqual(calls[0].options.stdio, ['ignore', 'pipe', 'pipe']);
});

test('local AI DSH stdout is surfaced with credential redaction and stderr is ignored', async (t) => {
  const { dir, cleanup } = tempDir('dsh-output');
  t.after(cleanup);
  const launcher = makeLauncher(dir);
  const events: AgentEvent[] = [];
  const child = new FakeChild();
  const { session: sessionPromise } = makeSession({
    dir,
    launcherPath: launcher,
    child,
    events,
    env: { OPENAI_API_KEY: 'sk-test-secret-value' },
  });
  const session = await sessionPromise;

  const resultPromise = session.execute('emit output');
  child.stdout.write('created file\napi_key: sk-test-secret-value\n');
  child.stderr.write('debug /root/.dsh/.credentials.yaml token=sk-test-secret-value\n');
  child.close(0);
  const result = await resultPromise;

  assert.equal(result.status, 'complete');
  const contents = events.map((event) => event.content).join('\n');
  assert.match(contents, /created file/);
  assert.match(contents, /\[redacted\]/);
  assert.doesNotMatch(contents, /\[DSH credentials file\]/);
  assert.doesNotMatch(contents, /debug/);
  assert.doesNotMatch(contents, /sk-test-secret-value/);
});

test('local AI DSH stderr reasoning is ignored and stdout is only final output', async (t) => {
  const { dir, cleanup } = tempDir('dsh-private-streams');
  t.after(cleanup);
  const launcher = makeLauncher(dir);
  const events: AgentEvent[] = [];
  const child = new FakeChild();
  const { session: sessionPromise } = makeSession({ dir, launcherPath: launcher, child, events });
  const session = await sessionPromise;

  const resultPromise = session.execute('emit private stderr');
  child.stderr.write('private chain-of-thought token fragment\n');
  child.stdout.write('Final visible answer\n');
  await tick();
  assert.doesNotMatch(events.map((event) => event.content).join('\n'), /private chain-of-thought/);

  child.close(0);
  const result = await resultPromise;

  assert.equal(result.status, 'complete');
  assert.ok(events.some((event) => event.type === 'output' && event.content.includes('Final visible answer')));
  assert.ok(!events.some((event) => event.type === 'command_output' && event.content.includes('private chain-of-thought')));
});

test('local AI DSH persisted SessionEvents are normalized before process completion', async (t) => {
  const { dir, cleanup } = tempDir('dsh-live-activity');
  t.after(cleanup);
  const dshHome = path.join(dir, 'dsh-home');
  const launcher = makeLauncher(dir);
  const events: AgentEvent[] = [];
  const child = new FakeChild();
  const { session: sessionPromise } = makeSession({
    dir,
    launcherPath: launcher,
    child,
    events,
    env: { DSH_HOME: dshHome },
  });
  const session = await sessionPromise;

  const resultPromise = session.execute('stream activity while working');
  const sessionFile = makeDshSession(dshHome, dir);
  appendDshEvents(sessionFile, [
    toolCall(1, 'read-1', 'read_file', { path: 'packages/server/src/index.ts' }),
    toolCall(2, 'write-1', 'write_file', { path: 'created.ts' }),
    toolCall(3, 'edit-1', 'edit_file', { path: 'safe.ts' }),
    toolCall(4, 'search-1', 'grep', { pattern: 'LocalOpenAIProvider', path: 'packages/server/src' }),
    toolCall(5, 'bash-1', 'bash', { command: 'npm run build:server' }),
    toolOutput(6, 'bash-1', '\x1b[32mserver stdout chunk\x1b[0m\n'),
    toolOutput(7, 'bash-1', 'server stderr chunk\n', 'stderr'),
    toolResult(8, 'bash-1', 'Focused tests passed: representative DSH stream'),
    toolCall(9, 'test-1', 'bash', { command: 'npm test -- --runInBand' }),
    toolResult(10, 'test-1', '1 test failed', true),
    toolCall(11, 'unknown-1', 'custom_safe_tool', { value: 'safe', reasoning: 'hidden tool thought' }),
    { type: 'assistant/chunk', seq: 12, data: { chunk: { type: 'reasoning-delta', text: 'private chain of thought' } } },
    { type: 'reasoning-chunks', seq0: 13, data: { texts: ['private reasoning'] } },
  ]);
  child.stderr.write('harness private stderr reasoning\n');
  await delay(400);

  assert.equal(child.killed, false);
  assert.ok(events.some((event) =>
    event.type === 'file_read' &&
    event.metadata?.file === 'packages/server/src/index.ts' &&
    event.metadata?.agentType === 'local-openai'
  ));
  assert.ok(events.some((event) =>
    event.type === 'command' &&
    event.metadata?.command === 'npm run build:server' &&
    event.metadata?.state === 'running'
  ));
  assert.ok(events.some((event) =>
    event.type === 'command_output' &&
    event.content.includes('\x1b[32mserver stdout chunk\x1b[0m') &&
    event.metadata?.command === 'npm run build:server' &&
    event.metadata?.state === 'running'
  ));
  assert.ok(events.some((event) =>
    event.type === 'command_output' &&
    event.content.includes('server stderr chunk') &&
    event.metadata?.command === 'npm run build:server' &&
    event.metadata?.state === 'running'
  ));
  assert.ok(events.some((event) =>
    event.type === 'command_output' &&
    event.content.includes('Focused tests passed') &&
    event.metadata?.command === 'npm run build:server' &&
    event.metadata?.state === 'succeeded'
  ));
  assert.ok(events.some((event) =>
    event.type === 'file_write' &&
    event.metadata?.file === 'created.ts'
  ));
  assert.ok(events.some((event) =>
    event.type === 'file_edit' &&
    event.metadata?.file === 'safe.ts' &&
    event.content === 'Edited safe.ts'
  ));
  assert.ok(events.some((event) =>
    event.type === 'command' &&
    event.metadata?.command?.includes('LocalOpenAIProvider')
  ));
  assert.ok(events.some((event) =>
    event.type === 'test_result' &&
    event.content.includes('1 test failed') &&
    event.metadata?.state === 'failed'
  ));
  const buildCommandIndex = events.findIndex((event) => event.type === 'command' && event.metadata?.command === 'npm run build:server');
  const firstBuildOutputIndex = events.findIndex((event) => event.type === 'command_output' && event.content.includes('server stdout chunk'));
  const finalBuildOutputIndex = events.findIndex((event) => event.type === 'command_output' && event.content.includes('Focused tests passed'));
  assert.ok(buildCommandIndex >= 0 && firstBuildOutputIndex > buildCommandIndex && finalBuildOutputIndex > firstBuildOutputIndex);
  assert.ok(events.some((event) =>
    event.type === 'tool_call' &&
    event.content.includes('custom_safe_tool')
  ));
  const contents = events.map((event) => event.content).join('\n');
  assert.doesNotMatch(contents, /private chain of thought|private reasoning|harness private stderr|hidden tool thought/);

  child.close(0);
  const result = await resultPromise;
  assert.equal(result.status, 'complete');
});

test('local AI DSH plaintext logs and command events stream before process completion', async (t) => {
  const { dir, cleanup } = tempDir('dsh-live-command-events');
  t.after(cleanup);
  const dshHome = path.join(dir, 'dsh-home');
  const launcher = makeLauncher(dir);
  const events: AgentEvent[] = [];
  const child = new FakeChild();
  const { session: sessionPromise } = makeSession({
    dir,
    launcherPath: launcher,
    child,
    events,
    env: { DSH_HOME: dshHome },
  });
  const session = await sessionPromise;

  const resultPromise = session.execute('stream plaintext command events');
  const sessionFile = makeDshSession(dshHome, dir, 'session-plaintext', false);
  appendDshEvents(sessionFile, [
    { type: 'command/run', seq: 1, time: Date.now(), data: { commandId: 'cmd-1', name: 'npm', args: 'test' } },
    { type: 'command/done', seq: 2, time: Date.now(), data: { commandId: 'cmd-1', kind: 'success', text: 'plain log ok' } },
  ], false);
  await delay(400);

  assert.equal(child.killed, false);
  assert.ok(events.some((event) =>
    event.type === 'command' &&
    event.metadata?.command === 'npm test' &&
    event.metadata?.state === 'running'
  ));
  assert.ok(events.some((event) =>
    event.type === 'command_output' &&
    event.content.includes('plain log ok') &&
    event.metadata?.command === 'npm test' &&
    event.metadata?.state === 'succeeded'
  ));
  assert.ok(events.some((event) =>
    event.type === 'test_result' &&
    event.content.includes('plain log ok') &&
    event.metadata?.state === 'succeeded'
  ));

  child.close(0);
  const result = await resultPromise;
  assert.equal(result.status, 'complete');
});

test('local AI DSH project directory names match harness escaping and length limit', () => {
  assert.equal(dshProjectDirectoryName('/tmp/dsh-r9700-smoke'), '--tmp-dsh-r9700-smoke--');
  assert.equal(dshProjectDirectoryName('/tmp/project:with space/~tilde'), '--tmp-project-with~0020space-~007Etilde--');
  assert.equal(dshProjectDirectoryName(`/${'a'.repeat(300)}`).length, 255);
});

test('local AI DSH warns and fails closed when no session is found after bounded wait', async (t) => {
  const { dir, cleanup } = tempDir('dsh-no-session');
  t.after(cleanup);
  const dshHome = path.join(dir, 'dsh-home');
  const launcher = makeLauncher(dir);
  const events: AgentEvent[] = [];
  const child = new FakeChild();
  const { session: sessionPromise } = makeSession({
    dir,
    launcherPath: launcher,
    child,
    events,
    env: { DSH_HOME: dshHome },
  });
  const session = await sessionPromise;

  const resultPromise = session.execute('no session');
  await delay(10_500);
  const warnings = events.filter((event) => event.type === 'error' && event.content.includes('No DeepSeek Harness session was found'));
  assert.equal(warnings.length, 1);

  const unrelated = makeDshSession(dshHome, path.join(dir, 'other'));
  appendDshEvents(unrelated, [toolCall(1, 'late', 'bash', { command: 'echo late' })]);
  await delay(400);
  assert.ok(!events.some((event) => event.metadata?.command === 'echo late'));

  child.close(0);
  const result = await resultPromise;
  assert.equal(result.status, 'complete');
});

test('local AI DSH suppresses duplicate SessionEvents by callId', async (t) => {
  const { dir, cleanup } = tempDir('dsh-duplicates');
  t.after(cleanup);
  const dshHome = path.join(dir, 'dsh-home');
  const launcher = makeLauncher(dir);
  const events: AgentEvent[] = [];
  const child = new FakeChild();
  const { session: sessionPromise } = makeSession({
    dir,
    launcherPath: launcher,
    child,
    events,
    env: { DSH_HOME: dshHome },
  });
  const session = await sessionPromise;

  const resultPromise = session.execute('duplicates');
  const sessionFile = makeDshSession(dshHome, dir);
  appendDshEvents(sessionFile, [
    toolCall(1, 'dup-1', 'bash', { command: 'npm test' }),
    toolCall(2, 'dup-1', 'bash', { command: 'npm test' }),
    toolResult(3, 'dup-1', 'ok'),
    toolResult(4, 'dup-1', 'ok'),
  ]);
  await delay(400);
  child.close(0);
  await resultPromise;

  assert.equal(events.filter((event) => event.type === 'command' && event.metadata?.command === 'npm test').length, 1);
  assert.equal(events.filter((event) => event.type === 'command_output' && event.content === 'ok').length, 1);
  assert.equal(events.filter((event) => event.type === 'test_result' && event.content === 'ok').length, 1);
});

test('local AI DSH incremental zstd decoding leaves incomplete appended frames unread', () => {
  const first = zstdCompressSync(Buffer.from('{"type":"session","cwd":"/tmp/repo"}\n'));
  const second = zstdCompressSync(Buffer.from('{"type":"tool/call","seq":1}\n'));
  const incomplete = second.subarray(0, Math.max(1, Math.floor(second.length / 2)));
  const decoded = decodeDurableZstdFrames(Buffer.concat([first, incomplete]));

  assert.equal(decoded.text, '{"type":"session","cwd":"/tmp/repo"}\n');
  assert.equal(decoded.bytesConsumed, first.length);
});

test('local AI DSH rejects ambiguous or unrelated session association', async (t) => {
  const { dir, cleanup } = tempDir('dsh-ambiguous');
  t.after(cleanup);
  const dshHome = path.join(dir, 'dsh-home');
  const launcher = makeLauncher(dir);
  const events: AgentEvent[] = [];
  const child = new FakeChild();
  const { session: sessionPromise } = makeSession({
    dir,
    launcherPath: launcher,
    child,
    events,
    env: { DSH_HOME: dshHome },
  });
  const session = await sessionPromise;

  const resultPromise = session.execute('ambiguous');
  const first = makeDshSession(dshHome, dir, 'session-one');
  const second = makeDshSession(dshHome, dir, 'session-two');
  appendDshEvents(first, [toolCall(1, 'first', 'bash', { command: 'echo first' })]);
  appendDshEvents(second, [toolCall(2, 'second', 'bash', { command: 'echo second' })]);
  const unrelated = makeDshSession(dshHome, path.join(dir, 'other'), 'session-unrelated');
  appendDshEvents(unrelated, [toolCall(3, 'unrelated', 'bash', { command: 'echo unrelated' })]);
  await delay(400);
  child.close(0);
  await resultPromise;

  assert.ok(events.some((event) => event.type === 'error' && event.content.includes('ambiguous')));
  assert.ok(!events.some((event) => event.metadata?.command === 'echo first'));
  assert.ok(!events.some((event) => event.metadata?.command === 'echo second'));
  assert.ok(!events.some((event) => event.metadata?.command === 'echo unrelated'));
});

test('local AI DSH SessionEvent output uses existing secret sanitization', async (t) => {
  const { dir, cleanup } = tempDir('dsh-secret-session');
  t.after(cleanup);
  const dshHome = path.join(dir, 'dsh-home');
  const launcher = makeLauncher(dir);
  const events: AgentEvent[] = [];
  const child = new FakeChild();
  const { session: sessionPromise } = makeSession({
    dir,
    launcherPath: launcher,
    child,
    events,
    env: { DSH_HOME: dshHome, OPENAI_API_KEY: 'sk-test-secret-value' },
  });
  const session = await sessionPromise;

  const resultPromise = session.execute('secret');
  const sessionFile = makeDshSession(dshHome, dir);
  appendDshEvents(sessionFile, [
    toolCall(1, 'secret-call', 'bash', { command: 'echo token' }),
    toolResult(2, 'secret-call', 'api_key: sk-test-secret-value from /root/.dsh/.credentials.yaml'),
  ]);
  await delay(400);
  child.close(0);
  await resultPromise;

  const contents = events.map((event) => event.content).join('\n');
  assert.match(contents, /\[redacted\]/);
  assert.match(contents, /\[DSH credentials file\]/);
  assert.doesNotMatch(contents, /sk-test-secret-value/);
});

test('local AI DSH non-zero exit fails with a clear error', async (t) => {
  const { dir, cleanup } = tempDir('dsh-fail');
  t.after(cleanup);
  const launcher = makeLauncher(dir);
  const events: AgentEvent[] = [];
  const child = new FakeChild();
  const { session: sessionPromise } = makeSession({ dir, launcherPath: launcher, child, events });
  const session = await sessionPromise;

  const resultPromise = session.execute('fail task');
  child.close(7);
  const result = await resultPromise;

  assert.equal(result.status, 'failed');
  assert.match(result.error ?? '', /exit code 7/);
  assert.ok(events.some((event) => event.type === 'error' && event.content.includes('exit code 7')));
});

test('local AI DSH cancellation terminates the subprocess', async (t) => {
  const { dir, cleanup } = tempDir('dsh-cancel');
  t.after(cleanup);
  const launcher = makeLauncher(dir);
  const child = new FakeChild();
  const { session: sessionPromise } = makeSession({ dir, launcherPath: launcher, child });
  const session = await sessionPromise;

  const resultPromise = session.execute('long task');
  await session.abort();
  child.close(null, 'SIGTERM');
  const result = await resultPromise;

  assert.equal(result.status, 'failed');
  assert.match(result.error ?? '', /cancelled/);
  assert.deepEqual(child.signals, ['SIGTERM']);
});

test('sanitizeOutput redacts sensitive env values and credential references', () => {
  process.env.AGENTBOARD_TEST_TOKEN = 'super-sensitive-token';
  try {
    const output = sanitizeOutput('token=super-sensitive-token from /root/.dsh/.credentials.yaml');
    assert.doesNotMatch(output, /super-sensitive-token/);
    assert.match(output, /\[redacted\]/);
    assert.match(output, /\[DSH credentials file\]/);
  } finally {
    delete process.env.AGENTBOARD_TEST_TOKEN;
  }
});
