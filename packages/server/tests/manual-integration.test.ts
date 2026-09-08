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
import { reconcileTaskIntegration } from '../src/services/task-integration.js';
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
  const temporaryRoot = fs.mkdtempSync(path.join(process.cwd(), '.manual-integration-test-'));
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
  let stop = installDependencyScheduler(repo, groups, projects, manager);
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
    stopScheduler() { stop(); },
    restartScheduler() { stop(); stop = installDependencyScheduler(repo, groups, projects, manager); },
    async close() { stop(); unsubscribe(); await settle(); db.close(); if (oldTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = oldTmp; fs.rmSync(temporaryRoot, { recursive: true, force: true }); } };
}

// Exercise the same completion path as a successful agent whose automatic merge conflicts.
async function failedMerge(f: Awaited<ReturnType<typeof fixture>>, id = 'a1') {
  const completed = await f.complete(id, 'base');
  fs.writeFileSync(path.join(f.root, 'base'), `main conflict for ${id}`);
  git(f.root, 'add', 'base'); git(f.root, 'commit', '-m', 'conflicting main');
  await f.repo.update(id, { columnId: 'in-progress', summary: 'Hostile review passed: no regressions found.' });
  await f.repo.insertEvent({ id: `evidence-${id}`, taskId: id, timestamp: Date.now(), type: 'test_result',
    content: 'node --test passed', metadata: { command: 'node --test', state: 'succeeded' } });
  const reviewed = await autoProgressCompletedTask(f.repo, id, f.manager, undefined, f.projects);
  assert.equal(reviewed?.columnId, 'review');
  assert.equal(reviewed?.agentStatus, 'complete');
  assert.ok((await f.repo.getEventsByTaskId(id)).some(event => event.content.includes('Auto-merge failed')));
  await settle();
  return completed;
}

function repairAndFastForward(f: Awaited<ReturnType<typeof fixture>>, task: Task, rebase = false) {
  const worktree = task.worktreePath!;
  if (rebase) {
    assert.throws(() => git(worktree, 'rebase', 'main'));
    fs.writeFileSync(path.join(worktree, 'base'), task.id);
    git(worktree, 'add', 'base');
    git(worktree, '-c', 'core.editor=true', 'rebase', '--continue');
  } else {
    assert.throws(() => git(worktree, 'merge', '--no-edit', 'main'));
    fs.writeFileSync(path.join(worktree, 'base'), task.id);
    git(worktree, 'add', 'base'); git(worktree, 'commit', '-m', 'Resolve integration conflict');
  }
  git(f.root, 'merge', '--ff-only', task.branchName!);
  return git(f.root, 'rev-parse', 'main');
}

for (const rebase of [false, true]) {
  test(`manual ${rebase ? 'rebase' : 'merge'} repair and fast-forward clears failure and resumes same-group Auto Run once`, async () => {
    const f = await fixture('full-roadmap');
    try {
      await until(() => f.started.length === 1);
      const task = await failedMerge(f);
      assert.equal((await getTaskDependencyGate(f.repo, 'a2')).eligible, false);
      const main = repairAndFastForward(f, task, rebase);
      if (rebase) assert.notEqual(main, task.repositoryBaseline?.resultCommit);
      for (let i = 0; i < 8; i++) broadcastTaskUpdate((await f.repo.getById('a1'))!);
      await until(() => f.started.length === 2);
      await settle();
      assert.deepEqual(f.ids(), ['a1', 'a2'], 'recheck never reruns the prerequisite or duplicates a launch');
      assert.equal((await f.repo.getById('a1'))?.columnId, 'done');
      assert.equal((await getTaskDependencyGate(f.repo, 'a2')).eligible, true);
      assert.equal(git(f.started[1].worktreePath!, 'rev-parse', 'HEAD'), main);
      assert.equal(fs.readFileSync(path.join(f.started[1].worktreePath!, 'base'), 'utf8'), 'a1');
      assert.equal(git(f.root, 'rev-parse', 'main'), main, 'recheck does not create a commit');
      assert.ok(f.updates.some(update => update.id === 'a1' && update.columnId === 'done'));
    } finally { await f.close(); }
  });
}

for (const scenario of ['not-integrated', 'extra-commit', 'extra-commit-integrated', 'dirty', 'unrelated-reset'] as const) {
  test(`manual integration fails closed for ${scenario}`, async () => {
    const f = await fixture('full-roadmap');
    try {
      await until(() => f.started.length === 1);
      const task = await failedMerge(f);
      if (scenario === 'dirty') {
        repairAndFastForward(f, task, true);
        fs.writeFileSync(path.join(task.worktreePath!, 'uncommitted'), 'must not discard');
      } else if ((scenario === 'extra-commit' || scenario === 'extra-commit-integrated')) {
        repairAndFastForward(f, task, true);
        fs.writeFileSync(path.join(task.worktreePath!, 'unrelated'), 'extra work');
        git(task.worktreePath!, 'add', 'unrelated'); git(task.worktreePath!, 'commit', '-m', 'Unrelated additional work');
        if (scenario === 'extra-commit-integrated') git(f.root, 'merge', '--ff-only', task.branchName!);
      } else if (scenario === 'unrelated-reset') {
        git(task.worktreePath!, 'reset', '--hard', 'main');
      }
      const recheck = await reconcileTaskIntegration(f.repo, 'a1', f.manager);
      assert.equal(recheck.synchronized, false);
      assert.ok(recheck.reason, 'failed recheck explains why synchronization cannot be proven');
      broadcastTaskUpdate((await f.repo.getById('a1'))!);
      await new Promise(resolve => setTimeout(resolve, 150));
      assert.deepEqual(f.ids(), ['a1']);
      assert.equal((await f.repo.getById('a1'))?.columnId, 'review');
      assert.equal((await getTaskDependencyGate(f.repo, 'a2')).eligible, false);
      if (scenario === 'dirty') assert.equal(fs.readFileSync(path.join(task.worktreePath!, 'uncommitted'), 'utf8'), 'must not discard');
    } finally { await f.close(); }
  });
}

test('startup scheduler reconciliation recovers manual integration without a lifecycle event', async () => {
  const f = await fixture('full-roadmap');
  try {
    await until(() => f.started.length === 1);
    const task = await failedMerge(f);
    f.stopScheduler();
    const main = repairAndFastForward(f, task, true);
    f.restartScheduler();
    await until(() => f.started.length === 2);
    assert.deepEqual(f.ids(), ['a1', 'a2']);
    assert.equal(git(f.started[1].worktreePath!, 'rev-parse', 'HEAD'), main);
  } finally { await f.close(); }
});

test('Auto Run OFF reconciles manual integration and eligibility without dispatching', async () => {
  const f = await fixture('first-card', false, false);
  try {
    await startOrderedGroupChild('a', f.groups, f.repo, f.manager, false, f.projects, 'a1');
    const task = await failedMerge(f);
    repairAndFastForward(f, task, true);
    broadcastTaskUpdate((await f.repo.getById('a1'))!);
    for (let i = 0; i < 50 && (await f.repo.getById('a1'))?.columnId !== 'done'; i++) await settle();
    assert.equal((await f.repo.getById('a1'))?.columnId, 'done');
    assert.equal((await getTaskDependencyGate(f.repo, 'a2')).eligible, true, 'Next Eligible can select successor');
    assert.deepEqual(f.ids(), ['a1']);
  } finally { await f.close(); }
});

test('external integration wakes a cross-group dependent from the updated base', async () => {
  const f = await fixture('full-roadmap', true);
  try {
    await until(() => f.started.length === 2);
    await f.complete('a1'); await f.integrate('a1');
    await until(() => f.started.some(task => task.id === 'a2'));
    await f.complete('b1'); await f.integrate('b1');
    await until(() => f.started.some(task => task.id === 'b2'));
    await f.complete('b2'); await f.integrate('b2');
    const task = await failedMerge(f, 'a2');
    assert.equal((await getTaskDependencyGate(f.repo, 'b3')).eligible, false);
    const main = repairAndFastForward(f, task, true);
    broadcastTaskUpdate((await f.repo.getById('a2'))!);
    await until(() => f.started.some(task => task.id === 'b3'));
    await settle();
    assert.equal(f.ids().filter(id => id === 'b3').length, 1);
    assert.equal(git(f.started.find(task => task.id === 'b3')!.worktreePath!, 'rev-parse', 'HEAD'), main);
    assert.equal((await getTaskDependencyGate(f.repo, 'b3')).eligible, true);
  } finally { await f.close(); }
});

test('manual reconciliation preserves stale dependent branch protection', async () => {
  const f = await fixture('full-roadmap');
  try {
    await until(() => f.started.length === 1);
    git(f.root, 'branch', 'integration/a2', 'main');
    const task = await failedMerge(f);
    repairAndFastForward(f, task, true);
    broadcastTaskUpdate((await f.repo.getById('a1'))!);
    for (let i = 0; i < 50 && (await f.repo.getById('a1'))?.columnId !== 'done'; i++) await settle();
    assert.equal((await f.repo.getById('a1'))?.columnId, 'done');
    assert.equal((await getTaskDependencyGate(f.repo, 'a2')).eligible, false);
    assert.deepEqual(f.ids(), ['a1']);
  } finally { await f.close(); }
});

test('reconciliation does not bypass an unrelated review gate', async () => {
  const f = await fixture('full-roadmap');
  try {
    await until(() => f.started.length === 1);
    const task = await f.complete('a1');
    await f.repo.update('a1', { columnId: 'review' });
    git(f.root, 'merge', '--ff-only', task.branchName!);
    broadcastTaskUpdate((await f.repo.getById('a1'))!);
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal((await f.repo.getById('a1'))?.columnId, 'review');
    assert.deepEqual(f.ids(), ['a1']);
  } finally { await f.close(); }
});

for (const rebase of [false, true]) {
  test(`${rebase ? 'rebasing onto' : 'merging'} unrelated side history does not prove a repair`, async () => {
    const f = await fixture('full-roadmap');
    try {
      await until(() => f.started.length === 1);
      const task = await failedMerge(f);
      git(f.root, 'checkout', '-b', 'unrelated-side');
      fs.writeFileSync(path.join(f.root, 'unrelated'), 'not part of completed task');
      git(f.root, 'add', 'unrelated'); git(f.root, 'commit', '-m', 'Unrelated side work');
      git(f.root, 'checkout', 'main');
      if (rebase) {
        assert.throws(() => git(task.worktreePath!, 'rebase', 'unrelated-side'));
        fs.writeFileSync(path.join(task.worktreePath!, 'base'), task.id);
        git(task.worktreePath!, 'add', 'base');
        git(task.worktreePath!, '-c', 'core.editor=true', 'rebase', '--continue');
      } else {
        assert.throws(() => git(task.worktreePath!, 'merge', '--no-edit', 'unrelated-side'));
        fs.writeFileSync(path.join(task.worktreePath!, 'base'), task.id);
        git(task.worktreePath!, 'add', 'base'); git(task.worktreePath!, 'commit', '-m', 'Resolve with unrelated side work');
      }
      git(f.root, 'merge', '--ff-only', task.branchName!);
      const recheck = await reconcileTaskIntegration(f.repo, 'a1', f.manager);
      assert.equal(recheck.synchronized, false);
      assert.ok(recheck.reason);
      assert.equal((await f.repo.getById('a1'))?.columnId, 'review');
      assert.equal((await getTaskDependencyGate(f.repo, 'a2')).eligible, false);
      assert.deepEqual(f.ids(), ['a1']);
    } finally { await f.close(); }
  });
}

test('a previous run merge failure cannot approve a newer validation review', async () => {
  const f = await fixture('full-roadmap');
  try {
    await until(() => f.started.length === 1);
    const task = await f.complete('a1');
    const completion = Date.now();
    await f.repo.insertEvent({ id: 'historical-merge-failure', taskId: 'a1', timestamp: completion - 10_000,
      type: 'error', content: 'Auto-merge failed: earlier run conflict' });
    await f.repo.update('a1', { columnId: 'review', completedAt: completion });
    git(f.root, 'merge', '--ff-only', task.branchName!);
    const recheck = await reconcileTaskIntegration(f.repo, 'a1', f.manager);
    assert.equal(recheck.synchronized, false);
    assert.equal((await f.repo.getById('a1'))?.columnId, 'review');
    assert.equal((await getTaskDependencyGate(f.repo, 'a2')).eligible, false);
    assert.deepEqual(f.ids(), ['a1']);
  } finally { await f.close(); }
});

test('manual merge on main recognizes the unchanged original task result', async () => {
  const f = await fixture('full-roadmap');
  try {
    await until(() => f.started.length === 1);
    const task = await failedMerge(f);
    const original = task.repositoryBaseline!.resultCommit!;
    assert.throws(() => git(f.root, 'merge', '--no-edit', task.branchName!));
    fs.writeFileSync(path.join(f.root, 'base'), task.id);
    git(f.root, 'add', 'base'); git(f.root, 'commit', '-m', 'Integrate task manually');
    const main = git(f.root, 'rev-parse', 'main');
    assert.equal(git(f.root, 'rev-parse', task.branchName!), original);
    const recheck = await reconcileTaskIntegration(f.repo, 'a1', f.manager);
    assert.equal(recheck.synchronized, true, recheck.reason);
    await until(() => f.started.length === 2);
    assert.equal((await f.repo.getById('a1'))?.repositoryBaseline?.resultCommit, original);
    assert.deepEqual(f.ids(), ['a1', 'a2']);
    assert.equal(git(f.started[1].worktreePath!, 'rev-parse', 'HEAD'), main);
  } finally { await f.close(); }
});

test('clean index with unresolved merge state fails closed', async () => {
  const f = await fixture('full-roadmap');
  try {
    await until(() => f.started.length === 1);
    const task = await failedMerge(f);
    repairAndFastForward(f, task, true);
    const marker = path.resolve(task.worktreePath!, git(task.worktreePath!, 'rev-parse', '--git-path', 'MERGE_HEAD'));
    fs.writeFileSync(marker, `${git(f.root, 'rev-parse', 'main')}\n`);
    assert.equal(git(task.worktreePath!, 'status', '--porcelain'), '');
    const recheck = await reconcileTaskIntegration(f.repo, 'a1', f.manager);
    assert.equal(recheck.synchronized, false);
    assert.match(recheck.reason!, /unresolved integration/);
    assert.equal((await f.repo.getById('a1'))?.columnId, 'review');
    assert.equal((await getTaskDependencyGate(f.repo, 'a2')).eligible, false);
    assert.deepEqual(f.ids(), ['a1']);
  } finally { await f.close(); }
});

for (const recordedPath of [false, true]) test(`Done repaired prerequisite reconciles with absent worktree (recorded path: ${recordedPath}) and satisfied external gate`, async () => {
  const f = await fixture('full-roadmap');
  try {
    await until(() => f.started.length === 1);
    const task = await failedMerge(f);
    f.stopScheduler();
    const main = repairAndFastForward(f, task, true);
    assert.notEqual(main, task.repositoryBaseline!.resultCommit);
    git(f.root, 'worktree', 'remove', task.worktreePath!);
    // Manual completion can be newer than the automatic merge failure event.
    await f.repo.update('a1', { columnId: 'done', completedAt: Date.now() + 1000,
      worktreePath: recordedPath ? task.worktreePath : undefined });
    await f.groups.create({ id: 'external', projectId: 'default', title: 'v0.12', priority: 'medium',
      columnId: 'done', createdAt: 1, maxConcurrency: 1 }, [{ id: 'external07', projectId: 'default',
      title: '07 Synchronization gate', description: '', priority: 'medium', useWorktree: false }]);
    await f.repo.update('external07', { columnId: 'done', agentStatus: 'complete' });
    await f.repo.createDependency('external07', 'a2', Date.now());
    const before = await getTaskDependencyGate(f.repo, 'a2');
    assert.equal(before.eligible, false);
    assert.equal(before.dependencies[0].status, 'Done');
    if (!recordedPath) assert.match(before.reason!, /branch changed after its recorded completion/);
    const result = await reconcileTaskIntegration(f.repo, 'a1', f.manager, true);
    assert.equal(result.synchronized, true, result.reason);
    const reconciled = (await f.repo.getById('a1'))!;
    assert.equal(reconciled.repositoryBaseline!.resultCommit, main);
    assert.equal(reconciled.repositoryBaseline!.originalResultCommit, task.repositoryBaseline!.resultCommit);
    assert.equal(reconciled.worktreePath, undefined);
    assert.equal((await getTaskDependencyGate(f.repo, 'a2')).eligible, true);
    f.restartScheduler();
    await until(() => f.started.length === 2);
    assert.deepEqual(f.ids(), ['a1', 'a2']);
    assert.equal(git(f.started[1].worktreePath!, 'rev-parse', 'HEAD'), main);
    assert.equal(git(f.root, 'rev-parse', 'main'), main);
  } finally { await f.close(); }
});

for (const scenario of ['not-integrated', 'reset-to-main', 'extra-integrated'] as const) test(`Done without worktree still fails closed for ${scenario}`, async () => {
  const f = await fixture('full-roadmap');
  try {
    await until(() => f.started.length === 1);
    const task = await failedMerge(f);
    f.stopScheduler();
    if (scenario === 'reset-to-main') git(task.worktreePath!, 'reset', '--hard', 'main');
    if (scenario === 'extra-integrated') {
      repairAndFastForward(f, task, true);
      fs.writeFileSync(path.join(task.worktreePath!, 'extra'), 'unrecorded work');
      git(task.worktreePath!, 'add', 'extra'); git(task.worktreePath!, 'commit', '-m', 'Extra work');
      git(f.root, 'merge', '--ff-only', task.branchName!);
    }
    git(f.root, 'worktree', 'remove', task.worktreePath!);
    await f.repo.update('a1', { columnId: 'done', worktreePath: undefined, completedAt: Date.now() + 1000 });
    const result = await reconcileTaskIntegration(f.repo, 'a1', f.manager, true);
    assert.equal(result.synchronized, false);
    assert.ok(result.reason);
    assert.equal((await f.repo.getById('a1'))!.repositoryBaseline!.resultCommit, task.repositoryBaseline!.resultCommit);
    assert.equal((await getTaskDependencyGate(f.repo, 'a2')).eligible, false);
    assert.deepEqual(f.ids(), ['a1']);
  } finally { await f.close(); }
});
