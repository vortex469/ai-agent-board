import { withDependencyAdmissionLock } from './task-dependencies.js';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Project, Task, TaskGroup } from '../types.js';
import type { TaskGroupRepository } from '../repositories/group-types.js';
import type { TaskRepository } from '../repositories/types.js';
import { expandTilde, isAllowedRepoPath, isValidGitRef, normalizeRepoPathForCompare } from '../routes/helpers.js';
import { validateRoadmapGroups } from './multi-roadmap.js';

let importTail: Promise<unknown> = Promise.resolve();
export function importRoadmap(project: Project, input: unknown, groups: TaskGroupRepository, tasks: TaskRepository) {
  const run = importTail.then(() => withDependencyAdmissionLock(() => persistRoadmap(project, input, groups, tasks)));
  importTail = run.catch(() => undefined);
  return run;
}
export class RoadmapValidationError extends Error {}

async function persistRoadmap(project: Project, input: unknown, groupRepo: TaskGroupRepository, taskRepo: TaskRepository) {
  const parsed = validateRoadmapGroups(input);
  if (typeof parsed === 'string') throw new RoadmapValidationError(parsed);
  const existing = await groupRepo.getAll(true, project.id);
  for (const group of parsed.groups) {
    if (existing.some(g => g.title.trim().toLowerCase() === group.title.trim().toLowerCase())) throw new RoadmapValidationError(`Group already exists: ${group.title}`);
    for (const item of [group, ...group.tasks]) {
      if (item.repoPath !== undefined || project.repoPath) {
        const repo = expandTilde(item.repoPath ?? group.repoPath ?? project.repoPath!);
        if (!path.isAbsolute(repo)) throw new RoadmapValidationError('repoPath must be absolute');
        const error = isAllowedRepoPath(repo);
        if (error) throw new RoadmapValidationError(error);
        if (project.repoPath && normalizeRepoPathForCompare(repo) !== normalizeRepoPathForCompare(project.repoPath)) throw new RoadmapValidationError('repoPath must match the selected project');
      }
      for (const branch of [item.baseBranch, 'branchName' in item ? item.branchName : undefined]) if (branch !== undefined && (typeof branch !== 'string' || !isValidGitRef(branch))) throw new RoadmapValidationError('Invalid branch reference');
    }
  }
  const created: (TaskGroup & { children: Task[] })[] = [];
  const attempted: string[] = [];
  const allTasks: Task[] = [];
  try {
    // Stage inert ordered groups. No scheduler can admit children until every edge is persisted.
    for (const proposed of parsed.groups) {
      const id = randomUUID(); attempted.push(id);
      const group: TaskGroup = {
        id, projectId: project.id, title: proposed.title.trim(), priority: proposed.priority ?? project.defaultPriority ?? 'medium',
        columnId: 'backlog', roadmapExecutionMode: 'backlog', maxConcurrency: 1, createdAt: Date.now(),
        repoPath: proposed.repoPath ? expandTilde(proposed.repoPath) : project.repoPath,
        baseBranch: proposed.baseBranch ?? project.defaultBaseBranch,
      };
      const children = proposed.tasks.map((task, index) => ({
        id: randomUUID(), projectId: project.id, title: task.title.trim(), description: task.description,
        priority: task.priority ?? group.priority, agentType: task.agentType ?? proposed.agentType ?? project.defaultAgentType ?? 'copilot',
        useWorktree: task.useWorktree ?? proposed.useWorktree ?? project.defaultUseWorktree ?? true,
        branchName: task.branchName ?? `group/${id.slice(0, 8)}/${index}-${randomUUID().slice(0, 8)}`,
        groupId: id, groupOrder: index,
      }));
      const result = await groupRepo.create(group, children);
      // Group repositories intentionally inherit repo/branch; apply supported per-task overrides through TaskRepository.
      for (const [index, child] of result.children.entries()) {
        const proposal = proposed.tasks[index];
        const updated = await taskRepo.update(child.id, {
          repoPath: proposal.repoPath ? expandTilde(proposal.repoPath) : group.repoPath,
          baseBranch: proposal.baseBranch ?? group.baseBranch,
          provenance: { origin: { roadmapAutoRun: proposal.autoRun ?? proposed.autoRun ?? false } },
        });
        if (!updated) throw new Error(`Task disappeared during import: ${child.id}`);
        result.children[index] = updated;
      }
      created.push({ ...result.group, children: result.children }); allTasks.push(...result.children);
    }
    for (const [from, to] of parsed.edges) await taskRepo.createDependency(allTasks[from].id, allTasks[to].id, Date.now());
    // Arm only after all stable IDs and dependency links exist.
    for (const [index, group] of created.entries()) {
      const proposed = parsed.groups[index];
      const enabled = proposed.tasks.some(task => task.autoRun ?? proposed.autoRun ?? false);
      const updated = await groupRepo.update(group.id, { roadmapExecutionMode: enabled ? 'full-roadmap' : 'backlog', columnId: enabled ? 'in-progress' : 'backlog' });
      if (!updated) throw new Error(`Group disappeared during import: ${group.id}`);
      Object.assign(group, updated);
    }
  } catch (error) {
    const incomplete: string[] = [];
    for (const id of attempted.reverse()) {
      try { await groupRepo.delete(id); if (await groupRepo.getById(id)) incomplete.push(id); }
      catch { incomplete.push(id); }
    }
    if (incomplete.length) throw new Error(`Roadmap import failed; rollback incomplete for group IDs ${incomplete.join(', ')}. Manual cleanup required. Cause: ${String(error)}`);
    throw new Error(`Roadmap import failed; all created groups rolled back. ${String(error)}`);
  }
  return { groups: created, tasks: allTasks };
}
