import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Task } from '../types.js';
import type { TaskRepository } from '../repositories/types.js';
import type { AgentManager } from './agent-manager.js';
import { inspectTaskWorktree, listRegisteredWorktrees } from './worktree-cleanup.js';
import { withDependencyAdmissionLock } from './task-dependencies.js';
import { broadcast } from '../websocket.js';

export interface IntegrationStatus { synchronized: boolean; reason?: string }

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000 }).trim();
}
function requireAncestor(cwd: string, commit: string, base: string): void {
  try { git(cwd, 'merge-base', '--is-ancestor', commit, base); }
  catch { throw new Error(`Commit ${commit} is not contained in expected base ${base}`); }
}
function requireClean(cwd: string): void {
  if (git(cwd, 'status', '--porcelain', '--untracked-files=all')) throw new Error('Repository or worktree has uncommitted or untracked changes');
  for (const marker of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply', 'sequencer']) {
    const markerPath = git(cwd, 'rev-parse', '--git-path', marker);
    if (fs.existsSync(path.resolve(cwd, markerPath))) throw new Error('Repository or worktree has an unresolved integration operation');
  }
}

function requireRecordedBase(task: Task, commit: string): void {
  // After a manual fast-forward, every parent of the repaired result is in
  // main. That alone cannot prove the operator repaired onto main rather than
  // an unrelated side branch. Require independent base-history evidence.
  if (commit === task.repositoryBaseline!.startCommit) return;
  const history = git(task.repoPath!, 'reflog', 'show', '--format=%H', `refs/heads/${task.baseBranch || 'main'}`).split('\n');
  if (!history.includes(commit)) throw new Error('Repair base is not a recorded expected-base commit; unrelated additional history is ambiguous');
}

/** Accept a rewrite only at the exact finish of a recorded rebase of the result.
 * Require a one-to-one, linear replay, retaining commit identity metadata. This
 * supports operator conflict resolution, but refuses drops, squash, extra commits,
 * arbitrary resets and missing/expired reflogs. Tree equality alone is never proof.
 */
function verifyRebase(task: Task, head: string): void {
  const cwd = task.repoPath!;
  const baseline = task.repositoryBaseline!;
  const entries = git(cwd, 'reflog', 'show', '-2', '--format=%H%x09%gs', `refs/heads/${task.branchName}`).split('\n');
  const [latest, message] = (entries[0] || '').split('\t');
  const previous = (entries[1] || '').split('\t')[0];
  const onto = message?.match(/^rebase \(finish\): .* onto ([0-9a-f]{40,64})$/)?.[1];
  if (latest !== head || previous !== baseline.resultCommit || !onto) {
    throw new Error('Task branch changed after completion; no exact rebase lineage proves the repaired result (additional commits are ambiguous)');
  }
  requireAncestor(cwd, baseline.startCommit, onto);
  requireRecordedBase(task, onto);
  requireAncestor(cwd, onto, head);
  const originalRange = `${baseline.startCommit}..${baseline.resultCommit}`;
  const repairedRange = `${onto}..${head}`;
  for (const range of [originalRange, repairedRange]) {
    if (git(cwd, 'rev-list', '--merges', range)) throw new Error('Nonlinear task rewrite is ambiguous');
  }
  const identity = ['log', '--reverse', '--format=%an%x00%ae%x00%aI%x00%B%x00'];
  const original = git(cwd, ...identity, originalRange);
  const repaired = git(cwd, ...identity, repairedRange);
  if (!original || original !== repaired) throw new Error('Rebased task does not preserve the complete recorded commit sequence; dropped or additional commits are ambiguous');
  if (!git(cwd, 'diff', '--name-only', onto, head, '--')) throw new Error('Rebased task has no committed repository changes');
}

function verifyRepair(task: Task, head: string, baseHead: string): void {
  const cwd = task.repoPath!;
  const original = task.repositoryBaseline!.resultCommit!;
  const parents = git(cwd, 'show', '-s', '--format=%P', head).split(' ');
  // A single conflict-resolution merge may join the exact task result to an
  // already-integrated base. No task-side additional commits are accepted.
  if (parents.length === 2 && parents[0] === original) {
    requireAncestor(cwd, parents[1], baseHead);
    requireAncestor(cwd, task.repositoryBaseline!.startCommit, parents[1]);
    requireRecordedBase(task, parents[1]);
    return;
  }
  verifyRebase(task, head);
}

function inspect(task: Task): { head: string; baseHead: string } {
  if (!task.groupId || !task.useWorktree || !task.repoPath || !task.branchName || !task.repositoryBaseline?.resultCommit) {
    throw new Error('No recorded grouped-task repository result is available for reconciliation');
  }
  if (task.agentStatus !== 'complete' || task.archived || !['review', 'done'].includes(task.columnId)) {
    throw new Error('Only completed, unarchived grouped tasks can be reconciled');
  }
  const cwd = task.repoPath;
  const base = `refs/heads/${task.baseBranch || 'main'}`;
  git(cwd, 'check-ref-format', base);
  git(cwd, 'check-ref-format', `refs/heads/${task.branchName}`);
  const baseHead = git(cwd, 'rev-parse', '--verify', `${base}^{commit}`);
  let head: string;
  try { head = git(cwd, 'rev-parse', '--verify', `refs/heads/${task.branchName}^{commit}`); }
  catch {
    // A deleted branch is safe only for the exact recorded result, never a rewrite.
    head = task.repositoryBaseline.resultCommit;
  }
  requireClean(cwd);
  for (const worktree of listRegisteredWorktrees(cwd)) {
    if (worktree.branch === task.branchName || worktree.branch === (task.baseBranch || 'main')) requireClean(worktree.path);
  }
  if (task.worktreePath) {
    const worktree = inspectTaskWorktree(task);
    if (worktree.status === 'blocked') throw new Error(worktree.reason);
  }
  requireAncestor(cwd, task.repositoryBaseline.startCommit, task.repositoryBaseline.resultCommit);
  if (head !== task.repositoryBaseline.resultCommit) verifyRepair(task, head, baseHead);
  requireAncestor(cwd, head, baseHead);
  return { head, baseHead };
}

export function inspectTaskIntegration(task: Task): IntegrationStatus {
  try {
    inspect(task);
    return task.columnId === 'done' && !task.worktreePath
      ? { synchronized: true }
      : { synchronized: false, reason: 'Branch commit is already contained in base; recheck to finalize repository synchronization' };
  } catch (error) { return { synchronized: false, reason: error instanceof Error ? error.message : 'Git integration could not be verified' }; }
}

export async function reconcileTaskIntegration(repo: TaskRepository, taskId: string, manager: AgentManager,
  automatic = false): Promise<IntegrationStatus> {
  return withDependencyAdmissionLock(async () => {
    const task = await repo.getById(taskId);
    if (!task) return { synchronized: false, reason: 'Task not found' };
    if (!task.repoPath) return { synchronized: false, reason: 'Task repository is missing' };
    return manager.withRepoLock(task.repoPath, async () => {
      try {
        // Review may represent a failed validation gate, not a failed merge. Do
        // not turn external Git activity into approval of an unreviewed task.
        const events = await repo.getEventsByTaskId(task.id);
        const completionTime = task.completedAt ?? task.startedAt ?? 0;
        const failedMerge = events.some(event => event.type === 'error' && event.timestamp >= completionTime
          && /^Auto-merge (failed:|succeeded into .*worktree cleanup was blocked:)/.test(event.content));
        if (!failedMerge) {
          // Periodic scans need no Git subprocesses for ordinary successful tasks.
          const status = automatic ? { synchronized: false } : inspectTaskIntegration(task);
          return status.synchronized ? status : {
            synchronized: false,
            reason: 'No automatic merge failure is recorded for this completion; existing review and validation requirements remain in effect',
          };
        }
        const proof = inspect(task);
        if (task.columnId === 'done' && !task.worktreePath && proof.head === task.repositoryBaseline?.resultCommit) return { synchronized: true };
        if (manager.isRunning(task.id)) return { synchronized: false, reason: 'Task still has a running agent' };
        const cleanup = manager.removeWorktree(task);
        if (cleanup.status === 'blocked') return { synchronized: false, reason: cleanup.reason };
        // Cleanup and local merges share the repository mutex. Re-read refs after
        // cleanup as an operator can still change Git outside this process.
        const confirmed = inspect({ ...task, worktreePath: undefined });
        if (proof.head !== confirmed.head || proof.baseHead !== confirmed.baseHead) throw new Error('Repository changed during reconciliation; recheck integration');
        const baseline = task.repositoryBaseline!;
        const updated = await repo.update(task.id, {
          columnId: 'done', worktreePath: undefined, completedAt: task.completedAt ?? Date.now(),
          repositoryBaseline: { ...baseline, resultCommit: proof.head,
            ...(proof.head !== baseline.resultCommit ? { originalResultCommit: baseline.originalResultCommit ?? baseline.resultCommit } : {}) },
        });
        if (!updated) throw new Error('Task disappeared during reconciliation');
        await repo.clearRun(task.id);
        const event = { id: randomUUID(), taskId: task.id, timestamp: Date.now(), type: 'output' as const,
          content: `External integration detected: branch commit ${proof.head} already contained in ${task.baseBranch || 'main'}. Stale merge failure cleared; dependency synchronization satisfied.` };
        await repo.insertEvent(event);
        broadcast({ type: 'agent_event', payload: event });
        broadcast({ type: 'task_updated', payload: updated });
        console.log(`[integration] ${task.id}: ${event.content} Scheduler reevaluation triggered.`);
        return { synchronized: true };
      } catch (error) { return { synchronized: false, reason: error instanceof Error ? error.message : 'Git integration could not be verified' }; }
    });
  });
}
