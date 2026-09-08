import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import type { Task } from '../types.js';
import type { TaskRepository } from '../repositories/types.js';

import type { DependencyGateEntry, TaskDependencyGate } from '@ai-agent-board/shared/types.js';
export type { DependencyGateEntry, TaskDependencyGate } from '@ai-agent-board/shared/types.js';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/** A completed coding prerequisite must be integrated into the dependent's actual base. */
function integrationReason(task: Task, prerequisite: Task): string | undefined {
  // Sessions without worktree isolation are explicitly read-only in the runtime.
  if (!prerequisite.useWorktree && !prerequisite.worktreePath && !prerequisite.repositoryBaseline) return;
  if (prerequisite.worktreePath) return 'Waiting for dependency synchronization: prerequisite worktree cleanup is pending or blocked';
  try {
    if (!task.repoPath || !prerequisite.repoPath || fs.realpathSync(task.repoPath) !== fs.realpathSync(prerequisite.repoPath)) {
      return 'Prerequisite repository integration cannot be verified for this project';
    }
    const result = prerequisite.repositoryBaseline?.resultCommit
      ?? (prerequisite.branchName ? git(task.repoPath, 'rev-parse', '--verify', `refs/heads/${prerequisite.branchName}^{commit}`) : undefined);
    if (!result) return 'Prerequisite has no verifiable repository result';
    if (prerequisite.repositoryBaseline?.resultCommit && prerequisite.branchName) {
      let branchCommit: string | undefined;
      try { branchCommit = git(task.repoPath, 'rev-parse', '--verify', `refs/heads/${prerequisite.branchName}^{commit}`); } catch { /* integrated branch may be cleaned */ }
      if (branchCommit && branchCommit !== result) return 'Prerequisite branch changed after its recorded completion';
    }
    git(task.repoPath, 'merge-base', '--is-ancestor', result, `refs/heads/${task.baseBranch || 'main'}`);
    if (!task.useWorktree) git(task.repoPath, 'merge-base', '--is-ancestor', result, 'HEAD');
    if (task.repositoryBaseline) git(task.repoPath, 'merge-base', '--is-ancestor', result, task.repositoryBaseline.startCommit);
    if (task.branchName) {
      let branchExists = false;
      try { git(task.repoPath, 'show-ref', '--verify', `refs/heads/${task.branchName}`); branchExists = true; } catch { /* new branch */ }
      if (branchExists) git(task.repoPath, 'merge-base', '--is-ancestor', result, `refs/heads/${task.branchName}`);
    }
  } catch {
    return 'Repository integration required: prerequisite result must be merged into the expected base and dependent branch';
  }
}

export async function getTaskDependencyGate(repo: TaskRepository, taskId: string): Promise<TaskDependencyGate> {
  const task = await repo.getById(taskId);
  if (!task) return { eligible: false, dependencies: [], reason: 'Task is missing' };
  const relationships = (await repo.getRelationships(taskId)).filter(r => r.type === 'blocks' && r.direction === 'blocked-by');
  const dependencies: DependencyGateEntry[] = [];
  for (const relationship of relationships) {
    const prerequisite = await repo.getById(relationship.relatedTaskId);
    const entry: DependencyGateEntry = { taskId: relationship.relatedTaskId, status: 'Waiting' };
    if (!prerequisite) { entry.status = 'Missing'; entry.reason = 'Dependency task is missing'; }
    else if (prerequisite.projectId !== task.projectId) { entry.status = 'Blocked'; entry.reason = 'Dependency belongs to another project'; }
    else if (prerequisite.agentStatus === 'failed') { entry.status = 'Failed'; entry.reason = `${prerequisite.title} failed or was stopped`; }
    else if (prerequisite.archived) { entry.status = 'Blocked'; entry.reason = `${prerequisite.title} is archived`; }
    else if (prerequisite.columnId !== 'done' || prerequisite.agentStatus !== 'complete') { entry.reason = `Waiting for ${prerequisite.title} to complete successfully`; }
    else {
      entry.reason = integrationReason(task, prerequisite);
      entry.status = entry.reason ? 'Blocked' : 'Done';
    }
    dependencies.push(entry);
  }
  const blocked = dependencies.find(d => d.status !== 'Done');
  let orderedReason: string | undefined;
  const ordered = task.groupId ? await repo.getOrderedGroupTasks?.(task.groupId) : undefined;
  if (ordered) {
    const index = ordered.findIndex(child => child.id === task.id);
    if (index < 0) orderedReason = 'Ordered group child is missing';
    for (const predecessor of ordered.slice(0, Math.max(0, index))) {
      if (predecessor.archived || predecessor.columnId !== 'done' || predecessor.agentStatus !== 'complete') {
        orderedReason = `Waiting for ordered predecessor ${predecessor.title} to complete successfully`;
        break;
      }
      orderedReason = integrationReason(task, predecessor);
      if (orderedReason) break;
    }
  }
  return { eligible: !blocked && !orderedReason, dependencies, reason: blocked?.reason ?? orderedReason };
}

export class DependencyGateError extends Error {}

export async function assertTaskDependencies(task: Task, repo: TaskRepository): Promise<void> {
  const gate = await getTaskDependencyGate(repo, task.id);
  if (!gate.eligible) throw new DependencyGateError(gate.reason || 'Task dependencies are not satisfied');
}

// Serialize dependency-changing mutations with admission across all groups.
// This lock is process-local, matching the single AgentManager execution owner.
let admissionTail: Promise<void> = Promise.resolve();
export async function withDependencyAdmissionLock<T>(operation: () => Promise<T>): Promise<T> {
  const previous = admissionTail;
  let release!: () => void;
  admissionTail = new Promise<void>(resolve => { release = resolve; });
  await previous;
  try { return await operation(); } finally { release(); }
}

/** Validate the effective graph, including the ordering imposed by roadmap groups. */
export async function assertDependencyDoesNotCycle(repo: TaskRepository, prerequisiteId: string, dependentId: string): Promise<void> {
  const pending = [prerequisiteId];
  const visited = new Set<string>();
  while (pending.length) {
    const id = pending.pop()!;
    if (id === dependentId) throw new DependencyGateError('Dependency would create a cycle, including ordered group prerequisites');
    if (visited.has(id)) continue;
    visited.add(id);
    const task = await repo.getById(id);
    if (!task) throw new DependencyGateError(`Dependency task ${id} is missing`);
    for (const relationship of await repo.getRelationships(id)) {
      if (relationship.type === 'blocks' && relationship.direction === 'blocked-by') pending.push(relationship.relatedTaskId);
    }
    const ordered = task.groupId ? await repo.getOrderedGroupTasks?.(task.groupId) : undefined;
    if (ordered) {
      const index = ordered.findIndex(child => child.id === id);
      if (index < 0) throw new DependencyGateError('Ordered group child is missing');
      pending.push(...ordered.slice(0, index).map(child => child.id));
    }
  }
}
