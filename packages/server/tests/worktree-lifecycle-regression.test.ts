import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import type { AgentProvider } from '@codewithdan/agent-sdk-core';
import type { AgentEvent, ExecutionAttempt, Task, TaskRelationship } from '../src/types.js';
import { AgentManager } from '../src/services/agent-manager.js';
import { startAgentForTask } from '../src/routes/helpers.js';
import type { ContinuationEligibility, OrchestrationAggregateResult, TaskRepository } from '../src/repositories/types.js';

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
}

function fixture(): { repoPath: string; dispose(): void } {
  const repoPath = mkdtempSync(path.join(os.tmpdir(), 'agentboard-lifecycle-repo-'));
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
    title: 'Smoke codex sum',
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
    agentType: 'codex',
  };
}

function writeWorkspaceSmokeProject(repoPath: string, buildScript: string): void {
  mkdirSync(path.join(repoPath, 'shared'), { recursive: true });
  writeFileSync(path.join(repoPath, '.gitignore'), 'node_modules/\nshared/dist/\n');
  writeFileSync(path.join(repoPath, 'package.json'), JSON.stringify({
    private: true,
    workspaces: ['shared'],
    scripts: {
      'build:shared': buildScript,
    },
  }, null, 2));
  writeFileSync(path.join(repoPath, 'shared', 'package.json'), JSON.stringify({
    name: '@agentboard-smoke/shared',
    version: '1.0.0',
  }, null, 2));
  writeFileSync(path.join(repoPath, 'package-lock.json'), JSON.stringify({
    name: 'agentboard-smoke',
    lockfileVersion: 3,
    requires: true,
    packages: {
      '': {
        workspaces: ['shared'],
      },
      'node_modules/@agentboard-smoke/shared': {
        resolved: 'shared',
        link: true,
      },
      shared: {
        name: '@agentboard-smoke/shared',
        version: '1.0.0',
      },
    },
  }, null, 2));
  git(['add', '.gitignore', 'package.json', 'package-lock.json', 'shared/package.json'], repoPath);
  git(['commit', '-m', 'add npm workspace smoke project'], repoPath);
}

function cleanupTaskWorktree(repoPath: string, worktreePath?: string): void {
  if (worktreePath) {
    try { git(['worktree', 'remove', worktreePath, '--force'], repoPath); } catch { /* already removed */ }
    rmSync(worktreePath, { recursive: true, force: true });
  }
}

class MemoryTaskRepo implements TaskRepository {
  task: Task;
  events: AgentEvent[] = [];

  constructor(task: Task) {
    this.task = { ...task };
  }

  async getAll(): Promise<Task[]> { return [{ ...this.task }]; }
  async getById(id: string): Promise<Task | undefined> { return id === this.task.id ? { ...this.task } : undefined; }
  async getByExternalIdentity(): Promise<Task | undefined> { return undefined; }
  async resolve(): Promise<Task[]> { return []; }
  async create(task: Task): Promise<Task> { this.task = { ...task }; return { ...this.task }; }
  async createIdempotent(task: Task): Promise<{ task: Task; created: boolean }> {
    this.task = { ...task };
    return { task: { ...this.task }, created: true };
  }
  async requestRun(id: string, requestedAt: number): Promise<Task | undefined> {
    return this.update(id, { runRequestedAt: requestedAt });
  }
  async claimRun(id: string, claimedAt: number): Promise<Task | undefined> {
    return this.update(id, { runClaimedAt: claimedAt });
  }
  async clearRun(id: string): Promise<Task | undefined> {
    return this.update(id, { runRequestedAt: undefined, runClaimedAt: undefined });
  }
  async getPendingRuns(): Promise<Task[]> { return []; }
  async update(id: string, updates: Partial<Task>): Promise<Task | undefined> {
    if (id !== this.task.id) return undefined;
    const next = { ...this.task, ...updates } as Record<string, unknown>;
    for (const [key, value] of Object.entries(updates)) {
      if (value === undefined) delete next[key];
    }
    this.task = next as unknown as Task;
    return { ...this.task };
  }
  async delete(): Promise<boolean> { return true; }
  async count(): Promise<number> { return 1; }
  async insertEvent(event: AgentEvent): Promise<void> { this.events.push(event); }
  async getEventsByTaskId(taskId: string): Promise<AgentEvent[]> {
    return this.events.filter((event) => event.taskId === taskId);
  }
  async deleteEventsByTaskId(taskId: string): Promise<void> {
    this.events = this.events.filter((event) => event.taskId !== taskId);
  }
  async getArchivedTasks(): Promise<Task[]> { return []; }
  async getRelationships(): Promise<TaskRelationship[]> { return []; }
  async createRelationship(taskId: string, relatedTaskId: string, createdAt: number): Promise<{ relationship: TaskRelationship; created: boolean }> {
    return { relationship: { taskId, relatedTaskId, type: 'related', createdAt }, created: true };
  }
  async createDependency(prerequisiteTaskId: string, dependentTaskId: string, createdAt: number): Promise<{ relationship: TaskRelationship; created: boolean }> {
    return { relationship: { taskId: dependentTaskId, relatedTaskId: prerequisiteTaskId, type: 'blocks', direction: 'blocked-by', createdAt }, created: true };
  }
  async deleteRelationship(): Promise<boolean> { return true; }
  async getAttemptById(): Promise<ExecutionAttempt | undefined> { return undefined; }
  async getAttemptByExternalIdentity(): Promise<ExecutionAttempt | undefined> { return undefined; }
  async getAttemptsByTaskId(): Promise<ExecutionAttempt[]> { return []; }
  async createAttemptIdempotent(attempt: ExecutionAttempt): Promise<{ attempt: ExecutionAttempt; created: boolean }> {
    return { attempt, created: true };
  }
  async createOrchestration(task: Task, attempt: ExecutionAttempt): Promise<OrchestrationAggregateResult> {
    this.task = { ...task };
    return { task: { ...this.task }, attempt, created: true };
  }
  async continueOrchestration(
    taskId: string,
    updates: Partial<Task>,
    attempt: ExecutionAttempt,
    _relatedTaskId?: string,
    _relationshipCreatedAt?: number,
    _eligibility?: ContinuationEligibility,
  ): Promise<OrchestrationAggregateResult | undefined> {
    const task = await this.update(taskId, updates);
    return task ? { task, attempt, created: true } : undefined;
  }
}

function registerFakeProvider(manager: AgentManager, execute: (workingDirectory: string) => Promise<{ status: 'complete' | 'failed'; error?: string; output?: string }>): void {
  const provider = {
    displayName: 'Fake Codex',
    start: async () => {},
    stop: async () => {},
    createSession: async ({ workingDirectory, onEvent }: { workingDirectory: string; onEvent?: (event: { id: string; type: string; content: string; timestamp: number; metadata?: Record<string, unknown> }) => void }) => ({
      execute: async () => {
        const result = await execute(workingDirectory);
        if (result.output) {
          onEvent?.({ id: randomUUID(), type: 'output', content: result.output, timestamp: Date.now() });
        }
        return result;
      },
      destroy: async () => {},
      abort: async () => {},
    }),
  } as unknown as AgentProvider;
  (manager as unknown as { providers: Map<string, AgentProvider> }).providers.set('codex', provider);
  (manager as unknown as { availableAgents: Array<{ name: string; displayName: string; available: boolean }> }).availableAgents = [
    { name: 'codex', displayName: 'Fake Codex', available: true },
  ];
}

async function waitForTerminal(repo: MemoryTaskRepo): Promise<Task> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (repo.task.agentStatus === 'complete' || repo.task.agentStatus === 'failed') return { ...repo.task };
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('timed out waiting for terminal task status');
}

test('setupWorktree creates a missing task branch from the selected base branch', () => {
  const f = fixture();
  const manager = new AgentManager();
  const t = task(f.repoPath, 'smoke/codex-sum');
  let worktreePath: string | undefined;
  try {
    worktreePath = manager.setupWorktree(t);
    assert.ok(worktreePath);
    assert.equal(git(['branch', '--show-current'], worktreePath), 'smoke/codex-sum');
    assert.equal(git(['rev-parse', 'smoke/codex-sum'], f.repoPath), git(['rev-parse', 'main'], f.repoPath));
  } finally {
    cleanupTaskWorktree(f.repoPath, worktreePath);
    f.dispose();
  }
});

test('setupWorktree attaches an existing branch without resetting it', () => {
  const f = fixture();
  const manager = new AgentManager();
  const branchName = 'smoke/existing-branch';
  git(['checkout', '-b', branchName], f.repoPath);
  writeFileSync(path.join(f.repoPath, 'existing.txt'), 'existing branch content\n');
  git(['add', 'existing.txt'], f.repoPath);
  git(['commit', '-m', 'existing branch work'], f.repoPath);
  const branchHead = git(['rev-parse', branchName], f.repoPath);
  git(['checkout', 'main'], f.repoPath);

  const t = task(f.repoPath, branchName);
  let worktreePath: string | undefined;
  try {
    worktreePath = manager.setupWorktree(t);
    assert.ok(worktreePath);
    assert.equal(git(['branch', '--show-current'], worktreePath), branchName);
    assert.equal(git(['rev-parse', 'HEAD'], worktreePath), branchHead);
    assert.equal(existsSync(path.join(worktreePath, 'existing.txt')), true);
  } finally {
    cleanupTaskWorktree(f.repoPath, worktreePath);
    f.dispose();
  }
});

test('successful agent completion commits worktree changes before marking complete', async () => {
  const f = fixture();
  const manager = new AgentManager();
  const provider = {
    displayName: 'Fake Codex',
    start: async () => {},
    stop: async () => {},
    createSession: async ({ workingDirectory }: { workingDirectory: string }) => ({
      execute: async () => {
        writeFileSync(path.join(workingDirectory, 'sum.txt'), 'sum = 42\n');
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

  const t = task(f.repoPath, 'smoke/codex-sum');
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
    assert.equal(git(['show', '--format=', '--name-only', t.branchName!], f.repoPath), 'sum.txt');
    assert.match(git(['log', '-1', '--format=%s', t.branchName!], f.repoPath), /^Agent Board: Smoke codex sum/);
  } finally {
    cleanupTaskWorktree(f.repoPath, t.worktreePath);
    f.dispose();
  }
});

test('dependency provisioning failure prevents agent execution and preserves the worktree', async () => {
  const f = fixture();
  const previousThreshold = process.env.AGENTBOARD_WORKTREE_MIN_FREE_SPACE_BYTES;
  process.env.AGENTBOARD_WORKTREE_MIN_FREE_SPACE_BYTES = '1';
  writeFileSync(path.join(f.repoPath, 'package.json'), '{"broken":');
  writeFileSync(path.join(f.repoPath, 'package-lock.json'), '{}');
  git(['add', 'package.json', 'package-lock.json'], f.repoPath);
  git(['commit', '-m', 'add broken npm project'], f.repoPath);

  const manager = new AgentManager();
  let createSessionCalled = false;
  const provider = {
    displayName: 'Fake Codex',
    start: async () => {},
    stop: async () => {},
    createSession: async () => {
      createSessionCalled = true;
      return {
        execute: async () => ({ status: 'complete' as const }),
        destroy: async () => {},
        abort: async () => {},
      };
    },
  } as unknown as AgentProvider;
  (manager as unknown as { providers: Map<string, AgentProvider> }).providers.set('codex', provider);
  (manager as unknown as { availableAgents: Array<{ name: string; displayName: string; available: boolean }> }).availableAgents = [
    { name: 'codex', displayName: 'Fake Codex', available: true },
  ];

  const t = task(f.repoPath, 'smoke/npm-provisioning-fails');
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
    assert.equal(createSessionCalled, false);
    assert.ok(t.worktreePath);
    assert.equal(existsSync(t.worktreePath), true);
    assert.equal(existsSync(path.join(t.worktreePath, 'package.json')), true);
  } finally {
    if (previousThreshold === undefined) delete process.env.AGENTBOARD_WORKTREE_MIN_FREE_SPACE_BYTES;
    else process.env.AGENTBOARD_WORKTREE_MIN_FREE_SPACE_BYTES = previousThreshold;
    cleanupTaskWorktree(f.repoPath, t.worktreePath);
    f.dispose();
  }
});

test('isolated npm workspace bootstrap runs after provisioning and before agent start', async () => {
  const f = fixture();
  const previousThreshold = process.env.AGENTBOARD_WORKTREE_MIN_FREE_SPACE_BYTES;
  process.env.AGENTBOARD_WORKTREE_MIN_FREE_SPACE_BYTES = '1';
  writeWorkspaceSmokeProject(
    f.repoPath,
    'node -e "require(\'fs\').mkdirSync(\'shared/dist\',{recursive:true}); require(\'fs\').writeFileSync(\'shared/dist/index.js\',\'built\\\\n\')"',
  );

  const manager = new AgentManager();
  const order: string[] = [];
  const provider = {
    displayName: 'Fake Codex',
    start: async () => {},
    stop: async () => {},
    createSession: async ({ workingDirectory }: { workingDirectory: string }) => {
      order.push('agent-start');
      assert.equal(existsSync(path.join(workingDirectory, 'node_modules', '.package-lock.json')), true);
      assert.equal(existsSync(path.join(workingDirectory, 'shared', 'dist', 'index.js')), true);
      return {
        execute: async () => ({ status: 'complete' as const }),
        destroy: async () => {},
        abort: async () => {},
      };
    },
  } as unknown as AgentProvider;
  (manager as unknown as { providers: Map<string, AgentProvider> }).providers.set('codex', provider);
  (manager as unknown as { availableAgents: Array<{ name: string; displayName: string; available: boolean }> }).availableAgents = [
    { name: 'codex', displayName: 'Fake Codex', available: true },
  ];

  const t = task(f.repoPath, 'smoke/npm-workspace-bootstrap');
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
    const events = await manager.getEvents(t.id);
    const contents = events.map((event) => event.content);

    assert.equal(finalStatus, 'complete');
    assert.deepEqual(order, ['agent-start']);
    assert.ok(t.worktreePath);
    assert.equal(existsSync(path.join(t.worktreePath, 'shared', 'dist', 'index.js')), true);
    assert.equal(existsSync(path.join(f.repoPath, 'shared', 'dist', 'index.js')), false);
    assert.equal(git(['status', '--porcelain'], f.repoPath), '');
    assert.ok(contents.some((content) => content.includes('Provisioned npm dependencies inside worktree')));
    assert.ok(contents.some((content) => content.includes('Bootstrapping npm workspace: npm run build:shared.')));
    assert.ok(contents.some((content) => content.includes('npm workspace bootstrap succeeded: npm run build:shared.')));
    assert.ok(
      contents.findIndex((content) => content.includes('Provisioned npm dependencies inside worktree')) <
      contents.findIndex((content) => content.includes('Bootstrapping npm workspace: npm run build:shared.')),
    );
    assert.ok(
      contents.findIndex((content) => content.includes('Bootstrapping npm workspace: npm run build:shared.')) <
      contents.findIndex((content) => content.includes('npm workspace bootstrap succeeded: npm run build:shared.')),
    );
  } finally {
    if (previousThreshold === undefined) delete process.env.AGENTBOARD_WORKTREE_MIN_FREE_SPACE_BYTES;
    else process.env.AGENTBOARD_WORKTREE_MIN_FREE_SPACE_BYTES = previousThreshold;
    cleanupTaskWorktree(f.repoPath, t.worktreePath);
    f.dispose();
  }
});

test('workspace bootstrap failure prevents agent execution and preserves the worktree', async () => {
  const f = fixture();
  const previousThreshold = process.env.AGENTBOARD_WORKTREE_MIN_FREE_SPACE_BYTES;
  process.env.AGENTBOARD_WORKTREE_MIN_FREE_SPACE_BYTES = '1';
  writeWorkspaceSmokeProject(
    f.repoPath,
    'node -e "process.stdout.write(\'build stdout\'); process.stderr.write(\'build stderr\'); process.exit(1)"',
  );

  const manager = new AgentManager();
  let createSessionCalled = false;
  const provider = {
    displayName: 'Fake Codex',
    start: async () => {},
    stop: async () => {},
    createSession: async () => {
      createSessionCalled = true;
      return {
        execute: async () => ({ status: 'complete' as const }),
        destroy: async () => {},
        abort: async () => {},
      };
    },
  } as unknown as AgentProvider;
  (manager as unknown as { providers: Map<string, AgentProvider> }).providers.set('codex', provider);
  (manager as unknown as { availableAgents: Array<{ name: string; displayName: string; available: boolean }> }).availableAgents = [
    { name: 'codex', displayName: 'Fake Codex', available: true },
  ];

  const t = task(f.repoPath, 'smoke/npm-workspace-bootstrap-fails');
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
    const events = await manager.getEvents(t.id);

    assert.equal(finalStatus, 'failed');
    assert.equal(createSessionCalled, false);
    assert.ok(t.worktreePath);
    assert.equal(existsSync(t.worktreePath), true);
    assert.equal(existsSync(path.join(f.repoPath, 'shared', 'dist', 'index.js')), false);
    assert.equal(git(['status', '--porcelain'], f.repoPath), '');
    assert.ok(events.some((event) => event.content.includes('Bootstrapping npm workspace: npm run build:shared.')));
    assert.ok(events.some((event) =>
      event.type === 'error' &&
      event.content.includes('npm workspace bootstrap failed') &&
      event.content.includes('Command failed: npm run build:shared'),
    ));
  } finally {
    if (previousThreshold === undefined) delete process.env.AGENTBOARD_WORKTREE_MIN_FREE_SPACE_BYTES;
    else process.env.AGENTBOARD_WORKTREE_MIN_FREE_SPACE_BYTES = previousThreshold;
    cleanupTaskWorktree(f.repoPath, t.worktreePath);
    f.dispose();
  }
});

test('successful startAgentForTask run auto-merges clean committed worktree and moves task to done', async () => {
  const f = fixture();
  const manager = new AgentManager();
  registerFakeProvider(manager, async (workingDirectory) => {
    writeFileSync(path.join(workingDirectory, 'auto-merged.txt'), 'auto merged\n');
    return {
      status: 'complete',
      output: '<task-summary>\n## Completed\nFocused tests passed: verified auto-merged.txt was written.\nHostile review passed: no regression risks found.\n</task-summary>',
    };
  });

  const repo = new MemoryTaskRepo(task(f.repoPath, 'smoke/auto-merge-done'));
  manager.initEventPersistence(repo);

  try {
    await startAgentForTask(repo.task, repo, manager);
    const finalTask = await waitForTerminal(repo);

    assert.equal(finalTask.agentStatus, 'complete');
    assert.equal(finalTask.columnId, 'done');
    assert.equal(finalTask.worktreePath, undefined);
    assert.equal(existsSync(path.join(f.repoPath, 'auto-merged.txt')), true);
    assert.match(git(['log', '-1', '--format=%s'], f.repoPath), /^Agent Board: Smoke codex sum/);
    assert.ok(repo.events.some((event) => event.content.includes('moved the task to Done')));
  } finally {
    cleanupTaskWorktree(f.repoPath, repo.task.worktreePath);
    f.dispose();
  }
});

test('successful Python test runs with ignored pytest and ruff caches still auto-merge to done', async () => {
  const f = fixture();
  writeFileSync(path.join(f.repoPath, '.gitignore'), [
    '.pytest_cache/',
    '.ruff_cache/',
    '__pycache__/',
    '*.pyc',
    '',
  ].join('\n'));
  git(['add', '.gitignore'], f.repoPath);
  git(['commit', '-m', 'ignore python test caches'], f.repoPath);

  const manager = new AgentManager();
  registerFakeProvider(manager, async (workingDirectory) => {
    writeFileSync(path.join(workingDirectory, 'atlas_task.py'), 'def answer():\n    return 42\n');
    const cacheFiles = [
      ['.pytest_cache', 'v', 'cache', 'nodeids'],
      ['.ruff_cache', 'CACHEDIR.TAG'],
      ['__pycache__', 'atlas_task.cpython-312.pyc'],
      ['tests', '__pycache__', 'test_atlas_task.cpython-312-pytest-8.3.0.pyc'],
    ];
    for (const filePath of cacheFiles) {
      const absolutePath = path.join(workingDirectory, ...filePath);
      mkdirSync(path.dirname(absolutePath), { recursive: true });
      writeFileSync(absolutePath, 'generated by pytest or ruff\n');
    }
    return {
      status: 'complete',
      output: '<task-summary>\n## Completed\nFocused tests passed: pytest and ruff completed and left ignored cache artifacts only.\nHostile review passed: source diff is committed while generated caches remain ignored.\n</task-summary>',
    };
  });

  const repo = new MemoryTaskRepo(task(f.repoPath, 'smoke/python-cache-auto-merge'));
  manager.initEventPersistence(repo);

  try {
    await startAgentForTask(repo.task, repo, manager);
    const finalTask = await waitForTerminal(repo);

    assert.equal(finalTask.agentStatus, 'complete');
    assert.equal(finalTask.columnId, 'done');
    assert.equal(finalTask.worktreePath, undefined);
    assert.equal(existsSync(path.join(f.repoPath, 'atlas_task.py')), true);
    assert.equal(existsSync(path.join(f.repoPath, '.pytest_cache')), false);
    assert.equal(existsSync(path.join(f.repoPath, '.ruff_cache')), false);
    assert.equal(existsSync(path.join(f.repoPath, '__pycache__')), false);
    assert.ok(repo.events.some((event) => event.content.includes('moved the task to Done')));
  } finally {
    cleanupTaskWorktree(f.repoPath, repo.task.worktreePath);
    f.dispose();
  }
});

test('startAgentForTask leaves completed task in review when auto-merge readiness is blocked', async () => {
  const f = fixture();
  const manager = new AgentManager();
  registerFakeProvider(manager, async (workingDirectory) => {
    writeFileSync(path.join(workingDirectory, 'blocked.txt'), 'blocked\n');
    return {
      status: 'complete',
      output: '<task-summary>\n## Completed\nFocused tests passed: verified blocked.txt was written.\nHostile review passed: merge readiness failure path remains covered.\n</task-summary>',
    };
  });
  manager.getMergeReadiness = () => ({ ready: false, reason: 'simulated safety uncertainty' });

  const repo = new MemoryTaskRepo(task(f.repoPath, 'smoke/auto-merge-blocked'));
  manager.initEventPersistence(repo);

  try {
    await startAgentForTask(repo.task, repo, manager);
    const finalTask = await waitForTerminal(repo);

    assert.equal(finalTask.agentStatus, 'complete');
    assert.equal(finalTask.columnId, 'review');
    assert.ok(finalTask.worktreePath);
    assert.equal(existsSync(path.join(finalTask.worktreePath, 'blocked.txt')), true);
    assert.equal(existsSync(path.join(f.repoPath, 'blocked.txt')), false);
    assert.ok(repo.events.some((event) => event.type === 'error' && /Auto-merge skipped: simulated safety uncertainty/i.test(event.content)));
  } finally {
    cleanupTaskWorktree(f.repoPath, repo.task.worktreePath);
    f.dispose();
  }
});

test('merge readiness and merge-local reject dirty worktree-only changes', async () => {
  const f = fixture();
  const manager = new AgentManager();
  const t = task(f.repoPath, 'smoke/dirty-worktree');
  try {
    t.worktreePath = manager.setupWorktree(t);
    writeFileSync(path.join(t.worktreePath!, 'uncommitted.txt'), 'not committed\n');
    const readiness = manager.getMergeReadiness(t);
    assert.equal(readiness.ready, false);
    assert.match(readiness.reason ?? '', /uncommitted or untracked/i);
    await assert.rejects(() => manager.mergeLocal(t), /uncommitted or untracked/i);
    assert.equal(git(['branch', '--show-current'], f.repoPath), 'main');
    assert.equal(existsSync(path.join(f.repoPath, 'uncommitted.txt')), false);
  } finally {
    cleanupTaskWorktree(f.repoPath, t.worktreePath);
    f.dispose();
  }
});

test('successful merge removes the matching clean registered worktree', async () => {
  const f = fixture();
  const manager = new AgentManager();
  let state = task(f.repoPath, 'smoke/merge-cleanup');
  state.agentStatus = 'complete';
  state.columnId = 'review';
  try {
    state.worktreePath = manager.setupWorktree(state);
    writeFileSync(path.join(state.worktreePath, 'merged.txt'), 'merged\n');
    git(['add', 'merged.txt'], state.worktreePath);
    git(['commit', '-m', 'merge cleanup work'], state.worktreePath);

    const result = await manager.mergeLocal(state);
    assert.equal(result.merged, true);
    assert.equal(existsSync(path.join(f.repoPath, 'merged.txt')), true);
    assert.deepEqual(manager.removeWorktree(state), { status: 'removed' });
    assert.equal(existsSync(state.worktreePath), false);
    state = { ...state, worktreePath: undefined };
  } finally {
    cleanupTaskWorktree(f.repoPath, state.worktreePath);
    f.dispose();
  }
});
