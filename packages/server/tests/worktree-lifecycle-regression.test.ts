import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import type { AgentProvider } from '@codewithdan/agent-sdk-core';
import type { Task } from '../src/types.js';
import { AgentManager } from '../src/services/agent-manager.js';

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

function cleanupTaskWorktree(repoPath: string, worktreePath?: string): void {
  if (worktreePath) {
    try { git(['worktree', 'remove', worktreePath, '--force'], repoPath); } catch { /* already removed */ }
    rmSync(worktreePath, { recursive: true, force: true });
  }
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
