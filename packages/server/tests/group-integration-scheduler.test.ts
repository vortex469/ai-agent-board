import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { migrateSqliteDatabase } from '../src/db.js';
import { SqliteTaskRepository } from '../src/repositories/sqlite.js';
import { SqliteTaskGroupRepository } from '../src/repositories/sqlite-groups.js';
import { SqliteProjectRepository } from '../src/repositories/sqlite-projects.js';
import { AgentManager } from '../src/services/agent-manager.js';
import { installDependencyScheduler } from '../src/services/dependency-scheduler.js';
import { recordOrderedGroupResult } from '../src/services/group-baseline.js';
import { startOrderedGroupChild } from '../src/services/ordered-group.js';
import { getTaskDependencyGate } from '../src/services/task-dependencies.js';
import { autoProgressCompletedTask, broadcastTaskUpdate } from '../src/routes/helpers.js';
import { observeBroadcasts } from '../src/websocket.js';
import type { Task, TaskGroup } from '../src/types.js';

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const settle = () => new Promise(resolve => setTimeout(resolve, 40));
async function until(predicate: () => boolean) {
  for (let i = 0; i < 100 && !predicate(); i++) await settle();
  assert.ok(predicate(), 'scheduler did not dispatch expected task');
}

async function fixture(mode: NonNullable<TaskGroup['roadmapExecutionMode']> = 'backlog', twoGroups = false, autoRun = true) {
  const temporaryRoot = fs.mkdtempSync(path.join(process.cwd(), '.group-integration-test-'));
  const root = path.join(temporaryRoot, 'repo');
  fs.mkdirSync(root);
  const oldTmp = process.env.TMPDIR;
  process.env.TMPDIR = temporaryRoot;
  try {
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.email', 'test@example.invalid');
  git(root, 'config', 'user.name', 'Test');
  fs.writeFileSync(path.join(root, 'base'), 'base');
  git(root, 'add', 'base'); git(root, 'commit', '-m', 'base');
  } catch (error) {
    if (oldTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = oldTmp;
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
    throw error;
  }
  const db = new Database(':memory:'); migrateSqliteDatabase(db);
  const repo = new SqliteTaskRepository(db);
  const groups = new SqliteTaskGroupRepository(db);
  const projects = new SqliteProjectRepository(db);
  await projects.update('default', { autoRunEnabled: autoRun, updatedAt: Date.now() });
  for (const groupId of twoGroups ? ['a', 'b'] : ['a']) {
    await groups.create({ id: groupId, projectId: 'default', title: groupId, priority: 'medium', columnId: 'in-progress', createdAt: 1,
      maxConcurrency: 1, roadmapExecutionMode: mode, repoPath: root, baseBranch: 'main' },
    Array.from({ length: groupId === 'b' ? 3 : 2 }, (_, i) => ({ id: `${groupId}${i + 1}`, projectId: 'default', title: `${groupId}${i + 1}`,
      description: '', priority: 'medium', groupOrder: i, useWorktree: true, branchName: `integration/${groupId}${i + 1}`, agentType: 'hermes' })));
  }
  // Active groups retain backlog children until the scheduler admits each task.
  for (const group of await groups.getAll()) {
    for (const child of await groups.getChildTasks(group.id)) await repo.update(child.id, { columnId: 'backlog' });
  }
  if (twoGroups) await repo.createDependency('a2', 'b3', Date.now());
  const manager = new AgentManager();
  const started: Task[] = [];
  const updates: Task[] = [];
  const unsubscribe = observeBroadcasts(message => { if (message.type === 'task_updated') updates.push(message.payload as Task); });
  Object.assign(manager, {
    getAvailableAgents: () => [{ name: 'hermes', available: true }],
    startAgent: (task: Task) => { task.worktreePath = manager.setupWorktree(task); started.push(task); },
  });
  const stop = installDependencyScheduler(repo, groups, projects, manager);
  const ids = () => started.map(task => task.id);
  async function complete(id: string, filename = id) {
    const task = started.find(task => task.id === id)!;
    assert.ok(task, `${id} must have started`);
    fs.writeFileSync(path.join(task.worktreePath!, filename), id);
    git(task.worktreePath!, 'add', filename); git(task.worktreePath!, 'commit', '-m', id);
    await repo.update(id, { worktreePath: task.worktreePath });
    await recordOrderedGroupResult((await repo.getById(id))!, repo);
    await repo.clearRun(id);
    const updated = (await repo.update(id, { columnId: 'done', agentStatus: 'complete' }))!;
    broadcastTaskUpdate(updated);
    return updated;
  }
  async function integrate(id: string) {
    const task = (await repo.getById(id))!;
    await manager.mergeLocal(task);
    assert.equal(manager.removeWorktree(task).status, 'removed');
    const updated = (await repo.update(id, { worktreePath: undefined }))!;
    broadcastTaskUpdate(updated);
    return git(root, 'rev-parse', 'main');
  }
  return { root, repo, groups, projects, manager, started, updates, ids, complete, integrate,
    async close() { stop(); unsubscribe(); await settle(); db.close(); if (oldTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = oldTmp; fs.rmSync(temporaryRoot, { recursive: true, force: true }); } };
}

for (const mode of ['backlog', 'first-card', 'full-roadmap'] as const) {
  test(`${mode}: successful integration wakes same-group Auto Run with a fresh updated-main worktree`, async () => {
    const f = await fixture(mode);
    try {
      // Explicit first Run is supported even when the group's import mode is backlog/first-card.
      await startOrderedGroupChild('a', f.groups, f.repo, f.manager, false, f.projects, 'a1');
      await until(() => f.started.length === 1);
      const result = await f.complete('a1');
      await settle();
      assert.deepEqual(f.ids(), ['a1'], 'agent completion must not bypass integration');
      assert.equal((await getTaskDependencyGate(f.repo, 'a2')).eligible, false);
      // Regression: no queued child intent exists when the successful merge notification arrives.
      await f.repo.clearRun('a2');
      const integratedBase = await f.integrate('a1');
      for (let i = 0; i < 8; i++) broadcastTaskUpdate((await f.repo.getById('a1'))!);
      await until(() => f.started.length === 2);
      await settle();
      assert.deepEqual(f.ids(), ['a1', 'a2']);
      const successor = f.started[1];
      assert.equal(git(successor.worktreePath!, 'rev-parse', 'HEAD'), integratedBase);
      assert.equal(fs.readFileSync(path.join(successor.worktreePath!, 'a1'), 'utf8'), 'a1');
      assert.equal(successor.repositoryBaseline?.predecessorCommit, result.repositoryBaseline?.resultCommit);
      assert.equal(new Set(f.started.map(task => task.worktreePath)).size, 2);
      assert.ok(f.updates.some(task => task.id === 'a2' && task.agentStatus === 'planning'), 'running state broadcasts without a browser');
    } finally { await f.close(); }
  });
}

test('parallel groups progress independently and cross-group B3 waits for A2 integration', async () => {
  const f = await fixture('full-roadmap', true);
  try {
    await until(() => f.started.length === 2);
    assert.deepEqual(f.ids(), ['a1', 'b1']);
    assert.equal(f.started[0].repositoryBaseline?.startCommit, f.started[1].repositoryBaseline?.startCommit);
    await f.complete('a1'); await f.complete('b1'); await settle();
    assert.deepEqual(f.ids(), ['a1', 'b1']);
    await f.integrate('a1'); await until(() => f.started.length === 3);
    assert.equal(f.ids()[2], 'a2');
    const baseB = await f.integrate('b1'); await until(() => f.started.length === 4);
    assert.equal(f.ids()[3], 'b2');
    assert.equal(git(f.started[3].worktreePath!, 'rev-parse', 'HEAD'), baseB);
    await f.complete('b2'); await f.integrate('b2'); await settle();
    assert.equal(f.started.length, 4);
    await f.complete('a2'); await settle();
    assert.equal((await getTaskDependencyGate(f.repo, 'b3')).eligible, false);
    assert.equal(f.started.length, 4, 'cross-group agent success alone cannot unlock B3');
    const base = await f.integrate('a2'); await until(() => f.started.length === 5);
    const b3 = f.started[4];
    assert.equal(b3.id, 'b3');
    assert.equal(git(b3.worktreePath!, 'rev-parse', 'HEAD'), base);
    for (const id of ['a1', 'a2', 'b1', 'b2']) assert.equal(fs.readFileSync(path.join(b3.worktreePath!, id), 'utf8'), id);
  } finally { await f.close(); }
});

test('failed merge retains prerequisite integration gate and does not dispatch dependent', async () => {
  const f = await fixture('full-roadmap');
  try {
    await until(() => f.started.length === 1);
    const completed = await f.complete('a1', 'base');
    fs.writeFileSync(path.join(f.root, 'base'), 'conflicting main change');
    git(f.root, 'add', 'base'); git(f.root, 'commit', '-m', 'conflicting main');
    await assert.rejects(f.manager.mergeLocal(completed), /Merge failed/);
    broadcastTaskUpdate(completed); await settle();
    assert.equal((await getTaskDependencyGate(f.repo, 'a2')).eligible, false);
    assert.deepEqual(f.ids(), ['a1']);
    assert.throws(() => git(f.root, 'show-ref', '--verify', 'refs/heads/integration/a2'));
    assert.equal(git(f.root, 'status', '--porcelain'), '', 'failed merge must abort cleanly');
  } finally { await f.close(); }
});

test('Auto Run OFF prevents merge admission but manual Run still starts an integrated successor', async () => {
  const f = await fixture('first-card', false, false);
  try {
    await settle(); assert.deepEqual(f.ids(), []);
    await startOrderedGroupChild('a', f.groups, f.repo, f.manager, false, f.projects, 'a1');
    await f.complete('a1'); await f.integrate('a1'); await settle();
    assert.deepEqual(f.ids(), ['a1']);
    assert.equal((await getTaskDependencyGate(f.repo, 'a2')).eligible, true);
    await startOrderedGroupChild('a', f.groups, f.repo, f.manager, false, f.projects, 'a2');
    assert.deepEqual(f.ids(), ['a1', 'a2']);
    assert.equal(fs.readFileSync(path.join(f.started[1].worktreePath!, 'a1'), 'utf8'), 'a1');
  } finally { await f.close(); }
});


test('automatic merge completion dispatches the next grouped task without a browser tick', async () => {
  const f = await fixture('full-roadmap');
  try {
    await until(() => f.started.length === 1);
    await f.complete('a1');
    await f.repo.update('a1', { columnId: 'in-progress', summary: 'Hostile review passed: no regressions found.' });
    await f.repo.insertEvent({ id: 'focused-evidence', taskId: 'a1', timestamp: Date.now(), type: 'test_result',
      content: 'node --test passed', metadata: { command: 'node --test', state: 'succeeded' } });
    const done = await autoProgressCompletedTask(f.repo, 'a1', f.manager, undefined, f.projects);
    assert.equal(done?.columnId, 'done');
    assert.equal(done?.worktreePath, undefined);
    await until(() => f.started.length === 2);
    assert.equal(fs.readFileSync(path.join(f.started[1].worktreePath!, 'a1'), 'utf8'), 'a1');
  } finally { await f.close(); }
});

test('merged prerequisite with a retained clean worktree stays gated until cleanup finishes', async () => {
  const f = await fixture('full-roadmap');
  try {
    await until(() => f.started.length === 1);
    const completed = await f.complete('a1');
    await f.manager.mergeLocal(completed);
    broadcastTaskUpdate(completed); await settle();
    assert.equal((await getTaskDependencyGate(f.repo, 'a2')).eligible, false);
    assert.deepEqual(f.ids(), ['a1']);
    assert.equal(f.manager.removeWorktree(completed).status, 'removed');
    broadcastTaskUpdate((await f.repo.update('a1', { worktreePath: undefined }))!);
    await until(() => f.started.length === 2);
  } finally { await f.close(); }
});
