import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import type { AgentProvider } from '@codewithdan/agent-sdk-core';
import type { AgentEvent, Task } from '../src/types.js';
import { AgentManager } from '../src/services/agent-manager.js';

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
}

function fixture(): { repoPath: string; dispose(): void } {
  const repoPath = mkdtempSync(path.join(os.tmpdir(), 'agentboard-no-change-repo-'));
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
    title: 'No-op local coding task',
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
    agentType: 'local-openai',
  };
}

function cleanupTaskWorktree(repoPath: string, worktreePath?: string): void {
  if (worktreePath) {
    try { git(['worktree', 'remove', worktreePath, '--force'], repoPath); } catch { /* already removed */ }
    rmSync(worktreePath, { recursive: true, force: true });
  }
}

test('managed local AI worktree completion fails when the agent made no repository changes', async () => {
  const f = fixture();
  const manager = new AgentManager();
  const events: AgentEvent[] = [];
  manager.initEventPersistence({
    insertEvent: async (event: AgentEvent) => { events.push(event); },
    getEventsByTaskId: async (taskId: string) => events.filter((event) => event.taskId === taskId),
  } as Parameters<AgentManager['initEventPersistence']>[0]);
  const provider = {
    displayName: 'Fake Local AI',
    start: async () => {},
    stop: async () => {},
    createSession: async () => ({
      execute: async () => ({ status: 'complete' as const }),
      destroy: async () => {},
      abort: async () => {},
    }),
  } as unknown as AgentProvider;
  (manager as unknown as { providers: Map<string, AgentProvider> }).providers.set('local-openai', provider);
  (manager as unknown as { availableAgents: Array<{ name: string; displayName: string; available: boolean }> }).availableAgents = [
    { name: 'local-openai', displayName: 'Fake Local AI', available: true },
  ];

  const t = task(f.repoPath, 'smoke/no-change-local-ai');
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

    assert.equal(finalStatus, 'failed');
    assert.ok(t.worktreePath);
    assert.equal(git(['status', '--porcelain'], t.worktreePath), '');
    assert.equal(git(['rev-list', '--count', 'main..smoke/no-change-local-ai'], f.repoPath), '0');
    assert.ok(events.some((event) =>
      event.type === 'error' &&
      event.content.includes('Agent reported completion without repository changes'),
    ));
  } finally {
    cleanupTaskWorktree(f.repoPath, t.worktreePath);
    f.dispose();
  }
});
