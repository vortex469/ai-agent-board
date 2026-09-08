import { Router, Request, Response } from 'express';
import { execFileSync } from 'child_process';
import { realpathSync } from 'node:fs';
import type { RepositoryEvidence, RepositoryEvidenceCommit, RepositoryEvidenceFile, RepositoryEvidenceState, Task } from '../types.js';
import type { TaskRepository } from '../repositories/types.js';
import type { ProjectRepository } from '../repositories/project-types.js';
import type { AgentManager } from '../services/agent-manager.js';
import { inspectTaskWorktreeIdentity } from '../services/worktree-cleanup.js';
import { inspectTaskIntegration, reconcileTaskIntegration } from '../services/task-integration.js';
import { asyncHandler, paramId, broadcastTaskUpdate, triggerAutomaticDependentProgression } from './helpers.js';

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
    timeout: 5000,
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

/** Historical commit evidence is observational; it never approves integration. */
function inspectHistoricalRepositoryEvidence(task: Task, missingReason: string): RepositoryEvidence {
  if (!task.repoPath || task.agentStatus !== 'complete' || (!task.branchName && !task.repositoryBaseline?.resultCommit)) {
    return emptyRepositoryEvidence(task, 'unavailable', missingReason);
  }
  try {
    const cwd = realpathSync(task.repoPath);
    // Do not let Git's parent-directory discovery substitute another repository.
    if (realpathSync(git(['rev-parse', '--show-toplevel'], cwd)) !== cwd) throw new Error('Repository root mismatch');
    const baseBranch = task.baseBranch || 'main';
    const baseRef = `refs/heads/${baseBranch}`;
    git(['check-ref-format', baseRef], cwd);
    const baseCommit = git(['rev-parse', '--verify', '--end-of-options', `${baseRef}^{commit}`], cwd);
    let taskCommit: string | undefined;
    if (task.branchName) {
      const branchRef = `refs/heads/${task.branchName}`;
      git(['check-ref-format', branchRef], cwd);
      try { taskCommit = git(['rev-parse', '--verify', '--end-of-options', `${branchRef}^{commit}`], cwd); }
      catch { /* A cleaned-up branch can still have a recorded result commit. */ }
    }
    if (!taskCommit) {
      const recorded = task.repositoryBaseline?.resultCommit;
      if (!recorded || !/^[0-9a-f]{40,64}$/i.test(recorded)) throw new Error('No recorded commit');
      taskCommit = git(['rev-parse', '--verify', '--end-of-options', `${recorded}^{commit}`], cwd);
    }
    const commitsAhead = Number.parseInt(git(['rev-list', '--count', `${baseCommit}..${taskCommit}`, '--'], cwd), 10);
    const latestTaskCommit = parseLatestCommit(git(['log', '-1', '--format=%H%x09%h%x09%cI%x09%an%x09%s', taskCommit, '--'], cwd));
    return {
      ...emptyRepositoryEvidence(task, commitsAhead > 0 ? 'clean_after_commit' : 'no_changes'),
      available: true,
      baseBranch,
      baseCommit,
      baseShortCommit: git(['rev-parse', '--short', baseCommit], cwd),
      commitsAhead,
      latestTaskCommit,
    };
  } catch {
    return emptyRepositoryEvidence(task, 'unavailable', 'Historical repository evidence could not be verified from recorded branch or commit metadata.');
  }
}

export function inspectRepositoryEvidence(task: Task): RepositoryEvidence {
  if (!task.worktreePath) {
    return inspectHistoricalRepositoryEvidence(task, 'No managed worktree path is recorded for this task.');
  }
  const worktreeInspection = inspectTaskWorktreeIdentity(task);
  if (worktreeInspection.status === 'missing') {
    return inspectHistoricalRepositoryEvidence(task, 'Managed worktree path is no longer available.');
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

  router.post('/:id/recheck-integration', asyncHandler(async (req: Request, res: Response) => {
    const id = paramId(req);
    if (!await repo.getById(id)) { res.status(404).json({ error: 'task not found' }); return; }
    res.json(await reconcileTaskIntegration(repo, id, agentManager));
  }));

  // GET /api/tasks/:id/git-info — check if repo has a remote
  router.get('/:id/git-info', asyncHandler(async (req: Request, res: Response) => {
    const id = paramId(req);
    const task = await repo.getById(id);
    if (!task) { res.status(404).json({ error: 'task not found' }); return; }
    const readiness = agentManager.getMergeReadiness(task);
    const repositoryEvidence = inspectRepositoryEvidence(task);
    const integration = task.groupId && task.repositoryBaseline?.resultCommit && task.agentStatus === 'complete'
      ? inspectTaskIntegration(task) : undefined;
    if (!task.repoPath) {
      res.json({ hasRemote: false, mergeReady: readiness.ready, mergeBlockedReason: readiness.reason, repositoryEvidence, integration });
      return;
    }
    try {
      const remote = execFileSync('git', ['remote', 'get-url', 'origin'], {
        cwd: task.repoPath, stdio: ['ignore', 'pipe', 'pipe'],
      }).toString().trim();
      res.json({ hasRemote: !!remote, mergeReady: readiness.ready, mergeBlockedReason: readiness.reason, repositoryEvidence, integration });
    } catch {
      res.json({ hasRemote: false, mergeReady: readiness.ready, mergeBlockedReason: readiness.reason, repositoryEvidence, integration });
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

      let updated = await repo.update(id, updates);
      if (!updated) {
        res.status(500).json({ error: 'merge succeeded but failed to update task state' });
        return;
      }
      // A manual rebase can change the completed result before this merge.
      // Persist the validated replacement before notifying dependency admission;
      // a successful merge alone does not prove the rewritten task's lineage.
      if (updated.groupId && updated.repositoryBaseline?.resultCommit && updated.agentStatus === 'complete') {
        await reconcileTaskIntegration(repo, id, agentManager);
        updated = (await repo.getById(id)) ?? updated;
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
