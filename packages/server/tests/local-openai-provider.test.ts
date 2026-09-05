import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { setImmediate as tick } from 'node:timers/promises';
import type { AgentEvent } from '@codewithdan/agent-sdk-core';
import { isValidAgentType } from '@ai-agent-board/shared/constants.js';
import {
  detectLocalOpenAIAgent,
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

test('local AI DSH stdout and stderr are surfaced with credential redaction', async (t) => {
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
  assert.match(contents, /\[DSH credentials file\]/);
  assert.doesNotMatch(contents, /sk-test-secret-value/);
});

test('local AI DSH activity records are normalized before process completion', async (t) => {
  const { dir, cleanup } = tempDir('dsh-live-activity');
  t.after(cleanup);
  const launcher = makeLauncher(dir);
  const events: AgentEvent[] = [];
  const child = new FakeChild();
  const { session: sessionPromise } = makeSession({ dir, launcherPath: launcher, child, events });
  const session = await sessionPromise;

  const resultPromise = session.execute('stream activity while working');
  child.stdout.write('data: {"event":"tool_start","tool":"read_file","args":{"path":"packages/server/src/index.ts"},"message":"Reading server entry"}\n');
  child.stdout.write('{"event":"command_start","command":"npm run build:server","message":"Running server build"}\n');
  child.stdout.write('{"event":"tool_start","tool":"edit_file","args":{"path":"safe.ts"},"reasoning":"private chain of thought"}\n');
  child.stdout.write('Edited file: packages/server/src/services/local-openai-provider.ts\n');
  child.stderr.write('harness debug still raw\n');
  child.stdout.write('Focused tests passed: representative DSH stream\n');
  await tick();

  assert.equal(child.killed, false);
  assert.ok(events.some((event) =>
    event.type === 'file_read' &&
    event.metadata?.file === 'packages/server/src/index.ts' &&
    event.metadata?.agentType === 'local-openai'
  ));
  assert.ok(events.some((event) =>
    event.type === 'command' &&
    event.metadata?.command === 'npm run build:server'
  ));
  assert.ok(events.some((event) =>
    event.type === 'file_edit' &&
    event.metadata?.file === 'packages/server/src/services/local-openai-provider.ts'
  ));
  assert.ok(events.some((event) =>
    event.type === 'file_edit' &&
    event.metadata?.file === 'safe.ts' &&
    event.content === 'Edited safe.ts'
  ));
  assert.doesNotMatch(events.map((event) => event.content).join('\n'), /private chain of thought/);
  assert.ok(events.some((event) =>
    event.type === 'command_output' &&
    event.content.includes('harness debug still raw')
  ));
  assert.ok(events.some((event) =>
    event.type === 'test_result' &&
    event.content.includes('Focused tests passed')
  ));

  child.close(0);
  const result = await resultPromise;
  assert.equal(result.status, 'complete');
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
