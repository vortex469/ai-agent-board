import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import type { AgentEvent, ExecutionAttempt, Task, TaskRelationship } from '../src/types.js';
import type { ContinuationEligibility, OrchestrationAggregateResult, TaskRepository } from '../src/repositories/types.js';
import { AgentManager } from '../src/services/agent-manager.js';
import { reconcileInterruptedTaskCompletion } from '../src/routes/helpers.js';

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
}

function gitSucceeds(args: string[], cwd: string): boolean {
  try {
    execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    return true;
  } catch {
    return false;
  }
}

function fixture(): { repoPath: string; dispose(): void } {
  const repoPath = mkdtempSync(path.join(os.tmpdir(), 'agentboard-recovery-repo-'));
  git(['init', '-b', 'main'], repoPath);
  git(['config', 'user.email', 'agentboard-tests@example.invalid'], repoPath);
  git(['config', 'user.name', 'Agent Board Tests'], repoPath);
  writeFileSync(path.join(repoPath, 'README.md'), 'base\n');
  git(['add', 'README.md'], repoPath);
  git(['commit', '-m', 'base'], repoPath);
  return {
    repoPath,
    dispose() {
      try { git(['worktree', 'prune'], repoPath); } catch { /* ignore */ }
      rmSync(repoPath, { recursive: true, force: true });
    },
  };
}

function baseTask(repoPath: string, branchName: string, updates: Partial<Task> = {}): Task {
  return {
    id: randomUUID(),
    title: 'Recovered task',
    description: '',
    priority: 'medium',
    columnId: 'in-progress',
    agentStatus: 'executing',
    createdAt: Date.now(),
    projectId: 'project-1',
    repoPath,
    branchName,
    baseBranch: 'main',
    useWorktree: true,
    agentType: 'codex',
    ...updates,
  };
}

function commitTaskBranch(repoPath: string, branchName: string, filename = 'work.txt', subject = `work for ${branchName}`): string {
  git(['checkout', '-b', branchName], repoPath);
  writeFileSync(path.join(repoPath, filename), `${branchName}\n`);
  git(['add', filename], repoPath);
  git(['commit', '-m', subject], repoPath);
  const commit = git(['rev-parse', 'HEAD'], repoPath);
  git(['checkout', 'main'], repoPath);
  return commit;
}

function commitEvent(task: Task, commit: string): AgentEvent {
  return {
    id: randomUUID(),
    taskId: task.id,
    type: 'output',
    content: `Committed worktree changes on ${task.branchName}: ${commit.slice(0, 7)}`,
    timestamp: Date.now(),
  };
}

class MemoryTaskRepo implements TaskRepository {
  tasks = new Map<string, Task>();
  events: AgentEvent[] = [];
  relationships: TaskRelationship[] = [];

  constructor(tasks: Task[]) {
    for (const task of tasks) this.tasks.set(task.id, { ...task });
  }

  async getAll(): Promise<Task[]> { return [...this.tasks.values()].map((task) => ({ ...task })); }
  async getById(id: string): Promise<Task | undefined> {
    const task = this.tasks.get(id);
    return task ? { ...task } : undefined;
  }
  async getByExternalIdentity(): Promise<Task | undefined> { return undefined; }
  async resolve(): Promise<Task[]> { return []; }
  async create(task: Task): Promise<Task> { this.tasks.set(task.id, { ...task }); return { ...task }; }
  async createIdempotent(task: Task): Promise<{ task: Task; created: boolean }> {
    await this.create(task);
    return { task, created: true };
  }
  async requestRun(id: string, requestedAt: number): Promise<Task | undefined> {
    return this.update(id, { runRequestedAt: requestedAt, runClaimedAt: undefined });
  }
  async claimRun(id: string, claimedAt: number): Promise<Task | undefined> {
    const task = this.tasks.get(id);
    if (!task || task.runRequestedAt === undefined || task.runClaimedAt !== undefined) return undefined;
    return this.update(id, { runClaimedAt: claimedAt });
  }
  async clearRun(id: string): Promise<Task | undefined> {
    return this.update(id, { runRequestedAt: undefined, runClaimedAt: undefined });
  }
  async getPendingRuns(): Promise<Task[]> {
    return [...this.tasks.values()]
      .filter((task) => task.runRequestedAt !== undefined && task.runClaimedAt === undefined)
      .map((task) => ({ ...task }));
  }
  async update(id: string, updates: Partial<Task>): Promise<Task | undefined> {
    const task = this.tasks.get(id);
    if (!task) return undefined;
    const next = { ...task, ...updates } as Record<string, unknown>;
    for (const [key, value] of Object.entries(updates)) {
      if (value === undefined) delete next[key];
    }
    this.tasks.set(id, next as unknown as Task);
    return { ...(next as unknown as Task) };
  }
  async delete(id: string): Promise<boolean> { return this.tasks.delete(id); }
  async count(): Promise<number> { return this.tasks.size; }
  async insertEvent(event: AgentEvent): Promise<void> { this.events.push(event); }
  async getEventsByTaskId(taskId: string): Promise<AgentEvent[]> {
    return this.events.filter((event) => event.taskId === taskId);
  }
  async deleteEventsByTaskId(taskId: string): Promise<void> {
    this.events = this.events.filter((event) => event.taskId !== taskId);
  }
  async getArchivedTasks(): Promise<Task[]> { return []; }
  async getRelationships(taskId: string): Promise<TaskRelationship[]> {
    return this.relationships.filter((relationship) => relationship.taskId === taskId);
  }
  async createRelationship(taskId: string, relatedTaskId: string, createdAt: number): Promise<{ relationship: TaskRelationship; created: boolean }> {
    const relationship = { taskId, relatedTaskId, type: 'related' as const, createdAt };
    this.relationships.push(relationship);
    return { relationship, created: true };
  }
  async createDependency(prerequisiteTaskId: string, dependentTaskId: string, createdAt: number): Promise<{ relationship: TaskRelationship; created: boolean }> {
    const blocks = { taskId: prerequisiteTaskId, relatedTaskId: dependentTaskId, type: 'blocks' as const, direction: 'blocks' as const, createdAt };
    const blockedBy = { taskId: dependentTaskId, relatedTaskId: prerequisiteTaskId, type: 'blocks' as const, direction: 'blocked-by' as const, createdAt };
    this.relationships.push(blocks, blockedBy);
    return { relationship: blockedBy, created: true };
  }
  async deleteRelationship(): Promise<boolean> { return true; }
  async getAttemptById(): Promise<ExecutionAttempt | undefined> { return undefined; }
  async getAttemptByExternalIdentity(): Promise<ExecutionAttempt | undefined> { return undefined; }
  async getAttemptsByTaskId(): Promise<ExecutionAttempt[]> { return []; }
  async createAttemptIdempotent(attempt: ExecutionAttempt): Promise<{ attempt: ExecutionAttempt; created: boolean }> {
    return { attempt, created: true };
  }
  async createOrchestration(task: Task, attempt: ExecutionAttempt): Promise<OrchestrationAggregateResult> {
    await this.create(task);
    return { task, attempt, created: true };
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

function managerWithAvailableCodex(): AgentManager {
  const manager = new AgentManager();
  (manager as unknown as { availableAgents: Array<{ name: string; displayName: string; available: boolean }> }).availableAgents = [
    { name: 'codex', displayName: 'Fake Codex', available: true },
  ];
  return manager;
}

test('startup recovery after agent commit before merge restores review without rerunning', async () => {
  const f = fixture();
  try {
    const task = baseTask(f.repoPath, 'recovery/unmerged');
    const commit = commitTaskBranch(f.repoPath, task.branchName!, 'work.txt', 'Agent Board: Recovered task');
    const repo = new MemoryTaskRepo([{ ...task, runRequestedAt: 1, runClaimedAt: 2 }]);
    const manager = managerWithAvailableCodex();

    const recovered = await reconcileInterruptedTaskCompletion(repo, task, manager);

    assert.equal(recovered?.agentStatus, 'complete');
    assert.equal(recovered?.columnId, 'review');
    assert.equal(recovered?.runRequestedAt, undefined);
    assert.equal(git(['rev-parse', task.branchName!], f.repoPath), commit);
    assert.equal(git(['branch', '--show-current'], f.repoPath), 'main');
  } finally {
    f.dispose();
  }
});

test('startup recovery after merge before Done transition marks done and preserves branch', async () => {
  const f = fixture();
  try {
    const task = baseTask(f.repoPath, 'recovery/merged-before-done', { agentStatus: 'complete', columnId: 'review' });
    const commit = commitTaskBranch(f.repoPath, task.branchName!);
    git(['merge', task.branchName!, '--no-edit'], f.repoPath);
    const repo = new MemoryTaskRepo([{ ...task, runRequestedAt: 1, runClaimedAt: 2 }]);
    const manager = managerWithAvailableCodex();

    const recovered = await reconcileInterruptedTaskCompletion(repo, task, manager);

    assert.equal(recovered?.agentStatus, 'complete');
    assert.equal(recovered?.columnId, 'done');
    assert.equal(recovered?.runRequestedAt, undefined);
    assert.equal(git(['rev-parse', task.branchName!], f.repoPath), commit);
  } finally {
    f.dispose();
  }
});

test('manually merged task branch with stale failed state recovers to Done', async () => {
  const f = fixture();
  try {
    const task = baseTask(f.repoPath, 'recovery/manual-merge-failed', { agentStatus: 'failed', columnId: 'review' });
    const commit = commitTaskBranch(f.repoPath, task.branchName!);
    git(['merge', task.branchName!, '--no-edit'], f.repoPath);
    const repo = new MemoryTaskRepo([task]);
    repo.events.push(commitEvent(task, commit));

    const recovered = await reconcileInterruptedTaskCompletion(repo, task, managerWithAvailableCodex());

    assert.equal(recovered?.agentStatus, 'complete');
    assert.equal(recovered?.columnId, 'done');
  } finally {
    f.dispose();
  }
});

test('missing prunable worktree with valid merged branch is cleared during recovery', async () => {
  const f = fixture();
  try {
    const task = baseTask(f.repoPath, 'recovery/missing-worktree', {
      agentStatus: 'failed',
      columnId: 'review',
      worktreePath: path.join(os.tmpdir(), `agentboard-${randomUUID()}-ABC123`),
    });
    task.worktreePath = path.join(os.tmpdir(), `agentboard-${task.id}-ABC123`);
    const commit = commitTaskBranch(f.repoPath, task.branchName!);
    git(['merge', task.branchName!, '--no-edit'], f.repoPath);
    const repo = new MemoryTaskRepo([task]);
    repo.events.push(commitEvent(task, commit));

    const recovered = await reconcileInterruptedTaskCompletion(repo, task, managerWithAvailableCodex());

    assert.equal(recovered?.columnId, 'done');
    assert.equal(recovered?.worktreePath, undefined);
    assert.equal(git(['rev-parse', task.branchName!], f.repoPath), commit);
  } finally {
    f.dispose();
  }
});

test('unmerged completed branch remains in review and is not merged silently', async () => {
  const f = fixture();
  try {
    const task = baseTask(f.repoPath, 'recovery/review-only', { agentStatus: 'complete', columnId: 'review' });
    commitTaskBranch(f.repoPath, task.branchName!);
    const repo = new MemoryTaskRepo([task]);

    const recovered = await reconcileInterruptedTaskCompletion(repo, task, managerWithAvailableCodex());

    assert.equal(recovered?.agentStatus, 'complete');
    assert.equal(recovered?.columnId, 'review');
    assert.equal(git(['branch', '--show-current'], f.repoPath), 'main');
    assert.equal(gitSucceeds(['cat-file', '-e', 'main:work.txt'], f.repoPath), false);
  } finally {
    f.dispose();
  }
});

test('ambiguous diverged git state fails closed with a recovery reason', async () => {
  const f = fixture();
  try {
    const task = baseTask(f.repoPath, 'recovery/diverged');
    const commit = commitTaskBranch(f.repoPath, task.branchName!);
    writeFileSync(path.join(f.repoPath, 'main-only.txt'), 'main\n');
    git(['add', 'main-only.txt'], f.repoPath);
    git(['commit', '-m', 'main moved'], f.repoPath);
    const repo = new MemoryTaskRepo([task]);
    repo.events.push(commitEvent(task, commit));

    const recovered = await reconcileInterruptedTaskCompletion(repo, task, managerWithAvailableCodex());

    assert.equal(recovered?.agentStatus, 'complete');
    assert.equal(recovered?.columnId, 'review');
    assert.ok(repo.events.some((event) => /diverged/.test(event.content)));
  } finally {
    f.dispose();
  }
});

test('repeated startup recovery is idempotent and dependent task starts exactly once', async () => {
  const f = fixture();
  try {
    const prerequisite = baseTask(f.repoPath, 'recovery/idempotent', { agentStatus: 'failed', columnId: 'review' });
    const dependent = baseTask(f.repoPath, 'recovery/dependent', {
      agentStatus: 'idle',
      columnId: 'backlog',
      runRequestedAt: 10,
      branchName: 'recovery/dependent',
    });
    const commit = commitTaskBranch(f.repoPath, prerequisite.branchName!);
    git(['merge', prerequisite.branchName!, '--no-edit'], f.repoPath);
    const repo = new MemoryTaskRepo([prerequisite, dependent]);
    repo.events.push(commitEvent(prerequisite, commit));
    await repo.createDependency(prerequisite.id, dependent.id, 1);
    const manager = managerWithAvailableCodex();
    let starts = 0;
    manager.startAgent = (task, onStatusChange) => {
      starts += 1;
      void onStatusChange('planning');
    };

    await reconcileInterruptedTaskCompletion(repo, prerequisite, manager);
    const donePrerequisite = await repo.getById(prerequisite.id);
    if (donePrerequisite) await reconcileInterruptedTaskCompletion(repo, donePrerequisite, manager);

    assert.equal(starts, 1);
    assert.equal((await repo.getById(prerequisite.id))?.columnId, 'done');
    assert.equal((await repo.getById(dependent.id))?.runClaimedAt !== undefined, true);
  } finally {
    f.dispose();
  }
});

test('failed task with no proven completed commit stays failed', async () => {
  const f = fixture();
  try {
    const task = baseTask(f.repoPath, 'recovery/unproven-failed', { agentStatus: 'failed', columnId: 'review' });
    commitTaskBranch(f.repoPath, task.branchName!);
    git(['merge', task.branchName!, '--no-edit'], f.repoPath);
    const repo = new MemoryTaskRepo([task]);

    const recovered = await reconcileInterruptedTaskCompletion(repo, task, managerWithAvailableCodex());

    assert.equal(recovered, undefined);
    assert.equal((await repo.getById(task.id))?.agentStatus, 'failed');
    assert.ok(repo.events.some((event) => /could not prove/.test(event.content)));
  } finally {
    f.dispose();
  }
});

test('unrelated failed task whose branch points at base is not marked complete', async () => {
  const f = fixture();
  try {
    const task = baseTask(f.repoPath, 'recovery/no-work-failed', { agentStatus: 'failed', columnId: 'review' });
    git(['branch', task.branchName!], f.repoPath);
    const repo = new MemoryTaskRepo([task]);

    const recovered = await reconcileInterruptedTaskCompletion(repo, task, managerWithAvailableCodex());

    assert.equal(recovered, undefined);
    assert.equal((await repo.getById(task.id))?.agentStatus, 'failed');
    assert.equal((await repo.getById(task.id))?.columnId, 'review');
  } finally {
    f.dispose();
  }
});
