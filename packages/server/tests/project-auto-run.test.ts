import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import { SqliteProjectRepository } from '../src/repositories/sqlite-projects.js';
import { SqliteTaskRepository } from '../src/repositories/sqlite.js';
import { startNextEligibleProjectAutoRunTask, triggerAutomaticDependentProgression } from '../src/routes/helpers.js';
import type { AgentManager } from '../src/services/agent-manager.js';
import type { ProjectRepository } from '../src/repositories/project-types.js';
import type { Project, Task } from '../src/types.js';

function makeDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys=ON');
  db.exec(`
    CREATE TABLE tasks (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL, description TEXT NOT NULL,
      priority TEXT, column_id TEXT, agent_status TEXT, agent_type TEXT, created_at INTEGER, started_at INTEGER,
      completed_at INTEGER, repo_path TEXT, branch_name TEXT, base_branch TEXT, use_worktree INTEGER,
      worktree_path TEXT, archived INTEGER, group_id TEXT, group_order INTEGER, summary TEXT, external_source TEXT,
      external_key TEXT, provenance TEXT, run_requested_at INTEGER, run_claimed_at INTEGER, timeout_minutes INTEGER, repository_baseline TEXT);
    CREATE UNIQUE INDEX identity ON tasks(external_source,external_key) WHERE external_source IS NOT NULL AND external_key IS NOT NULL;
    CREATE TABLE events(id TEXT,task_id TEXT,type TEXT,content TEXT,timestamp INTEGER,metadata TEXT);
    CREATE TABLE task_relationships(task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      related_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, type TEXT NOT NULL DEFAULT 'related',
      created_at INTEGER NOT NULL, PRIMARY KEY(task_id,related_task_id), CHECK(task_id < related_task_id));
    CREATE TABLE task_dependencies(prerequisite_task_id TEXT NOT NULL,
      dependent_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, created_at INTEGER NOT NULL,
      PRIMARY KEY(prerequisite_task_id,dependent_task_id), CHECK(prerequisite_task_id <> dependent_task_id));
  `);
  return db;
}

const baseProject: Project = {
  id: 'project-a',
  name: 'Project A',
  repoPath: '/tmp/agentboard-test-repo',
  isDefault: false,
  createdAt: 1,
  updatedAt: 1,
};

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
  baseBranch: 'main',
  branchName: `agent/${id}`,
  useWorktree: false,
  ...overrides,
});

const agents = {
  getAvailableAgents: () => [{ name: 'hermes', displayName: 'Hermes', available: true }],
  isRunning: () => false,
  stopAgent: () => undefined,
  clearEvents: () => undefined,
  startAgent: () => undefined,
} as unknown as AgentManager;

function projectRepo(autoRunEnabled: boolean): ProjectRepository {
  let current = { ...baseProject, autoRunEnabled };
  return {
    getAllWithCounts: async () => [current],
    getById: async (id: string) => id === current.id ? current : undefined,
    getDefault: async () => undefined,
    resolve: async () => [current],
    create: async () => { throw new Error('not implemented'); },
    update: async (id, updates) => {
      if (id !== current.id) return undefined;
      current = { ...current, ...updates, updatedAt: updates.updatedAt };
      return current;
    },
    hasTasksOrGroups: async () => false,
    delete: async () => false,
  };
}

test('SQLite project repository persists Auto Run enable and disable', async () => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, repo_path TEXT, repo_url TEXT,
      is_default INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      default_agent_type TEXT, default_priority TEXT, default_base_branch TEXT,
      default_use_worktree INTEGER, auto_run_enabled INTEGER NOT NULL DEFAULT 0, aliases TEXT NOT NULL);
    CREATE TABLE tasks (project_id TEXT, column_id TEXT, archived INTEGER, group_id TEXT);
    CREATE TABLE task_groups (project_id TEXT, column_id TEXT, archived INTEGER);
  `);
  const repository = new SqliteProjectRepository(db);
  try {
    const created = await repository.create({
      id: 'auto-run-project',
      name: 'Auto Run Project',
      autoRunEnabled: true,
      createdAt: 10,
      updatedAt: 10,
    });
    assert.equal(created.autoRunEnabled, true);
    assert.equal((await repository.getById('auto-run-project'))?.autoRunEnabled, true);

    const updated = await repository.update('auto-run-project', { autoRunEnabled: false, updatedAt: 11 });
    assert.equal(updated?.autoRunEnabled, false);
    assert.equal((await repository.getById('auto-run-project'))?.autoRunEnabled, false);
  } finally {
    db.close();
  }
});

test('project Auto Run ON immediately starts the next eligible backlog card with run intent', async () => {
  const db = makeDb();
  const repo = new SqliteTaskRepository(db);
  const started: string[] = [];
  const manager = {
    ...agents,
    startAgent: (startedTask: Task) => { started.push(startedTask.id); },
  } as unknown as AgentManager;
  try {
    await repo.create(task('blocked-1', { createdAt: 1, runRequestedAt: 100 }));
    await repo.create(task('prereq-1', { createdAt: 0 }));
    await repo.createDependency('prereq-1', 'blocked-1', 1);
    await repo.create(task('ready-2', { createdAt: 2, runRequestedAt: 100 }));
    await repo.create(task('ready-3', { createdAt: 3, runRequestedAt: 100 }));

    const startedTask = await startNextEligibleProjectAutoRunTask(repo, projectRepo(true), 'project-a', manager);

    assert.equal(startedTask?.id, 'ready-2');
    assert.deepEqual(started, ['ready-2']);
    assert.equal((await repo.getById('blocked-1'))?.columnId, 'backlog');
    assert.equal((await repo.getById('ready-2'))?.columnId, 'in-progress');
    assert.equal((await repo.getById('ready-3'))?.columnId, 'backlog');
  } finally {
    db.close();
  }
});

test('project Auto Run OFF prevents queued dependent progression', async () => {
  const db = makeDb();
  const repo = new SqliteTaskRepository(db);
  try {
    await repo.create(task('first', { columnId: 'done', agentStatus: 'complete' }));
    await repo.create(task('second', { runRequestedAt: 100 }));
    await repo.createDependency('first', 'second', 100);

    const result = await triggerAutomaticDependentProgression(repo, (await repo.getById('first'))!, agents, projectRepo(false));

    assert.equal(result, undefined);
    assert.equal((await repo.getById('second'))?.columnId, 'backlog');
    assert.equal((await repo.getById('second'))?.agentStatus, 'idle');
  } finally {
    db.close();
  }
});

test('project Auto Run OFF does not cancel currently running work', async () => {
  const db = makeDb();
  const repo = new SqliteTaskRepository(db);
  const stopped: string[] = [];
  const manager = {
    ...agents,
    isRunning: (id: string) => id === 'running-1',
    stopAgent: async (id: string) => { stopped.push(id); return true; },
  } as unknown as AgentManager;
  try {
    await repo.create(task('running-1', {
      columnId: 'in-progress',
      agentStatus: 'executing',
      runRequestedAt: 100,
      runClaimedAt: 101,
    }));
    await repo.create(task('queued-2', { runRequestedAt: 100 }));

    const result = await startNextEligibleProjectAutoRunTask(repo, projectRepo(false), 'project-a', manager);

    assert.equal(result, undefined);
    assert.deepEqual(stopped, []);
    assert.equal((await repo.getById('running-1'))?.agentStatus, 'executing');
    assert.equal((await repo.getById('queued-2'))?.columnId, 'backlog');
  } finally {
    db.close();
  }
});
