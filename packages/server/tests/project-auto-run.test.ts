import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import type { Task } from '../src/types.js';
import { migrateSqliteDatabase } from '../src/db.js';
import { SqliteTaskRepository } from '../src/repositories/sqlite.js';
import { tickProjectAutoRun } from '../src/routes/projects.js';

function task(id: string, title: string, createdAt: number): Task {
  return {
    id,
    projectId: 'project-auto-run',
    title,
    description: title,
    priority: 'medium',
    columnId: 'backlog',
    agentStatus: 'idle',
    agentType: 'copilot',
    createdAt,
    sortOrder: createdAt,
  };
}

function fakeAgentManager(runningTaskIds = new Set<string>()) {
  const started: string[] = [];
  return {
    started,
    isRunning: (taskId: string) => runningTaskIds.has(taskId),
    getAvailableAgents: () => [{ name: 'copilot', displayName: 'Copilot', available: true }],
    startAgent: (startedTask: Task) => {
      started.push(startedTask.id);
    },
  };
}

function setup() {
  const db = new Database(':memory:');
  migrateSqliteDatabase(db);
  const repo = new SqliteTaskRepository(db);
  db.prepare('INSERT INTO projects (id, name, is_default, created_at, updated_at, auto_run_enabled) VALUES (?, ?, 0, ?, ?, 1)')
    .run('project-auto-run', 'Project Auto Run', 1, 1);
  return { db, repo };
}

test('project Auto Run starts only the first ordered Backlog card and honors reorder', async () => {
  const { repo } = setup();
  await repo.create(task('first', 'First', 1));
  await repo.create(task('second', 'Second', 2));
  await repo.create(task('third', 'Third', 3));
  await repo.reorderTasks('project-auto-run', 'backlog', ['second', 'first', 'third'], 100);

  const agentManager = fakeAgentManager();
  const result = await tickProjectAutoRun({
    project: {
      id: 'project-auto-run',
      name: 'Project Auto Run',
      isDefault: false,
      createdAt: 1,
      updatedAt: 1,
      autoRunEnabled: true,
    },
    orderedBacklogIds: ['second', 'first', 'third'],
    taskRepo: repo,
    agentManager: agentManager as never,
  });

  assert.equal(result.started, true);
  assert.equal(result.task.id, 'second');
  assert.deepEqual(agentManager.started, ['second']);
  assert.equal((await repo.getById('second'))?.columnId, 'in-progress');
  assert.equal((await repo.getById('first'))?.columnId, 'backlog');
});

test('project Auto Run waits for the current card to reach Done before starting the next card', async () => {
  const { repo } = setup();
  await repo.create({ ...task('current', 'Current', 1), columnId: 'review', agentStatus: 'complete' });
  await repo.create(task('next', 'Next', 2));

  const agentManager = fakeAgentManager();
  const waiting = await tickProjectAutoRun({
    project: {
      id: 'project-auto-run',
      name: 'Project Auto Run',
      isDefault: false,
      createdAt: 1,
      updatedAt: 1,
      autoRunEnabled: true,
    },
    orderedBacklogIds: ['next'],
    taskRepo: repo,
    agentManager: agentManager as never,
  });
  assert.deepEqual(waiting, { started: false, reason: 'awaiting-current-card-done' });

  await repo.update('current', { columnId: 'done' });
  const started = await tickProjectAutoRun({
    project: {
      id: 'project-auto-run',
      name: 'Project Auto Run',
      isDefault: false,
      createdAt: 1,
      updatedAt: 1,
      autoRunEnabled: true,
    },
    orderedBacklogIds: ['next'],
    taskRepo: repo,
    agentManager: agentManager as never,
  });
  assert.equal(started.started, true);
  assert.equal(started.task.id, 'next');
});

test('project Auto Run stops on a blocked top card instead of skipping ahead', async () => {
  const { repo } = setup();
  await repo.create(task('blocker', 'Blocker', 1));
  await repo.create(task('blocked-top', 'Blocked Top', 2));
  await repo.create(task('next', 'Next', 3));
  await repo.createDependency('blocker', 'blocked-top', 4);

  const agentManager = fakeAgentManager();
  const result = await tickProjectAutoRun({
    project: {
      id: 'project-auto-run',
      name: 'Project Auto Run',
      isDefault: false,
      createdAt: 1,
      updatedAt: 1,
      autoRunEnabled: true,
    },
    orderedBacklogIds: ['blocked-top', 'next'],
    taskRepo: repo,
    agentManager: agentManager as never,
  });

  assert.equal(result.started, false);
  assert.equal(result.reason, 'top-card-blocked');
  assert.equal(result.task?.id, 'blocked-top');
  assert.deepEqual(agentManager.started, []);
  assert.equal((await repo.getById('next'))?.agentStatus, 'idle');
});

test('project Auto Run off prevents new starts without touching running state', async () => {
  const { repo } = setup();
  await repo.create(task('queued', 'Queued', 1));
  const agentManager = fakeAgentManager(new Set(['running']));

  const result = await tickProjectAutoRun({
    project: {
      id: 'project-auto-run',
      name: 'Project Auto Run',
      isDefault: false,
      createdAt: 1,
      updatedAt: 1,
      autoRunEnabled: false,
    },
    orderedBacklogIds: ['queued'],
    taskRepo: repo,
    agentManager: agentManager as never,
  });

  assert.deepEqual(result, { started: false, reason: 'auto-run-disabled' });
  assert.deepEqual(agentManager.started, []);
  assert.equal((await repo.getById('queued'))?.columnId, 'backlog');
});
