import { startNextEligibleProjectAutoRunTask } from '../routes/helpers.js';
import type { TaskRepository } from '../repositories/types.js';
import type { TaskGroupRepository } from '../repositories/group-types.js';
import type { ProjectRepository } from '../repositories/project-types.js';
import type { AgentManager } from './agent-manager.js';
import { startOrderedGroupChild } from './ordered-group.js';
import { observeBroadcasts } from '../websocket.js';
import { getTaskDependencyGate } from './task-dependencies.js';

/** Coalesce persisted lifecycle notifications. Never depend on a browser to resume gates. */
export function installDependencyScheduler(tasks: TaskRepository, groups: TaskGroupRepository,
  projects: ProjectRepository, manager: AgentManager): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = false;
  let dirty = false;
  let disposed = false;
  const waiting = new Set<string>();
  const schedule = (reason = 'lifecycle update') => {
    if (disposed) return;
    if (!dirty) console.log(`[scheduler] reevaluation requested: ${reason}`);
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
          if (disposed) return;
          if (group.columnId !== 'in-progress' || group.archived || group.completedAt !== undefined || !group.roadmapExecutionMode) continue;
          try {
            const children = await groups.getChildTasks(group.id);
            const next = children.find(task => task.columnId !== 'done' || task.agentStatus !== 'complete');
            // The active group is the persisted run intent. Import mode only controls
            // initial admission; it must not strand successors after a manual merge.
            if (next?.columnId === 'backlog' && next.agentStatus === 'idle') {
              const gate = await getTaskDependencyGate(tasks, next.id);
              if (!gate.eligible) waiting.add(next.id);
              else if (waiting.delete(next.id)) console.log(`[scheduler] dependency became satisfied: ${next.id}`);
            }
            await startOrderedGroupChild(group.id, groups, tasks, manager, true, projects, undefined, true);
          } catch (error) {
            // One damaged repository must not starve independent groups.
            console.error(`[scheduler] group ${group.id} reevaluation failed:`, error);
          }
        }
        await startNextEligibleProjectAutoRunTask(tasks, projects, project.id, manager, true);
      }
    } catch (error) { console.error('[dependencies] reevaluation failed:', error); }
    finally { running = false; if (dirty) schedule(); }
  };
  const unsubscribe = observeBroadcasts(message => {
    if (['task_updated', 'task_deleted', 'group_updated', 'group_deleted', 'project_updated', 'agent_complete'].includes(message.type)) schedule(message.type);
  });
  schedule();
  return () => { disposed = true; unsubscribe(); if (timer) clearTimeout(timer); };
}
