import { startNextEligibleProjectAutoRunTask } from '../routes/helpers.js';
import type { TaskRepository } from '../repositories/types.js';
import type { TaskGroupRepository } from '../repositories/group-types.js';
import type { ProjectRepository } from '../repositories/project-types.js';
import type { AgentManager } from './agent-manager.js';
import { startOrderedGroupChild } from './ordered-group.js';
import { observeBroadcasts } from '../websocket.js';

/** Coalesce persisted lifecycle notifications. Never depend on a browser to resume gates. */
export function installDependencyScheduler(tasks: TaskRepository, groups: TaskGroupRepository,
  projects: ProjectRepository, manager: AgentManager): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = false;
  let dirty = false;
  let disposed = false;
  const schedule = () => {
    dirty = true;
    if (timer || running || disposed) return;
    timer = setTimeout(() => { timer = undefined; void drain(); }, 0);
    timer.unref();
  };
  const drain = async () => {
    running = true;
    dirty = false;
    try {
      manager.reevaluateGroupQueues();
      for (const project of await projects.getAllWithCounts()) {
        if (!project.autoRunEnabled) continue;
        for (const group of await groups.getAll(false, project.id)) {
          if (group.columnId !== 'in-progress' || group.archived || !group.roadmapExecutionMode) continue;
          if (group.roadmapExecutionMode !== 'full-roadmap') {
            const next = (await groups.getChildTasks(group.id)).find(task => task.columnId !== 'done' || task.agentStatus !== 'complete');
            if (next?.runRequestedAt === undefined) continue;
          }
          await startOrderedGroupChild(group.id, groups, tasks, manager, group.roadmapExecutionMode === 'full-roadmap', projects);
        }
        await startNextEligibleProjectAutoRunTask(tasks, projects, project.id, manager, true);
      }
    } catch (error) { console.error('[dependencies] reevaluation failed:', error); }
    finally { running = false; if (dirty) schedule(); }
  };
  const unsubscribe = observeBroadcasts(message => {
    if (['task_updated', 'task_deleted', 'group_updated', 'group_deleted', 'project_updated'].includes(message.type)) schedule();
  });
  schedule();
  return () => { disposed = true; unsubscribe(); if (timer) clearTimeout(timer); };
}
