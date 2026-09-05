import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import { SqliteTaskRepository } from '../src/repositories/sqlite.js';
import {
  autoProgressCompletedTask,
  triggerAutomaticBacklogProgression,
  triggerAutomaticDependentProgression,
} from '../src/routes/helpers.js';
import type { Task } from '../src/types.js';
import type { AgentManager } from '../src/services/agent-manager.js';

function makeDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys=ON');
  db.exec(`
    CREATE TABLE tasks (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL, description TEXT NOT NULL,
      priority TEXT, column_id TEXT, agent_status TEXT, agent_type TEXT, created_at INTEGER, started_at INTEGER,
      completed_at INTEGER, repo_path TEXT, branch_name TEXT, base_branch TEXT, use_worktree INTEGER,
      worktree_path TEXT, archived INTEGER, group_id TEXT, group_order INTEGER, summary TEXT, external_source TEXT,
      external_key TEXT, provenance TEXT, run_requested_at INTEGER, run_claimed_at INTEGER, timeout_minutes INTEGER);
    CREATE UNIQUE INDEX identity ON tasks(external_source,external_key) WHERE external_source IS NOT NULL AND external_key IS NOT NULL;
    CREATE TABLE events(id TEXT,task_id TEXT,type TEXT,content TEXT,timestamp INTEGER,metadata TEXT);
    CREATE TABLE task_relationships(task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      related_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, type TEXT NOT NULL DEFAULT 'related',
      created_at INTEGER NOT NULL, PRIMARY KEY(task_id,related_task_id), CHECK(task_id < related_task_id));
    CREATE TABLE task_dependencies(prerequisite_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      dependent_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, created_at INTEGER NOT NULL,
      PRIMARY KEY(prerequisite_task_id,dependent_task_id), CHECK(prerequisite_task_id <> dependent_task_id));
    CREATE TABLE execution_attempts(id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      external_source TEXT NOT NULL, external_key TEXT NOT NULL, title_snapshot TEXT NOT NULL, description_snapshot TEXT NOT NULL,
      agent_type TEXT NOT NULL, related_task_id TEXT, auto_start INTEGER NOT NULL, timeout_minutes INTEGER,
      request_snapshot TEXT NOT NULL DEFAULT '{}', status TEXT NOT NULL, created_at INTEGER NOT NULL, UNIQUE(external_source, external_key));
  `);
  return db;
}

const task = (id: string, overrides: Partial<Task> = {}): Task => ({
  id,
  projectId: 'project-a',
  title: id,
  description: '',
  priority: 'medium',
  columnId: 'backlog',
  agentStatus: 'idle',
  agentType: 'hermes',
  createdAt: Number(id.replace(/\D/g, '')) || 1,
  repoPath: '/tmp/agentboard-test-repo',
  baseBranch: 'main',
  branchName: `agent/${id}`,
  useWorktree: true,
  ...overrides,
});

function manager(started: string[] = [], overrides: Partial<AgentManager> = {}): AgentManager {
  return {
    getAvailableAgents: () => [{ name: 'hermes', displayName: 'Hermes', available: true }],
    isRunning: () => false,
    startAgent: (startedTask: Task) => { started.push(startedTask.id); },
    getMergeReadiness: () => ({ ready: true }),
    mergeLocal: async () => ({ baseBranch: 'main' }),
    removeWorktree: () => ({ status: 'removed' }),
    ...overrides,
  } as unknown as AgentManager;
}

test('auto run on admits the first eligible backlog card', async () => {
  const db = makeDb();
  const repo = new SqliteTaskRepository(db);
  const started: string[] = [];
  try {
    await repo.create(task('first', { createdAt: 1 }));
    await repo.create(task('second', { createdAt: 2 }));
    await repo.requestRun('second', 200);
    await repo.requestRun('first', 100);

    const admitted = await triggerAutomaticBacklogProgression(repo, 'project-a', manager(started));

    assert.equal(admitted?.id, 'first');
    assert.deepEqual(started, ['first']);
    assert.equal((await repo.getById('first'))?.columnId, 'in-progress');
    assert.equal((await repo.getById('second'))?.columnId, 'backlog');
  } finally { db.close(); }
});

test('auto run off leaves backlog unchanged', async () => {
  const db = makeDb();
  const repo = new SqliteTaskRepository(db);
  const started: string[] = [];
  try {
    await repo.create(task('manual'));

    const admitted = await triggerAutomaticBacklogProgression(repo, 'project-a', manager(started));

    assert.equal(admitted, undefined);
    assert.deepEqual(started, []);
    assert.equal((await repo.getById('manual'))?.columnId, 'backlog');
  } finally { db.close(); }
});

test('dependent backlog card waits for its prerequisite', async () => {
  const db = makeDb();
  const repo = new SqliteTaskRepository(db);
  const started: string[] = [];
  try {
    await repo.create(task('first', { columnId: 'review', agentStatus: 'complete' }));
    await repo.create(task('second'));
    await repo.createDependency('first', 'second', 10);
    await repo.requestRun('second', 20);

    const admitted = await triggerAutomaticBacklogProgression(repo, 'project-a', manager(started));

    assert.equal(admitted, undefined);
    assert.deepEqual(started, []);
    assert.equal((await repo.getById('second'))?.columnId, 'backlog');
  } finally { db.close(); }
});

test('completing prerequisite admits the dependent backlog card', async () => {
  const db = makeDb();
  const repo = new SqliteTaskRepository(db);
  const started: string[] = [];
  try {
    await repo.create(task('first', { columnId: 'review', agentStatus: 'complete' }));
    await repo.create(task('second'));
    await repo.createDependency('first', 'second', 10);
    await repo.requestRun('second', 20);

    const firstDone = await repo.update('first', { columnId: 'done' });
    assert(firstDone);
    await triggerAutomaticDependentProgression(repo, firstDone, manager(started));

    assert.deepEqual(started, ['second']);
    assert.equal((await repo.getById('second'))?.columnId, 'in-progress');
  } finally { db.close(); }
});

test('blocked failed and needs-human cards are not admitted', async () => {
  const db = makeDb();
  const repo = new SqliteTaskRepository(db);
  const started: string[] = [];
  try {
    await repo.create(task('blocked', { columnId: 'review', agentStatus: 'complete', runRequestedAt: 10 }));
    await repo.create(task('failed', { agentStatus: 'failed', runRequestedAt: 11 }));
    await repo.create(task('needs-human', { columnId: 'review', agentStatus: 'idle', runRequestedAt: 12 }));

    const admitted = await triggerAutomaticBacklogProgression(repo, 'project-a', manager(started));

    assert.equal(admitted, undefined);
    assert.deepEqual(started, []);
    assert.equal((await repo.getById('blocked'))?.columnId, 'review');
    assert.equal((await repo.getById('failed'))?.agentStatus, 'failed');
    assert.equal((await repo.getById('needs-human'))?.columnId, 'review');
  } finally { db.close(); }
});

test('enabling auto run with existing eligible backlog cards evaluates immediately', async () => {
  const db = makeDb();
  const repo = new SqliteTaskRepository(db);
  const started: string[] = [];
  try {
    await repo.create(task('existing'));
    await repo.requestRun('existing', 20);

    const admitted = await triggerAutomaticBacklogProgression(repo, 'project-a', manager(started));

    assert.equal(admitted?.id, 'existing');
    assert.deepEqual(started, ['existing']);
    assert.equal((await repo.getById('existing'))?.agentStatus, 'planning');
  } finally { db.close(); }
});

test('successful task progression still moves through review to done', async () => {
  const db = makeDb();
  const repo = new SqliteTaskRepository(db);
  try {
    await repo.create(task('successful', {
      columnId: 'in-progress',
      agentStatus: 'executing',
      worktreePath: '/tmp/agentboard-test-worktree',
      summary: 'Focused tests passed: node --test auto-run-backlog.test.ts\nHostile review passed: no regressions found.',
    }));

    const done = await autoProgressCompletedTask(repo, 'successful', manager());

    assert.equal(done?.columnId, 'done');
    assert.equal(done?.agentStatus, 'complete');
    assert.equal(done?.worktreePath, undefined);
  } finally { db.close(); }
});
