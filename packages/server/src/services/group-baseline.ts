import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import type { Task } from '../types.js';
import type { TaskRepository } from '../repositories/types.js';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function ancestor(repo: string, commit: string, ref: string): void {
  try { git(repo, 'merge-base', '--is-ancestor', commit, ref); }
  catch { throw new Error(`Required predecessor commit ${commit} is not contained in ${ref}`); }
}

export async function recordOrderedGroupResult(task: Task, repo: TaskRepository): Promise<void> {
  if (!task.repositoryBaseline) return;
  verifyGroupBaseline(task);
  const commit = git(task.repoPath!, 'rev-parse', '--verify', `refs/heads/${task.branchName}^{commit}`);
  if (task.worktreePath && fs.existsSync(task.worktreePath) && git(task.worktreePath, 'status', '--porcelain', '--untracked-files=all')) {
    throw new Error('Ordered task result has uncommitted changes');
  }
  if (!git(task.repoPath!, 'diff', '--name-only', task.repositoryBaseline.startCommit, commit, '--')) {
    throw new Error('Ordered coding task has no committed repository changes');
  }
  await repo.update(task.id, { repositoryBaseline: { ...task.repositoryBaseline, resultCommit: commit } });
}

/** Also called when reattaching an existing branch: never silently reuse stale work. */
export function verifyGroupBaseline(task: Task): void {
  const baseline = task.repositoryBaseline;
  if (!baseline) return;
  if (!task.useWorktree || !task.repoPath || !task.branchName) throw new Error('Ordered coding tasks require an isolated worktree');
  ancestor(task.repoPath, baseline.startCommit, task.baseBranch || 'main');
  if (baseline.predecessorCommit) ancestor(task.repoPath, baseline.predecessorCommit, baseline.startCommit);
  try { git(task.repoPath, 'show-ref', '--verify', `refs/heads/${task.branchName}`); }
  catch { return; }
  ancestor(task.repoPath, baseline.startCommit, `refs/heads/${task.branchName}`);
}

/** Pin the actual repository input before dispatch; all earlier children must remain valid. */
export async function prepareOrderedGroupBaseline(task: Task, repo: TaskRepository): Promise<void> {
  if (!task.groupId) return;
  const children = await repo.getOrderedGroupTasks(task.groupId);
  if (!children) return;
  const index = children.findIndex(child => child.id === task.id);
  if (index < 0) throw new Error('Ordered group child is missing');
  if (children.some(child => child.id !== task.id && ['planning', 'executing'].includes(child.agentStatus))) {
    throw new Error('Another ordered group child is running');
  }
  let predecessor: Task | undefined;
  let predecessorCommit: string | undefined;
  for (const previous of children.slice(0, index)) {
    if (previous.archived || previous.columnId !== 'done' || previous.agentStatus !== 'complete') {
      throw new Error(`Predecessor ${previous.title} must complete successfully and leave Review before this task can start`);
    }
    if (previous.useWorktree || previous.repositoryBaseline) {
      if (!previous.repoPath || !task.repoPath || fs.realpathSync(previous.repoPath) !== fs.realpathSync(task.repoPath)) {
        throw new Error('Predecessor repository does not match the dependent repository');
      }
      if (!previous.branchName || !previous.repositoryBaseline) throw new Error(`Predecessor ${previous.title} has no recorded repository baseline; dependency cannot be verified`);
      if (previous.worktreePath && fs.existsSync(previous.worktreePath)
        && git(previous.worktreePath, 'status', '--porcelain', '--untracked-files=all')) {
        throw new Error(`Predecessor ${previous.title} has uncommitted changes`);
      }
      // Require the current branch as well as persisted evidence: a missing
      // branch cannot prove that the recorded completion is still current.
      const commit = previous.repositoryBaseline.resultCommit;
      if (!commit) throw new Error(`Predecessor ${previous.title} has no recorded result commit`);
      let branchCommit: string | undefined;
      try { branchCommit = git(task.repoPath, 'rev-parse', '--verify', `refs/heads/${previous.branchName}^{commit}`); }
      catch { throw new Error(`Predecessor ${previous.title} branch is missing`); }
      if (branchCommit && branchCommit !== commit) throw new Error(`Predecessor ${previous.title} has no matching recorded result commit`);
      ancestor(task.repoPath, previous.repositoryBaseline.startCommit, commit);
      if (!git(task.repoPath, 'diff', '--name-only', previous.repositoryBaseline.startCommit, commit, '--')) {
        throw new Error(`Predecessor ${previous.title} has no committed repository changes`);
      }
      ancestor(task.repoPath, commit, task.baseBranch || 'main');
      predecessor = previous;
      predecessorCommit = commit;
    }
  }
  if (!task.useWorktree) {
    if (predecessor || task.repositoryBaseline) throw new Error('A dependent coding task must preserve worktree isolation');
    return;
  }
  if (!task.repoPath) throw new Error('Ordered coding task requires a repository');
  const baseline = task.repositoryBaseline ?? {
    startCommit: git(task.repoPath, 'rev-parse', '--verify', `${task.baseBranch || 'main'}^{commit}`),
    predecessorTaskId: predecessor?.id,
    predecessorBranch: predecessor?.branchName,
    predecessorCommit,
  };
  if (baseline.predecessorTaskId !== predecessor?.id || baseline.predecessorBranch !== predecessor?.branchName || baseline.predecessorCommit !== predecessorCommit) {
    throw new Error('Recorded predecessor changed; dependent branch requires explicit recovery');
  }
  task.repositoryBaseline = baseline;
  verifyGroupBaseline(task);
  await repo.update(task.id, { repositoryBaseline: baseline });
}
