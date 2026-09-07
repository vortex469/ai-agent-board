import type { TaskGroupRepository } from '../repositories/group-types.js';
import type { ProjectRepository } from '../repositories/project-types.js';
import type { TaskRepository } from '../repositories/types.js';
import type { AgentManager } from './agent-manager.js';
import type { Task } from '../types.js';
import { broadcastGroupUpdate, startAgentForTask } from '../routes/helpers.js';

const locks = new Map<string, Promise<unknown>>();
export async function withOrderedGroupLock<T>(id: string, action: () => Promise<T>): Promise<T> {
  const previous = locks.get(id) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(action);
  locks.set(id, next);
  try { return await next; } finally { if (locks.get(id) === next) locks.delete(id); }
}

/** Read persisted order on every admission. Review, failure and unmet dependencies stop the sequence. */
export async function startOrderedGroupChild(
  groupId: string, groupRepo: TaskGroupRepository, taskRepo: TaskRepository,
  manager: AgentManager, continueAfterDone = false, projectRepo?: ProjectRepository,
): Promise<Task | undefined> {
  return withOrderedGroupLock(groupId, async () => {
    const group = await groupRepo.getById(groupId);
    if (!group || group.archived || !group.roadmapExecutionMode) return undefined;
    const children = await groupRepo.getChildTasks(groupId);
    if (children.some(child => manager.isRunning(child.id) || child.agentStatus === 'planning' || child.agentStatus === 'executing')) return undefined;
    const child = children.find(task => task.columnId !== 'done' || task.agentStatus === 'failed');
    if (!child) {
      const completed = await groupRepo.update(groupId, { columnId: 'done', completedAt: Date.now() });
      if (completed) broadcastGroupUpdate(completed);
      return undefined;
    }
    if (child.archived || child.columnId !== 'backlog' || child.agentStatus !== 'idle') return undefined;
    for (const relationship of await taskRepo.getRelationships(child.id)) {
      if (relationship.type !== 'blocks' || relationship.direction !== 'blocked-by') continue;
      const prerequisite = await taskRepo.getById(relationship.relatedTaskId);
      if (!prerequisite || prerequisite.columnId !== 'done' || prerequisite.agentStatus === 'failed') return undefined;
    }
    if (!manager.getAvailableAgents().some(agent => agent.name === child.agentType && agent.available)) return undefined;
    await taskRepo.requestRun(child.id, Date.now());
    await startAgentForTask(child, taskRepo, manager, projectRepo, async () => {
      const currentGroup = await groupRepo.getById(groupId);
      if (!currentGroup || currentGroup.archived || currentGroup.completedAt !== undefined) return;
      const currentChildren = await groupRepo.getChildTasks(groupId);
      if (currentChildren.every(task => task.columnId === 'done' && task.agentStatus !== 'failed')) {
        const completed = await groupRepo.update(groupId, { columnId: 'done', completedAt: Date.now() });
        if (completed) broadcastGroupUpdate(completed);
      } else if (continueAfterDone && currentGroup.columnId === 'in-progress'
        && projectRepo && (await projectRepo.getById(currentGroup.projectId))?.autoRunEnabled) {
        // Status persistence and merge validation finish before admission of the next child.
        await startOrderedGroupChild(groupId, groupRepo, taskRepo, manager, true, projectRepo);
      }
    });
    const latest = await taskRepo.getById(child.id);
    if (latest?.agentStatus !== 'planning' && latest?.agentStatus !== 'executing') return undefined;
    const started = await groupRepo.update(groupId, { columnId: 'in-progress', startedAt: group.startedAt ?? Date.now(), completedAt: undefined });
    if (started) broadcastGroupUpdate(started);
    return latest;
  });
}
