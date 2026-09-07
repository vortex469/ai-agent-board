import { useState, useCallback, useEffect, useMemo } from 'react';
import type { Task, TaskGroup, ReconfigureTaskGroupInput } from '@/types';
import { api, connectWS } from '@/lib/api';
import { createTaskUpdateTracker } from '@/lib/task-update-tracker';
import type { TaskGroupWithChildren, CreateGroupChild } from '@/lib/api';
import type { Priority, RoadmapExecutionMode } from '@/types';

const getProjectId = (value: { projectId?: string }) => value.projectId ?? 'default';

export function useTaskGroups(projectId = 'default') {
  const [groups, setGroups] = useState<TaskGroupWithChildren[]>([]);
  const [error, setError] = useState<string | null>(null);

  // REST responses must update children too: recovery cannot depend on a
  // WebSocket broadcast arriving before the user retries with a new agent.
  const updateChild = useCallback((child: Task) => {
    if (!child.groupId || getProjectId(child) !== projectId) return;
    setGroups((prev) => prev.map((group) => group.id !== child.groupId ? group : {
      ...group,
      children: group.children.map((task) => task.id === child.id ? child : task)
        .sort((a, b) => (a.groupOrder ?? 0) - (b.groupOrder ?? 0)),
    }));
  }, [projectId]);

  const childUpdates = useMemo(() => createTaskUpdateTracker(updateChild), [updateChild]);

  // Fetch groups on mount
  useEffect(() => {
    api.getGroups(false, projectId).then(setGroups).catch((err) => {
      setError(`Failed to load groups: ${err.message}`);
    });
  }, [projectId]);

  // WebSocket: live group updates
  useEffect(() => {
    return connectWS(
      (msg) => {
        if (msg.type === 'group_updated') {
          if (getProjectId(msg.payload) !== projectId) return;
          setGroups((prev) => {
            const exists = prev.some((g) => g.id === msg.payload.id);
            if (exists) {
              return prev.map((g) => (g.id === msg.payload.id ? { ...g, ...msg.payload } : g));
            }
            // New group — fetch full details (with children)
            api.getGroup(msg.payload.id).then((full) => {
              if (getProjectId(full) !== projectId) return;
              setGroups((p) => {
                const alreadyExists = p.some((g) => g.id === full.id);
                return alreadyExists ? p.map((g) => (g.id === full.id ? full : g)) : [...p, full];
              });
            }).catch(console.error);
            return prev;
          });
        }
        // Update child task within its parent group
        if (msg.type === 'task_updated' && msg.payload.groupId) {
          childUpdates.receive(msg.payload);
        }
      },
      () => { api.getGroups(false, projectId).then(setGroups).catch(console.error); },
    );
  }, [projectId, childUpdates]);

  // Refetch a single group's children (for status updates)
  const refreshGroup = useCallback(async (groupId: string) => {
    try {
      const full = await api.getGroup(groupId);
      setGroups((prev) => prev.map((g) => (g.id === groupId ? full : g)));
    } catch (err: unknown) {
      console.error('Failed to refresh group:', err);
    }
  }, []);

  const createGroup = useCallback(async (data: {
    title: string;
    description?: string;
    priority?: Priority;
    repoPath?: string;
    baseBranch?: string;
    maxConcurrency: number;
    children: CreateGroupChild[];
    roadmapExecutionMode?: RoadmapExecutionMode;
    autoRun?: boolean;
    projectId?: string;
  }) => {
    try {
      setError(null);
      const result = await api.createGroup({ ...data, projectId: data.projectId ?? projectId });
      setGroups((prev) => {
        const exists = prev.some((g) => g.id === result.id);
        return exists ? prev.map((g) => (g.id === result.id ? result : g)) : [...prev, result];
      });
      return result;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to create group';
      setError(msg);
      return undefined;
    }
  }, [projectId]);

  const runGroup = useCallback(async (id: string) => {
    try {
      setError(null);
      const result = await api.runGroup(id);
      setGroups((prev) => prev.map((g) => (g.id === id ? result : g)));
      return result;
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to run group');
      return undefined;
    }
  }, []);

  const stopGroup = useCallback(async (id: string) => {
    try {
      setError(null);
      await api.stopGroup(id);
      await refreshGroup(id);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to stop group');
    }
  }, [refreshGroup]);

  const deleteGroup = useCallback(async (id: string) => {
    try {
      setError(null);
      await api.deleteGroup(id);
      setGroups((prev) => prev.filter((g) => g.id !== id));
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to delete group');
    }
  }, []);

  const updateGroup = useCallback(async (id: string, updates: Partial<TaskGroup>) => {
    try {
      setError(null);
      const result = await api.updateGroup(id, updates);
      setGroups((prev) => prev.map((g) => (g.id === id ? result : g)));
      return result;
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to update group');
      return undefined;
    }
  }, []);

  const reorderGroupChildren = useCallback(async (id: string, orderedTaskIds: string[]) => {
    const result = await api.reorderGroupChildren(id, orderedTaskIds);
    setGroups((prev) => prev.map((group) => group.id === id ? result : group));
    return result;
  }, []);

  const reconfigureGroup = useCallback(async (id: string, updates: ReconfigureTaskGroupInput) => {
    const result = await api.reconfigureGroup(id, updates);
    setGroups((prev) => prev.map((group) => group.id === id ? result : group));
    return result;
  }, []);

  return {
    groups,
    error,
    createGroup,
    runGroup,
    stopGroup,
    deleteGroup,
    updateGroup,
    refreshGroup,
    trackChildMutation: childUpdates.start,
    reorderGroupChildren,
    reconfigureGroup,
  };
}
