import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { Task } from '../src/types.js';
import { inspectRepositoryEvidence } from '../src/routes/git.js';

const baseTask: Task = {
  id: 'task-1',
  title: 'Evidence task',
  description: '',
  priority: 'medium',
  columnId: 'review',
  agentStatus: 'complete',
  createdAt: 1,
  projectId: 'project-1',
  repoPath: '/repo',
  branchName: 'agent/evidence',
  baseBranch: 'main',
  useWorktree: true,
};

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function prepareRepoFixture(): { repoPath: string; worktreePath: string; branchName: string; dispose(): void } {
  const root = mkdtempSync(path.join(os.tmpdir(), 'agentboard-evidence-'));
  const repoPath = path.join(root, 'repo');
  const worktreePath = path.join(os.tmpdir(), `agentboard-task-1-${randomUUID().replace(/-/g, '').slice(0, 6)}`);
  const branchName = 'agent/evidence';
  rmSync(worktreePath, { recursive: true, force: true });
  mkdirSync(repoPath, { recursive: true });
  try {
    git(['init', '-b', 'main'], repoPath);
  } catch {
    git(['init'], repoPath);
    git(['checkout', '-b', 'main'], repoPath);
  }
  git(['config', 'user.email', 'test@test.com'], repoPath);
  git(['config', 'user.name', 'Evidence Test'], repoPath);
  writeFileSync(path.join(repoPath, 'README.md'), '# fixture\n');
  git(['add', 'README.md'], repoPath);
  git(['commit', '-m', 'init'], repoPath);
  git(['worktree', 'add', '-b', branchName, worktreePath, 'main'], repoPath);
  return {
    repoPath,
    worktreePath,
    branchName,
    dispose: () => {
      if (existsSync(worktreePath)) {
        try { git(['worktree', 'remove', worktreePath, '--force'], repoPath); } catch {}
      }
      rmSync(root, { recursive: true, force: true });
      rmSync(worktreePath, { recursive: true, force: true });
    },
  };
}

test('repository evidence reports no changes from the managed worktree', () => {
  const f = prepareRepoFixture();
  try {
    const evidence = inspectRepositoryEvidence({ ...baseTask, repoPath: f.repoPath, worktreePath: f.worktreePath, branchName: f.branchName });
    assert.equal(evidence.available, true);
    assert.equal(evidence.state, 'no_changes');
    assert.equal(evidence.worktreePath, f.worktreePath);
    assert.equal(evidence.taskBranch, f.branchName);
    assert.equal(evidence.baseBranch, 'main');
    assert.equal(evidence.changedFileCount, 0);
    assert.equal(evidence.modifiedFileCount, 0);
    assert.equal(evidence.untrackedFileCount, 0);
    assert.equal(evidence.commitsAhead, 0);
    assert.deepEqual(evidence.changedFiles, []);
  } finally {
    f.dispose();
  }
});

test('repository evidence reports working-tree changes from the managed worktree', () => {
  const f = prepareRepoFixture();
  try {
    writeFileSync(path.join(f.worktreePath, 'README.md'), '# changed\n');
    mkdirSync(path.join(f.worktreePath, 'src'), { recursive: true });
    writeFileSync(path.join(f.worktreePath, 'src', 'new-file.ts'), 'export const value = 1;\n');
    const evidence = inspectRepositoryEvidence({ ...baseTask, repoPath: f.repoPath, worktreePath: f.worktreePath, branchName: f.branchName });
    assert.equal(evidence.state, 'working_tree_changes');
    assert.equal(evidence.changedFileCount, 2);
    assert.equal(evidence.modifiedFileCount, 1);
    assert.equal(evidence.untrackedFileCount, 1);
    assert.equal(evidence.commitsAhead, 0);
    assert.deepEqual(evidence.changedFiles, [
      { path: 'README.md', status: 'M' },
      { path: 'src/new-file.ts', status: '??' },
    ]);
  } finally {
    f.dispose();
  }
});

test('repository evidence reports committed changes from the managed worktree', () => {
  const f = prepareRepoFixture();
  try {
    writeFileSync(path.join(f.worktreePath, 'committed.txt'), 'committed\n');
    git(['add', 'committed.txt'], f.worktreePath);
    git(['commit', '-m', 'Agent Board: evidence commit'], f.worktreePath);
    const evidence = inspectRepositoryEvidence({ ...baseTask, repoPath: f.repoPath, worktreePath: f.worktreePath, branchName: f.branchName });
    assert.equal(evidence.state, 'clean_after_commit');
    assert.equal(evidence.changedFileCount, 0);
    assert.equal(evidence.commitsAhead, 1);
    assert.equal(evidence.latestTaskCommit?.subject, 'Agent Board: evidence commit');
    assert.match(evidence.latestTaskCommit?.shortSha ?? '', /^[0-9a-f]+$/);
  } finally {
    f.dispose();
  }
});
