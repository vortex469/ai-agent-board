import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { migrateSqliteDatabase } from '../src/db.js';
import { SqliteTaskRepository } from '../src/repositories/sqlite.js';
import { SqliteTaskGroupRepository } from '../src/repositories/sqlite-groups.js';
import { AgentManager } from '../src/services/agent-manager.js';
import { prepareOrderedGroupBaseline, recordOrderedGroupResult } from '../src/services/group-baseline.js';
import { startOrderedGroupChild } from '../src/services/ordered-group.js';
import type { Task } from '../src/types.js';

function git(cwd: string, ...args: string[]) { return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim(); }
async function fixture() {
  const root = fs.mkdtempSync(path.join(process.cwd(), '.group-chain-test-'));
  const oldTmp = process.env.TMPDIR;
  process.env.TMPDIR = root;
  try {
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.email', 'test@example.invalid');
  git(root, 'config', 'user.name', 'Test');
  fs.writeFileSync(path.join(root, 'base'), 'base');
  git(root, 'add', 'base'); git(root, 'commit', '-m', 'base');
  } catch (error) {
    if (oldTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = oldTmp;
    fs.rmSync(root, { recursive: true, force: true });
    throw error;
  }
  const db = new Database(':memory:'); migrateSqliteDatabase(db);
  const repo = new SqliteTaskRepository(db);
  const groups = new SqliteTaskGroupRepository(db);
  await groups.create({ id: 'chain', projectId: 'default', title: 'Roadmap', priority: 'medium', columnId: 'backlog', createdAt: 1, maxConcurrency: 1, roadmapExecutionMode: 'backlog', repoPath: root, baseBranch: 'main' }, Array.from({ length: 5 }, (_, i) => ({ id: `p${i + 1}`, projectId: 'default', title: `P${i + 1}`, description: '', priority: 'medium', groupOrder: i, useWorktree: true, branchName: `chain/p${i + 1}`, agentType: 'hermes' })));
  const manager = new AgentManager();
  const started: Task[] = [];
  Object.assign(manager, { getAvailableAgents: () => [{ name: 'hermes', available: true }], startAgent: (task: Task) => { task.worktreePath = manager.setupWorktree(task); started.push(task); } });
  async function start() { await startOrderedGroupChild('chain', groups, repo, manager); return started.at(-1)!; }
  async function finish(task: Task, merge = true, retainWorktree = false) {
    fs.writeFileSync(path.join(task.worktreePath!, task.id), task.id);
    git(task.worktreePath!, 'add', task.id); git(task.worktreePath!, 'commit', '-m', task.id);
    await repo.update(task.id, { worktreePath: task.worktreePath });
    await recordOrderedGroupResult((await repo.getById(task.id))!, repo);
    const commit = git(root, 'rev-parse', task.branchName!);
    if (merge) {
      git(root, 'merge', '--ff-only', task.branchName!);
      if (!retainWorktree) {
        assert.notEqual(manager.removeWorktree(task).status, 'blocked');
        await repo.update(task.id, { worktreePath: undefined });
      }
    }
    await repo.update(task.id, { columnId: 'done', agentStatus: 'complete' });
    return commit;
  }
  return { root, db, repo, groups, manager, started, start, finish, close() { db.close(); if (oldTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = oldTmp; fs.rmSync(root, { recursive: true, force: true }); } };
}

test('P1 -> P2 -> P3 worktrees pin and persist the immediate predecessor commit', async () => {
  const f = await fixture();
  try {
    const p1 = await f.start(); const c1 = await f.finish(p1);
    const p2 = await f.start();
    assert.equal(git(p2.worktreePath!, 'rev-parse', 'HEAD'), c1);
    const c2 = await f.finish(p2);
    const p3 = await f.start();
    assert.equal(git(p3.worktreePath!, 'rev-parse', 'HEAD'), c2);
    assert.notEqual(c1, c2);
    const stored = await f.repo.getById(p3.id);
    assert.equal(stored?.repositoryBaseline?.predecessorTaskId, p2.id);
    assert.equal(stored?.repositoryBaseline?.predecessorBranch, p2.branchName);
    assert.equal(stored?.repositoryBaseline?.predecessorCommit, c2);
    assert.equal((await f.groups.getChildTasks('chain'))[2].repositoryBaseline?.startCommit, c2);
    git(f.root, 'merge-base', '--is-ancestor', c2, p3.branchName!);
    assert.equal(new Set(f.started.map(t => t.worktreePath)).size, 3);
  } finally { f.close(); }
});

for (const state of ['failed', 'review', 'uncommitted', 'empty', 'stale-main', 'stale-branch', 'changed-result', 'idle-done']) {
  test(`${state} P2 blocks P3/P4/P5 without creating branches`, async () => {
    const f = await fixture();
    try {
      const p1 = await f.start(); const c1 = await f.finish(p1);
      const p2 = await f.start();
      if (state !== 'empty') await f.finish(p2, state !== 'stale-main', state === 'uncommitted' || state === 'changed-result');
      else await f.repo.update(p2.id, { columnId: 'done', agentStatus: 'complete' });
      if (state === 'failed') await f.repo.update(p2.id, { agentStatus: 'failed' });
      if (state === 'review') await f.repo.update(p2.id, { columnId: 'review' });
      if (state === 'idle-done') await f.repo.update(p2.id, { agentStatus: 'idle' });
      if (state === 'uncommitted') fs.writeFileSync(path.join(p2.worktreePath!, 'dirty'), 'dirty');
      if (state === 'stale-branch') git(f.root, 'branch', 'chain/p3', c1);
      if (state === 'changed-result') { git(p2.worktreePath!, 'commit', '--allow-empty', '-m', 'moved'); git(f.root, 'merge', '--ff-only', p2.branchName!); }
      await f.start();
      assert.equal(f.started.length, 2);
      for (const id of ['p3', 'p4', 'p5']) {
        const child = (await f.repo.getById(id))!;
        await assert.rejects(prepareOrderedGroupBaseline(child, f.repo));
        assert.equal(child.columnId, 'backlog');
      }
    } finally { f.close(); }
  });
}

test('reattaching an existing stale worktree fails ancestry verification', async () => {
  const f = await fixture();
  try {
    const p1 = await f.start(); const c1 = await f.finish(p1);
    const p2 = await f.start(); const c2 = await f.finish(p2);
    const p3 = (await f.repo.getById('p3'))!;
    git(f.root, 'branch', p3.branchName!, c1);
    p3.worktreePath = f.manager.setupWorktree(p3);
    p3.repositoryBaseline = { startCommit: c2, predecessorTaskId: p2.id, predecessorCommit: c2 };
    assert.throws(() => f.manager.setupWorktree(p3), /not contained/);
  } finally { f.close(); }
});

test('ordered successor pins current integrated base including changes beyond its immediate predecessor', async () => {
  const f = await fixture();
  try {
    const p1 = await f.start();
    const predecessorCommit = await f.finish(p1);
    fs.writeFileSync(path.join(f.root, 'external-group-result'), 'integrated external prerequisite');
    git(f.root, 'add', 'external-group-result');
    git(f.root, 'commit', '-m', 'integrate another group result');
    const integratedBase = git(f.root, 'rev-parse', 'HEAD');
    const p2 = await f.start();
    assert.equal(p2.repositoryBaseline?.predecessorCommit, predecessorCommit);
    assert.equal(p2.repositoryBaseline?.startCommit, integratedBase);
    assert.equal(git(p2.worktreePath!, 'rev-parse', 'HEAD'), integratedBase);
  } finally { f.close(); }
});

test('successor uses the recorded integrated result after predecessor worktree and branch cleanup', async () => {
  const f = await fixture();
  try {
    const p1 = await f.start();
    const resultCommit = await f.finish(p1);
    git(f.root, 'branch', '-d', p1.branchName!);
    await f.repo.update(p1.id, { worktreePath: undefined });
    const p2 = await f.start();
    assert.equal(f.started.length, 2);
    assert.equal(p2.id, 'p2');
    assert.equal(p2.repositoryBaseline?.predecessorCommit, resultCommit);
    assert.equal(git(p2.worktreePath!, 'rev-parse', 'HEAD'), resultCommit);
    assert.equal(fs.readFileSync(path.join(p2.worktreePath!, 'p1'), 'utf8'), 'p1');
  } finally { f.close(); }
});

test('deleted predecessor branch cannot bypass integration into the required base', async () => {
  const f = await fixture();
  try {
    const p1 = await f.start();
    await f.finish(p1, false);
    git(f.root, 'worktree', 'remove', p1.worktreePath!);
    git(f.root, 'branch', '-D', p1.branchName!);
    await f.repo.update(p1.id, { worktreePath: undefined });
    const p2 = (await f.repo.getById('p2'))!;
    await assert.rejects(prepareOrderedGroupBaseline(p2, f.repo), /not contained/);
    await f.start();
    assert.equal(f.started.length, 1);
    assert.throws(() => git(f.root, 'show-ref', '--verify', 'refs/heads/chain/p2'));
  } finally { f.close(); }
});
