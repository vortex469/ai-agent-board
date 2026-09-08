import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import test from 'node:test';
import type { Task } from '../src/types.js';
import { inspectRepositoryEvidence } from '../src/routes/git.js';

function fixture() {
  const repoPath = mkdtempSync(path.join(process.cwd(), '.historical-evidence-'));
  const git = (...args: string[]) => execFileSync('git', args, {
    cwd: repoPath, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  git('init', '-b', 'main');
  git('config', 'user.name', 'Evidence Test');
  git('config', 'user.email', 'evidence@example.test');
  writeFileSync(path.join(repoPath, 'mining.txt'), 'initial\n');
  git('add', '.'); git('commit', '-m', 'initial');
  const startCommit = git('rev-parse', 'HEAD');
  git('checkout', '-b', 'group/c73e7bd2/7-de1ce9b6');
  writeFileSync(path.join(repoPath, 'mining.txt'), 'persistence\n');
  git('commit', '-am', 'Mining persistence and streaming');
  const resultCommit = git('rev-parse', 'HEAD');
  git('checkout', 'main');
  const task: Task = {
    id: 'card-08', title: 'Mining persistence and streaming', description: '', priority: 'medium',
    columnId: 'review', agentStatus: 'complete', projectId: 'voxel', groupId: 'v0.13', createdAt: 1,
    repoPath, branchName: 'group/c73e7bd2/7-de1ce9b6', baseBranch: 'main', useWorktree: true,
    repositoryBaseline: { startCommit, resultCommit },
  };
  return { task, git, repoPath, dispose: () => rmSync(repoPath, { recursive: true, force: true }) };
}

test('repaired and integrated completion remains visible with no worktree and a stale recorded result', () => {
  const f = fixture();
  try {
    writeFileSync(path.join(f.repoPath, 'mining.txt'), 'main changed\n');
    f.git('commit', '-am', 'main update');
    assert.throws(() => f.git('merge', f.task.branchName!));
    f.git('merge', '--abort');
    f.git('checkout', f.task.branchName!);
    assert.throws(() => f.git('rebase', 'main'));
    writeFileSync(path.join(f.repoPath, 'mining.txt'), 'repaired persistence\n');
    f.git('add', 'mining.txt');
    f.git('-c', 'core.editor=true', 'rebase', '--continue');
    const repaired = f.git('rev-parse', 'HEAD');
    assert.notEqual(repaired, f.task.repositoryBaseline!.resultCommit);
    f.git('checkout', 'main'); f.git('merge', '--ff-only', f.task.branchName!);
    writeFileSync(path.join(f.repoPath, 'unrelated.txt'), 'primary checkout untracked\n');
    const evidence = inspectRepositoryEvidence(f.task);
    assert.equal(evidence.available, true);
    assert.equal(evidence.error, undefined);
    assert.equal(evidence.baseCommit, repaired);
    assert.equal(evidence.latestTaskCommit?.sha, repaired);
    assert.equal(evidence.latestTaskCommit?.subject, 'Mining persistence and streaming');
    assert.equal(evidence.commitsAhead, 0);
    assert.equal(evidence.changedFileCount, 0);
    assert.equal(evidence.untrackedFileCount, 0);
    assert.equal(evidence.worktreePath, undefined);
    // Merely displaying Git state must never reconcile the stored completion.
    assert.notEqual(f.task.repositoryBaseline!.resultCommit, repaired);
  } finally { f.dispose(); }
});

test('deleted task branch retains historical evidence from the recorded completion SHA', () => {
  const f = fixture();
  try {
    f.git('merge', '--ff-only', f.task.branchName!);
    f.git('branch', '-d', f.task.branchName!);
    const evidence = inspectRepositoryEvidence(f.task);
    assert.equal(evidence.available, true);
    assert.equal(evidence.latestTaskCommit?.sha, f.task.repositoryBaseline!.resultCommit);
    assert.equal(evidence.commitsAhead, 0);
  } finally { f.dispose(); }
});

test('an unintegrated branch stays ahead in historical evidence', () => {
  const f = fixture();
  try {
    const evidence = inspectRepositoryEvidence(f.task);
    assert.equal(evidence.available, true);
    assert.equal(evidence.commitsAhead, 1);
    assert.equal(evidence.state, 'clean_after_commit');
  } finally { f.dispose(); }
});

test('a recorded managed worktree path that has disappeared uses historical commits', (t) => {
  const f = fixture();
  t.mock.method(os, 'tmpdir', () => f.repoPath);
  try {
    f.git('merge', '--ff-only', f.task.branchName!);
    const worktreePath = path.join(f.repoPath, 'agentboard-card-08-ABC123');
    const evidence = inspectRepositoryEvidence({ ...f.task, worktreePath });
    assert.equal(evidence.available, true);
    assert.equal(evidence.latestTaskCommit?.sha, f.task.repositoryBaseline!.resultCommit);
    assert.equal(evidence.commitsAhead, 0);
    assert.equal(evidence.worktreePath, worktreePath);
  } finally {
    f.dispose();
  }
});

test('historical fallback refuses invalid metadata, nested repo paths, and blocked worktree identities', () => {
  const f = fixture();
  try {
    mkdirSync(path.join(f.repoPath, 'nested'));
    for (const patch of [
      { branchName: '../main' },
      { baseBranch: '--all' },
      { repoPath: path.join(f.repoPath, 'nested') },
      { branchName: undefined, repositoryBaseline: { startCommit: f.task.repositoryBaseline!.startCommit, resultCommit: 'HEAD' } },
      { worktreePath: f.repoPath },
      { agentStatus: 'executing' as const },
    ]) {
      assert.equal(inspectRepositoryEvidence({ ...f.task, ...patch }).available, false, JSON.stringify(patch));
    }
  } finally { f.dispose(); }
});
