import { Router, Request, Response } from 'express';
import { execFileSync } from 'child_process';
import type { RepositoryEvidence, RepositoryEvidenceCommit, RepositoryEvidenceFile, RepositoryEvidenceState, Task } from '../types.js';
import type { TaskRepository } from '../repositories/types.js';
import type { ProjectRepository } from '../repositories/project-types.js';
import type { AgentManager } from '../services/agent-manager.js';
import { inspectTaskWorktreeIdentity } from '../services/worktree-cleanup.js';
import { asyncHandler, paramId, broadcastTaskUpdate, triggerAutomaticDependentProgression } from './helpers.js';

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function emptyRepositoryEvidence(task: Task, state: RepositoryEvidenceState, error?: string): RepositoryEvidence {
  return {
    available: false,
    state,
    worktreePath: task.worktreePath,
    taskBranch: task.branchName,
    baseBranch: task.baseBranch,
    changedFileCount: 0,
    modifiedFileCount: 0,
    untrackedFileCount: 0,
    commitsAhead: 0,
    changedFiles: [],
    error,
  };
}

function parsePorcelainStatus(output: string): RepositoryEvidenceFile[] {
  if (!output) return [];
  return output.split('\n').flatMap((line) => {
    if (!line.trim()) return [];
    const status = line.slice(0, 2).trim() || line.slice(0, 2);
    const rawPath = line.slice(2).trim();
    const path = rawPath.includes(' -> ') ? rawPath.split(' -> ').pop()! : rawPath;
    if (!path || path.startsWith('/')) return [];
    return [{ path, status }];
  });
}

function parseLatestCommit(output: string): RepositoryEvidenceCommit | undefined {
  if (!output) return undefined;
  const [sha, shortSha, authorDate, authorName, ...subjectParts] = output.split('\t');
  if (!sha || !shortSha) return undefined;
  return {
    sha,
    shortSha,
    authorDate: authorDate ?? '',
    authorName: authorName ?? '',
    subject: subjectParts.join('\t') || '(no subject)',
  };
}

export function inspectRepositoryEvidence(task: Task): RepositoryEvidence {
  if (!task.worktreePath) {
    return emptyRepositoryEvidence(task, 'unavailable', 'No managed worktree path is recorded for this task.');
  }
  const worktreeInspection = inspectTaskWorktreeIdentity(task);
  if (worktreeInspection.status === 'missing') {
    return emptyRepositoryEvidence(task, 'unavailable', 'Managed worktree path is no longer available.');
  }
  if (worktreeInspection.status === 'blocked') {
    return emptyRepositoryEvidence(task, 'unavailable', 'Persisted worktree path is not a verified Board-managed worktree.');
  }

  try {
    const baseBranch = task.baseBranch || 'main';
    const statusOutput = git(['status', '--porcelain=v1', '--untracked-files=all'], task.worktreePath);
    const changedFiles = parsePorcelainStatus(statusOutput);
    const untrackedFileCount = changedFiles.filter((file) => file.status === '??').length;
    const modifiedFileCount = changedFiles.length - untrackedFileCount;
    const baseCommit = git(['rev-parse', baseBranch], task.worktreePath);
    const baseShortCommit = git(['rev-parse', '--short', baseBranch], task.worktreePath);
    const commitsAheadOutput = git(['rev-list', '--count', `${baseBranch}..HEAD`], task.worktreePath);
    const commitsAhead = Number.parseInt(commitsAheadOutput, 10) || 0;
    const latestTaskCommit = commitsAhead > 0
      ? parseLatestCommit(git(['log', '-1', '--format=%H%x09%h%x09%cI%x09%an%x09%s', 'HEAD'], task.worktreePath))
      : undefined;

    let state: RepositoryEvidenceState = 'no_changes';
    if (commitsAhead > 0 && changedFiles.length > 0) state = 'task_commit_present';
    else if (commitsAhead > 0) state = 'clean_after_commit';
    else if (changedFiles.length > 0) state = 'working_tree_changes';

    return {
      available: true,
      state,
      worktreePath: task.worktreePath,
      taskBranch: task.branchName || git(['branch', '--show-current'], task.worktreePath),
      baseBranch,
      baseCommit,
      baseShortCommit,
      changedFileCount: changedFiles.length,
      modifiedFileCount,
      untrackedFileCount,
      commitsAhead,
      changedFiles,
      latestTaskCommit,
    };
  } catch {
    return emptyRepositoryEvidence(task, 'unavailable', 'Repository evidence could not be read from the managed worktree.');
  }
}

export function createGitRouter(repo: TaskRepository, agentManager: AgentManager, projectRepo?: ProjectRepository): Router {
  const router = Router();

  // GET /api/tasks/:id/git-info — check if repo has a remote
  router.get('/:id/git-info', asyncHandler(async (req: Request, res: Response) => {
    const id = paramId(req);
    const task = await repo.getById(id);
    if (!task) { res.status(404).json({ error: 'task not found' }); return; }
    const readiness = agentManager.getMergeReadiness(task);
    const repositoryEvidence = inspectRepositoryEvidence(task);
    if (!task.repoPath) {
      res.json({ hasRemote: false, mergeReady: readiness.ready, mergeBlockedReason: readiness.reason, repositoryEvidence });
      return;
    }
    try {
      const remote = execFileSync('git', ['remote', 'get-url', 'origin'], {
        cwd: task.repoPath, stdio: ['ignore', 'pipe', 'pipe'],
      }).toString().trim();
      res.json({ hasRemote: !!remote, mergeReady: readiness.ready, mergeBlockedReason: readiness.reason, repositoryEvidence });
    } catch {
      res.json({ hasRemote: false, mergeReady: readiness.ready, mergeBlockedReason: readiness.reason, repositoryEvidence });
    }
  }));

  // POST /api/tasks/:id/create-pr — create a PR from the worktree branch
  router.post('/:id/create-pr', asyncHandler(async (req: Request, res: Response) => {
    const id = paramId(req);
    const task = await repo.getById(id);
    if (!task) {
      res.status(404).json({ error: 'task not found' });
      return;
    }
    if (!task.branchName || !task.repoPath) {
      res.status(400).json({ error: 'task has no branch or repo configured' });
      return;
    }
    try {
      const result = agentManager.createPR(task);
      // Clean up worktree after successful PR — branch is pushed, directory is no longer needed
      if (task.worktreePath) {
        const cleanup = agentManager.removeWorktree(task);
        if (cleanup.status !== 'blocked') {
          const updated = await repo.update(id, { worktreePath: undefined });
          if (updated) broadcastTaskUpdate(updated);
        }
      }
      res.json(result);
    } catch (err: unknown) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to create PR' });
    }
  }));

  // POST /api/tasks/:id/cleanup-worktree — remove worktree after done
  router.post('/:id/cleanup-worktree', asyncHandler(async (req: Request, res: Response) => {
    const id = paramId(req);
    const task = await repo.getById(id);
    if (!task) {
      res.status(404).json({ error: 'task not found' });
      return;
    }
    if (!task.worktreePath) {
      res.json({ success: true, status: 'missing' });
      return;
    }
    if (agentManager.isRunning(id)) {
      res.status(409).json({ error: 'cannot clean up a worktree while its agent is running' });
      return;
    }
    const cleanup = agentManager.removeWorktree(task);
    if (cleanup.status === 'blocked') {
      res.status(409).json({ error: cleanup.reason });
      return;
    }
    const updated = await repo.update(id, { worktreePath: undefined });
    if (updated) broadcastTaskUpdate(updated);
    res.json({ success: true, status: cleanup.status });
  }));

  // POST /api/tasks/:id/merge-local — merge worktree branch into base branch locally
  router.post('/:id/merge-local', asyncHandler(async (req: Request, res: Response) => {
    const id = paramId(req);
    const task = await repo.getById(id);
    if (!task) {
      res.status(404).json({ error: 'task not found' });
      return;
    }
    if (!task.branchName || !task.repoPath) {
      res.status(400).json({ error: 'task has no branch or repo configured' });
      return;
    }
    try {
      const result = await agentManager.mergeLocal(task);

      // A successful local merge completes the board lifecycle. Cleanup remains
      // fail-closed: a blocked worktree is retained for recovery and startup
      // reconciliation, but the successfully merged task still advances to Done.
      const updates: Partial<Task> = {
        columnId: 'done',
        completedAt: Date.now(),
      };

      if (task.worktreePath) {
        const cleanup = agentManager.removeWorktree(task);
        if (cleanup.status !== 'blocked') {
          updates.worktreePath = undefined;
        }
      }

      const updated = await repo.update(id, updates);
      if (!updated) {
        res.status(500).json({ error: 'merge succeeded but failed to update task state' });
        return;
      }
      broadcastTaskUpdate(updated);
      if (!updated.worktreePath) console.log(`[scheduler] repository synchronization completed: ${id} into ${result.baseBranch}`);
      await triggerAutomaticDependentProgression(repo, updated, agentManager, projectRepo);
      res.json(result);
    } catch (err: unknown) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to merge' });
    }
  }));

  return router;
}
