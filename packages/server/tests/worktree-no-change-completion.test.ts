import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import type { AgentProvider } from '@codewithdan/agent-sdk-core';
import type { AgentEvent, Task } from '../src/types.js';
import { AgentManager } from '../src/services/agent-manager.js';
import { LocalOpenAIProvider } from '../src/services/local-openai-provider.js';

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
}

function fixture(): { repoPath: string; dispose(): void } {
  const repoPath = mkdtempSync(path.join(os.tmpdir(), 'agentboard-no-change-repo-'));
  git(['init', '-b', 'main'], repoPath);
  git(['config', 'user.email', 'agentboard-tests@example.invalid'], repoPath);
  git(['config', 'user.name', 'Agent Board Tests'], repoPath);
  writeFileSync(path.join(repoPath, 'README.md'), 'base\n');
  git(['add', 'README.md'], repoPath);
  git(['commit', '-m', 'base'], repoPath);
  return {
    repoPath,
    dispose() {
      try { git(['worktree', 'prune'], repoPath); } catch { /* already gone */ }
      rmSync(repoPath, { recursive: true, force: true });
    },
  };
}

function task(repoPath: string, branchName: string): Task {
  return {
    id: randomUUID(),
    title: 'No-op local coding task',
    description: '',
    priority: 'medium',
    columnId: 'in-progress',
    agentStatus: 'planning',
    createdAt: Date.now(),
    projectId: 'project-1',
    repoPath,
    branchName,
    baseBranch: 'main',
    useWorktree: true,
    agentType: 'local-openai',
  };
}

function cleanupTaskWorktree(repoPath: string, worktreePath?: string): void {
  if (worktreePath) {
    try { git(['worktree', 'remove', worktreePath, '--force'], repoPath); } catch { /* already removed */ }
    rmSync(worktreePath, { recursive: true, force: true });
  }
}

class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  killed = false;

  kill(): boolean {
    this.killed = true;
    return true;
  }

  close(code: number | null): void {
    this.emit('close', code, null);
  }
}

function registerDshProvider(
  manager: AgentManager,
  execute: (workingDirectory: string, child: FakeChild) => void,
  capturePrompt?: (prompt: string) => void,
): void {
  const launcher = path.join(os.tmpdir(), `agentboard-dsh-launcher-${randomUUID()}.js`);
  writeFileSync(launcher, '#!/usr/bin/env node\n');
  const provider = new LocalOpenAIProvider({
    env: {
      DSH_LAUNCHER_PATH: launcher,
      DSH_HOME: '/tmp/test-dsh-home',
      DSH_PROFILE: 'headless',
      LOCAL_OPENAI_DISPLAY_NAME: 'Fake Local AI',
      LOCAL_OPENAI_MODEL: 'Qwen R9700',
    },
    spawnCommand: (_command, args, options) => {
      capturePrompt?.(args[3]);
      const child = new FakeChild();
      queueMicrotask(() => execute(options.cwd, child));
      return child;
    },
  }) as unknown as AgentProvider;
  (manager as unknown as { providers: Map<string, AgentProvider> }).providers.set('local-openai', provider);
  (manager as unknown as { availableAgents: Array<{ name: string; displayName: string; available: boolean }> }).availableAgents = [
    { name: 'local-openai', displayName: 'Fake Local AI', available: true },
  ];
}

test('managed local AI coding run receives repository mutation contract in final prompt', async () => {
  const f = fixture();
  const manager = new AgentManager();
  const events: AgentEvent[] = [];
  manager.initEventPersistence({
    getById: async (id: string) => id === t.id ? t : undefined,
    getRelationships: async () => [],
    clearRun: async () => {},
    insertEvent: async (event: AgentEvent) => { events.push(event); },
    getEventsByTaskId: async (taskId: string) => events.filter((event) => event.taskId === taskId),
    update: async (id: string, changes: Partial<Task>) => id === t.id ? Object.assign(t, changes) : undefined,
  } as unknown as Parameters<AgentManager['initEventPersistence']>[0]);
  let finalPrompt = '';
  registerDshProvider(
    manager,
    (workingDirectory, child) => {
      writeFileSync(path.join(workingDirectory, 'prompt-contract.txt'), 'contract verified\n');
      child.stdout.write('<task-summary>\n## Completed\nFocused tests passed: fake prompt capture.\nHostile review passed: fake review.\n</task-summary>\n');
      child.close(0);
    },
    (prompt) => { finalPrompt = prompt; },
  );

  const t = {
    ...task(f.repoPath, 'smoke/dsh-prompt-contract'),
    title: '3. v0.4 Strengthen Local AI coding harness prompt contract',
    description: [
      'Task details (authoritative; follow this when it conflicts with the display title):',
      'Update the Local AI/DeepSeek-compatible coding harness prompt so coding tasks receive an explicit repository-mutation contract before execution.',
      '',
      'Validation:',
      '- Capture the final prompt supplied to a mocked Local AI coding run.',
      '- Verify the repository-mutation contract is present.',
      '- Confirm existing task description and validation instructions remain intact.',
    ].join('\n'),
  };
  try {
    const finalStatus = await new Promise<Task['agentStatus']>((resolve) => {
      manager.startAgent(
        t,
        (status) => {
          t.agentStatus = status;
          if (status === 'complete' || status === 'failed') resolve(status);
        },
        (worktreePath) => { t.worktreePath = worktreePath; },
      );
    });

    assert.equal(finalStatus, 'complete');
    assert.ok(t.worktreePath);
    assert.match(finalPrompt, /Task mode: Coding task/);
    assert.match(finalPrompt, /Implementation must occur inside the managed task worktree:/);
    assert.match(finalPrompt, /Coding tasks are repository-mutation tasks/);
    assert.match(finalPrompt, /Do not report coding completion based only on analysis, planning, proposed code/);
    assert.match(finalPrompt, /verify there is a non-empty git diff or a task-owned commit/);
    assert.match(finalPrompt, /requested implementation already exists, report that condition explicitly/);
    assert.match(finalPrompt, /blocked by permissions, sandboxing, missing dependencies, or external validation/);
    assert.match(finalPrompt, /Update the Local AI\/DeepSeek-compatible coding harness prompt/);
    assert.match(finalPrompt, /Capture the final prompt supplied to a mocked Local AI coding run/);
    assert.match(finalPrompt, /Focused tests passed:/);
    assert.match(finalPrompt, /Hostile review passed:/);
    assert.match(finalPrompt, /Display title \(for board identification only\):\n3\. v0\.4 Strengthen Local AI coding harness prompt contract/);
    assert.doesNotMatch(finalPrompt, /VoxelSurvival/);
  } finally {
    cleanupTaskWorktree(f.repoPath, t.worktreePath);
    f.dispose();
  }
});

test('managed local AI automatically retries once after no repository changes and completes when retry changes files', async () => {
  const f = fixture();
  const manager = new AgentManager();
  const events: AgentEvent[] = [];
  manager.initEventPersistence({
    getById: async (id: string) => id === t.id ? t : undefined,
    getRelationships: async () => [],
    clearRun: async () => {},
    insertEvent: async (event: AgentEvent) => { events.push(event); },
    getEventsByTaskId: async (taskId: string) => events.filter((event) => event.taskId === taskId),
    update: async (id: string, changes: Partial<Task>) => id === t.id ? Object.assign(t, changes) : undefined,
  } as unknown as Parameters<AgentManager['initEventPersistence']>[0]);
  let attempts = 0;
  const worktreePaths: string[] = [];
  const prompts: string[] = [];
  registerDshProvider(manager, (workingDirectory, child) => {
    attempts += 1;
    worktreePaths.push(workingDirectory);
    if (attempts === 2) {
      writeFileSync(path.join(workingDirectory, 'recovered.txt'), 'changed on recovery\n');
      child.stdout.write('<task-summary>\n## Completed\nFocused tests passed: fake DSH recovery.\nHostile review passed: fake review.\n</task-summary>\n');
    } else {
      child.stdout.write('VERBOSE TOOL OUTPUT '.repeat(500));
    }
    child.close(0);
  }, (prompt) => { prompts.push(prompt); });

  const t = task(f.repoPath, 'smoke/no-change-local-ai');
  try {
    const statuses: Task['agentStatus'][] = [];
    const finalStatus = await new Promise<Task['agentStatus']>((resolve) => {
      manager.startAgent(
        t,
        (status) => {
          statuses.push(status);
          t.agentStatus = status;
          if (status === 'complete' || status === 'failed') resolve(status);
        },
        (worktreePath) => { t.worktreePath = worktreePath; },
      );
    });

    assert.equal(finalStatus, 'complete');
    assert.equal(attempts, 2);
    assert.deepEqual(statuses.filter((status) => status === 'complete' || status === 'failed'), ['complete']);
    assert.ok(t.worktreePath);
    assert.deepEqual(worktreePaths, [t.worktreePath, t.worktreePath]);
    assert.equal(prompts.length, 2);
    assert.doesNotMatch(prompts[0], /Continuation context/);
    assert.match(prompts[1], /Continuation context \(compacted; prior tool output is intentionally summarized, not replayed\):/);
    assert.match(prompts[1], /Current diff state:/);
    assert.match(prompts[1], /Internal recovery instruction:/);
    assert.doesNotMatch(prompts[1], /VERBOSE TOOL OUTPUT VERBOSE TOOL OUTPUT/);
    assert.equal(git(['status', '--porcelain'], t.worktreePath), '');
    assert.equal(git(['rev-list', '--count', 'main..smoke/no-change-local-ai'], f.repoPath), '1');
    assert.equal(git(['show', '--format=', '--name-only', 'smoke/no-change-local-ai'], f.repoPath), 'recovered.txt');
    assert.ok(events.some((event) =>
      event.type === 'output' &&
      event.content.includes('Automatic recovery retry triggered') &&
      event.content.includes('empty repository result'),
    ));
    const contextEvents = events.filter((event) => event.metadata?.contextBudget);
    assert.equal(contextEvents.length, 2);
    assert.ok(contextEvents.every((event) => event.metadata?.contextBudget?.maxContextTokens === 128_000));
  } finally {
    cleanupTaskWorktree(f.repoPath, t.worktreePath);
    f.dispose();
  }
});

test('managed local AI fails safely before launch when prompt exceeds context budget threshold', async () => {
  const f = fixture();
  const manager = new AgentManager();
  const events: AgentEvent[] = [];
  manager.initEventPersistence({
    getById: async (id: string) => id === t.id ? t : undefined,
    getRelationships: async () => [],
    clearRun: async () => {},
    insertEvent: async (event: AgentEvent) => { events.push(event); },
    getEventsByTaskId: async (taskId: string) => events.filter((event) => event.taskId === taskId),
    update: async (id: string, changes: Partial<Task>) => id === t.id ? Object.assign(t, changes) : undefined,
  } as unknown as Parameters<AgentManager['initEventPersistence']>[0]);
  let attempts = 0;
  registerDshProvider(manager, (_workingDirectory, child) => {
    attempts += 1;
    child.close(0);
  });

  const previousLimit = process.env.LOCAL_AI_CONTEXT_LIMIT_TOKENS;
  process.env.LOCAL_AI_CONTEXT_LIMIT_TOKENS = '100';
  const t = {
    ...task(f.repoPath, 'smoke/context-budget-local-ai'),
    description: 'oversized prompt '.repeat(200),
  };
  try {
    const finalStatus = await new Promise<Task['agentStatus']>((resolve) => {
      manager.startAgent(
        t,
        (status) => {
          t.agentStatus = status;
          if (status === 'complete' || status === 'failed') resolve(status);
        },
        (worktreePath) => { t.worktreePath = worktreePath; },
      );
    });

    assert.equal(finalStatus, 'failed');
    assert.equal(attempts, 0);
    assert.ok(events.some((event) =>
      event.type === 'error' &&
      event.content.includes('Local AI context budget would exceed the safe launch threshold') &&
      event.metadata?.contextBudget?.state === 'exhausted',
    ));
  } finally {
    if (previousLimit === undefined) {
      delete process.env.LOCAL_AI_CONTEXT_LIMIT_TOKENS;
    } else {
      process.env.LOCAL_AI_CONTEXT_LIMIT_TOKENS = previousLimit;
    }
    cleanupTaskWorktree(f.repoPath, t.worktreePath);
    f.dispose();
  }
});

test('managed worktree completion gate stops after two consecutive no-change attempts', async () => {
  const f = fixture();
  const manager = new AgentManager();
  const events: AgentEvent[] = [];
  manager.initEventPersistence({
    getById: async (id: string) => id === t.id ? t : undefined,
    getRelationships: async () => [],
    clearRun: async () => {},
    insertEvent: async (event: AgentEvent) => { events.push(event); },
    getEventsByTaskId: async (taskId: string) => events.filter((event) => event.taskId === taskId),
    update: async (id: string, changes: Partial<Task>) => id === t.id ? Object.assign(t, changes) : undefined,
  } as unknown as Parameters<AgentManager['initEventPersistence']>[0]);
  let attempts = 0;
  const prompts: string[] = [];
  const provider = {
    displayName: 'Fake Codex',
    start: async () => {},
    stop: async () => {},
    createSession: async () => ({
      execute: async (prompt: string) => {
        attempts += 1;
        prompts.push(prompt);
        return { status: 'complete' as const };
      },
      destroy: async () => {},
      abort: async () => {},
    }),
  } as unknown as AgentProvider;
  (manager as unknown as { providers: Map<string, AgentProvider> }).providers.set('codex', provider);
  (manager as unknown as { availableAgents: Array<{ name: string; displayName: string; available: boolean }> }).availableAgents = [
    { name: 'codex', displayName: 'Fake Codex', available: true },
  ];

  const t = { ...task(f.repoPath, 'smoke/no-change-codex'), agentType: 'codex' as const };
  try {
    const finalStatus = await new Promise<Task['agentStatus']>((resolve) => {
      manager.startAgent(
        t,
        (status) => {
          t.agentStatus = status;
          if (status === 'complete' || status === 'failed') resolve(status);
        },
        (worktreePath) => { t.worktreePath = worktreePath; },
      );
    });

    assert.equal(finalStatus, 'failed');
    assert.equal(attempts, 2);
    assert.ok(t.worktreePath);
    assert.equal(git(['rev-list', '--count', 'main..smoke/no-change-codex'], f.repoPath), '0');
    assert.equal(prompts[0].includes('This is a coding task. You must implement the requested change'), false);
    assert.equal(prompts[1].includes('This is a coding task. You must implement the requested change'), true);
    assert.equal(events.filter((event) => event.content.includes('Automatic recovery retry triggered')).length, 1);
    assert.ok(events.some((event) =>
      event.type === 'error' &&
      event.content.includes('Coding task completed without repository changes.'),
    ));
  } finally {
    cleanupTaskWorktree(f.repoPath, t.worktreePath);
    f.dispose();
  }
});

test('managed local AI DSH exit 0 passes when the task branch already has a commit ahead of base', async () => {
  const f = fixture();
  const manager = new AgentManager();
  const events: AgentEvent[] = [];
  manager.initEventPersistence({
    getById: async (id: string) => id === t.id ? t : undefined,
    getRelationships: async () => [],
    clearRun: async () => {},
    insertEvent: async (event: AgentEvent) => { events.push(event); },
    getEventsByTaskId: async (taskId: string) => events.filter((event) => event.taskId === taskId),
    update: async (id: string, changes: Partial<Task>) => id === t.id ? Object.assign(t, changes) : undefined,
  } as unknown as Parameters<AgentManager['initEventPersistence']>[0]);
  registerDshProvider(manager, (workingDirectory, child) => {
    writeFileSync(path.join(workingDirectory, 'already-committed.txt'), 'committed by agent\n');
    git(['add', 'already-committed.txt'], workingDirectory);
    git(['commit', '-m', 'agent-owned commit'], workingDirectory);
    child.stdout.write('<task-summary>\n## Completed\nFocused tests passed: fake DSH.\nHostile review passed: fake review.\n</task-summary>\n');
    child.close(0);
  });

  const t = task(f.repoPath, 'smoke/dsh-precommitted-local-ai');
  try {
    const finalStatus = await new Promise<Task['agentStatus']>((resolve) => {
      manager.startAgent(
        t,
        (status) => {
          t.agentStatus = status;
          if (status === 'complete' || status === 'failed') resolve(status);
        },
        (worktreePath) => { t.worktreePath = worktreePath; },
      );
    });

    assert.equal(finalStatus, 'complete');
    assert.ok(t.worktreePath);
    assert.equal(git(['status', '--porcelain'], t.worktreePath), '');
    assert.equal(git(['rev-list', '--count', 'main..smoke/dsh-precommitted-local-ai'], f.repoPath), '1');
    assert.equal(git(['log', '-1', '--format=%s', 'smoke/dsh-precommitted-local-ai'], f.repoPath), 'agent-owned commit');
    assert.equal(events.some((event) => event.content.includes('Coding task completed without repository changes.')), false);
  } finally {
    cleanupTaskWorktree(f.repoPath, t.worktreePath);
    f.dispose();
  }
});

test('managed local AI DSH exit 0 commits worktree changes before completion', async () => {
  const f = fixture();
  const manager = new AgentManager();
  const events: AgentEvent[] = [];
  manager.initEventPersistence({
    getById: async (id: string) => id === t.id ? t : undefined,
    getRelationships: async () => [],
    clearRun: async () => {},
    insertEvent: async (event: AgentEvent) => { events.push(event); },
    getEventsByTaskId: async (taskId: string) => events.filter((event) => event.taskId === taskId),
    update: async (id: string, changes: Partial<Task>) => id === t.id ? Object.assign(t, changes) : undefined,
  } as unknown as Parameters<AgentManager['initEventPersistence']>[0]);
  registerDshProvider(manager, (workingDirectory, child) => {
    writeFileSync(path.join(workingDirectory, 'dsh-output.txt'), 'changed by dsh\n');
    child.stdout.write('<task-summary>\n## Completed\nFocused tests passed: fake DSH.\nHostile review passed: fake review.\n</task-summary>\n');
    child.close(0);
  });

  const t = task(f.repoPath, 'smoke/dsh-change-local-ai');
  try {
    const finalStatus = await new Promise<Task['agentStatus']>((resolve) => {
      manager.startAgent(
        t,
        (status) => {
          t.agentStatus = status;
          if (status === 'complete' || status === 'failed') resolve(status);
        },
        (worktreePath) => { t.worktreePath = worktreePath; },
      );
    });

    assert.equal(finalStatus, 'complete');
    assert.ok(t.worktreePath);
    assert.equal(git(['status', '--porcelain'], t.worktreePath), '');
    assert.equal(git(['rev-list', '--count', 'main..smoke/dsh-change-local-ai'], f.repoPath), '1');
    assert.ok(events.some((event) =>
      event.type === 'output' &&
      event.content.includes('Committed worktree changes on smoke/dsh-change-local-ai'),
    ));
  } finally {
    cleanupTaskWorktree(f.repoPath, t.worktreePath);
    f.dispose();
  }
});

test('read-only task without a managed worktree is not rejected for lacking repository changes', async () => {
  const f = fixture();
  const manager = new AgentManager();
  const events: AgentEvent[] = [];
  manager.initEventPersistence({
    getById: async (id: string) => id === t.id ? t : undefined,
    getRelationships: async () => [],
    clearRun: async () => {},
    insertEvent: async (event: AgentEvent) => { events.push(event); },
    getEventsByTaskId: async (taskId: string) => events.filter((event) => event.taskId === taskId),
    update: async (id: string, changes: Partial<Task>) => id === t.id ? Object.assign(t, changes) : undefined,
  } as unknown as Parameters<AgentManager['initEventPersistence']>[0]);
  registerDshProvider(manager, (_workingDirectory, child) => {
    child.stdout.write('<task-summary>\n## Completed\nRead-only inspection completed.\n</task-summary>\n');
    child.close(0);
  });

  const t = {
    ...task(f.repoPath, 'smoke/read-only-local-ai'),
    title: 'Read-only local task',
    useWorktree: false,
    branchName: undefined,
    baseBranch: undefined,
  };
  try {
    const finalStatus = await new Promise<Task['agentStatus']>((resolve) => {
      manager.startAgent(t, (status) => {
        t.agentStatus = status;
        if (status === 'complete' || status === 'failed') resolve(status);
      });
    });

    assert.equal(finalStatus, 'complete');
    assert.equal(t.worktreePath, undefined);
    assert.equal(events.some((event) => event.content.includes('Coding task completed without repository changes.')), false);
  } finally {
    f.dispose();
  }
});
