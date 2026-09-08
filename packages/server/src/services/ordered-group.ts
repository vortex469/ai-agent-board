import { getTaskDependencyGate, withDependencyAdmissionLock } from './task-dependencies.js';
import type { TaskGroupRepository } from '../repositories/group-types.js';
import type { ProjectRepository } from '../repositories/project-types.js';
import type { TaskRepository } from '../repositories/types.js';
import type { AgentManager } from './agent-manager.js';
import type { Task } from '../types.js';
import { broadcastGroupUpdate, startAgentForTask } from '../routes/helpers.js';

import { withOrderedGroupLock } from './group-lock.js';
export { withOrderedGroupLock } from './group-lock.js';

/** Read persisted order on every admission. Review, failure and unmet dependencies stop the sequence. */
export async function startOrderedGroupChild(
  groupId: string, groupRepo: TaskGroupRepository, taskRepo: TaskRepository,
  manager: AgentManager, continueAfterDone = false, projectRepo?: ProjectRepository, requestedTaskId?: string, automatic = false,
): Promise<Task | undefined> {
  return withOrderedGroupLock(groupId, async () => {
    const group = await groupRepo.getById(groupId);
    if (!group || group.archived || !group.roadmapExecutionMode) return undefined;
    const selectedCompletedAt = group.completedAt;
    if (automatic && (group.columnId !== 'in-progress' || group.completedAt !== undefined
      || !projectRepo || !(await projectRepo.getById(group.projectId))?.autoRunEnabled)) return undefined;
    const children = await groupRepo.getChildTasks(groupId);
    if (children.some(child => manager.isRunning(child.id) || child.agentStatus === 'planning' || child.agentStatus === 'executing')) return undefined;
    const child = children.find(task => task.columnId !== 'done' || task.agentStatus !== 'complete');
    if (!child) {
      const completed = await groupRepo.update(groupId, { columnId: 'done', completedAt: Date.now() });
      if (completed) broadcastGroupUpdate(completed);
      return undefined;
    }
    // Imported per-task Auto Run overrides are persisted as provenance, never source references.
    const persistedChild = await taskRepo.getById(child.id);
    if (!requestedTaskId && persistedChild?.runRequestedAt === undefined && persistedChild?.provenance?.origin?.roadmapAutoRun === false) return undefined;
    if (child.archived || (requestedTaskId && requestedTaskId !== child.id)) return undefined;
    if (requestedTaskId && (child.agentStatus === 'failed' || child.columnId === 'review')) {
      await withDependencyAdmissionLock(() => taskRepo.update(child.id, { agentStatus: 'idle', columnId: 'backlog' }));
      child.agentStatus = 'idle';
      child.columnId = 'backlog';
    }
    if (child.columnId !== 'backlog' || child.agentStatus !== 'idle') return undefined;
    if (!(await getTaskDependencyGate(taskRepo, child.id)).eligible) {
      if (group.columnId === 'in-progress' && child.runRequestedAt === undefined) await taskRepo.requestRun(child.id, Date.now());
      return undefined;
    }
    if (!manager.getAvailableAgents().some(agent => agent.name === child.agentType && agent.available)) return undefined;
    console.log(`[scheduler] eligible task selected: ${child.id} (group ${groupId})`);
    await taskRepo.requestRun(child.id, Date.now());
    await startAgentForTask(child, taskRepo, manager, projectRepo, async () => {
      const currentGroup = await groupRepo.getById(groupId);
      if (!currentGroup || currentGroup.archived || currentGroup.completedAt !== undefined) return;
      const currentChildren = await groupRepo.getChildTasks(groupId);
      if (currentChildren.every(task => task.columnId === 'done' && task.agentStatus === 'complete')) {
        const completed = await groupRepo.update(groupId, { columnId: 'done', completedAt: Date.now() });
        if (completed) broadcastGroupUpdate(completed);
      } else if (continueAfterDone && currentGroup.columnId === 'in-progress'
        && projectRepo && (await projectRepo.getById(currentGroup.projectId))?.autoRunEnabled) {
        // Status persistence and merge validation finish before admission of the next child.
        await startOrderedGroupChild(groupId, groupRepo, taskRepo, manager, true, projectRepo, undefined, true);
      }
    }, true, Boolean(requestedTaskId), automatic, async () => {
      const current = await groupRepo.getById(groupId);
      return !!current && !current.archived && current.completedAt === selectedCompletedAt;
    });
    return withDependencyAdmissionLock(async () => {
      const current = await groupRepo.getById(groupId);
      if (!current || current.archived || current.completedAt !== selectedCompletedAt) return undefined;
      const latest = await taskRepo.getById(child.id);
      if (latest?.agentStatus !== 'planning' && latest?.agentStatus !== 'executing') return undefined;
      const started = await groupRepo.update(groupId, { columnId: 'in-progress', startedAt: current.startedAt ?? Date.now(), completedAt: undefined });
      if (started) broadcastGroupUpdate(started);
      return latest;
    });
  });
}
