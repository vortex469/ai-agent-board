import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import type { Task } from '@/types';
import { api, connectWS, type TaskGroupWithChildren } from '@/lib/api';
import type { TaskDependencyGate } from '../../../../shared/types';

type DependencyContextValue = {
  gates: Record<string, TaskDependencyGate>;
  tasks: Task[];
  groups: TaskGroupWithChildren[];
  refresh: () => Promise<void>;
};
const DependencyContext = createContext<DependencyContextValue>({ gates: {}, tasks: [], groups: [], refresh: async () => {} });
export const useDependencies = () => useContext(DependencyContext);

export function DependencyProvider({ tasks, groups, children }: { tasks: Task[]; groups: TaskGroupWithChildren[]; children: ReactNode }) {
  const allTasks = [...tasks, ...groups.flatMap(group => group.children)];
  const ids = [...new Set(allTasks.map(task => task.id))].sort().join(',');
  const [gates, setGates] = useState<Record<string, TaskDependencyGate>>({});
  const generation = useRef(0);
  const refresh = useCallback(async () => {
    const current = ++generation.current;
    const results = await Promise.all(ids.split(',').filter(Boolean).map(async id => {
      try { return [id, await api.getTaskDependencies(id)] as const; }
      catch { return [id, { eligible: false, reason: 'Dependency status unavailable', dependencies: [] }] as const; }
    }));
    if (current === generation.current) setGates(Object.fromEntries(results));
  }, [ids]);
  useEffect(() => {
    void refresh();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = connectWS(message => {
      if (['task_updated', 'task_deleted', 'group_updated', 'group_deleted'].includes(message.type)) {
        // Invalidate immediately; coalesce the authoritative refresh after event bursts.
        ++generation.current;
        setGates({});
        clearTimeout(timer);
        timer = setTimeout(() => { void refresh(); }, 100);
      }
    }, () => { void refresh(); });
    return () => { ++generation.current; clearTimeout(timer); unsubscribe(); };
  }, [refresh]);
  return <DependencyContext.Provider value={{ gates, tasks: allTasks, groups, refresh }}>{children}</DependencyContext.Provider>;
}

export function wouldCreateDependencyCycle(taskId: string, prerequisiteId: string, gates: Record<string, TaskDependencyGate>): boolean {
  const pending = [prerequisiteId];
  const visited = new Set<string>();
  while (pending.length) {
    const id = pending.pop()!;
    if (id === taskId) return true;
    if (visited.has(id)) continue;
    visited.add(id);
    for (const dependency of gates[id]?.dependencies ?? []) pending.push(dependency.taskId);
  }
  return false;
}

export function dependencyCandidates(task: Task, tasks: Task[], gates: Record<string, TaskDependencyGate>): Task[] {
  const selected = new Set(gates[task.id]?.dependencies.map(dependency => dependency.taskId));
  return tasks.filter(candidate => candidate.projectId === task.projectId && candidate.groupId && !candidate.archived && !selected.has(candidate.id) && !wouldCreateDependencyCycle(task.id, candidate.id, gates));
}

export function DependencyStatus({ task, gate }: { task: Task; gate?: TaskDependencyGate }) {
  if (!gate) return null;
  const running = task.agentStatus === 'planning' || task.agentStatus === 'executing';
  return <div className="mt-1 space-y-1 text-xs break-words" data-testid="dependency-status">
    {gate.dependencies.length > 0 && <p className="text-zinc-400">Depends on:</p>}
    {gate.dependencies.map(dependency => {
      const external = dependency.groupId !== task.groupId;
      return <p key={dependency.taskId} className={external ? 'text-violet-300' : 'text-zinc-400'}>
        {external ? '⇄ Synchronization gate: ' : '↳ '}
        {dependency.groupTitle ? `${dependency.groupTitle} / ` : ''}{dependency.title ?? dependency.taskId}
        {' — '}{dependency.status}{dependency.reason ? `: ${dependency.reason}` : ''}
      </p>;
    })}
    {!gate.eligible && <p role={running ? 'alert' : 'status'} className="text-amber-300">
      {running ? 'Dependency changed during execution: ' : 'Waiting for: '}
      {gate.reason || gate.dependencies.filter(dependency => dependency.status !== 'Done').map(dependency => `${dependency.groupTitle ? `${dependency.groupTitle} / ` : ''}${dependency.title ?? dependency.taskId}`).join(', ')}
    </p>}
  </div>;
}

export function DependencyEditor({ task }: { task: Task }) {
  const { tasks, groups, gates, refresh } = useDependencies();
  const gate = gates[task.id];
  const [expanded, setExpanded] = useState(false);
  const [selectedId, setSelectedId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const locked = busy || task.archived || task.agentStatus === 'planning' || task.agentStatus === 'executing' || !!task.runClaimedAt;
  const candidates = dependencyCandidates(task, tasks, gates);
  const mutate = async (id: string, remove: boolean) => {
    setBusy(true); setError('');
    try {
      if (remove) await api.removeTaskDependency(task.id, id);
      else await api.addTaskDependency(task.id, id);
      setSelectedId('');
      await refresh();
    } catch (err) { setError(err instanceof Error ? err.message : 'Failed to update dependencies'); }
    finally { setBusy(false); }
  };
  return <details className="mt-2 w-full min-w-0" onToggle={event => setExpanded(event.currentTarget.open)} onClick={event => event.stopPropagation()}>
    <summary className="min-h-11 cursor-pointer py-3 text-xs text-violet-300">Edit dependencies</summary>
    {expanded && <div className="space-y-2 pb-2">
      {!gate && <p role="status" className="text-xs text-zinc-400">Loading dependency status…</p>}
      <label className="block text-xs text-zinc-400">Prerequisite task
        <select aria-label={`Dependency for ${task.title}`} value={selectedId} onChange={event => setSelectedId(event.target.value)} disabled={locked || !gate}
          className="mt-1 min-h-11 w-full min-w-0 rounded border border-zinc-600 bg-zinc-900 px-2 text-zinc-200">
          <option value="">Select a task</option>
          {groups.filter(group => group.projectId === task.projectId).map(group => <optgroup key={group.id} label={`${group.id === task.groupId ? 'Current group: ' : 'Synchronization: '}${group.title}`}>
            {candidates.filter(candidate => candidate.groupId === group.id).map(candidate => <option key={candidate.id} value={candidate.id}>{candidate.title}</option>)}
          </optgroup>)}
        </select>
      </label>
      <button type="button" disabled={locked || !gate || !candidates.some(candidate => candidate.id === selectedId)} onClick={() => { void mutate(selectedId, false); }} className="min-h-11 rounded bg-violet-800 px-3 text-xs text-white disabled:opacity-40">Add dependency</button>
      {gate?.dependencies.map(dependency => <div key={dependency.taskId} className="flex flex-wrap items-center gap-2 text-xs text-zinc-300">
        <span className="min-w-0 flex-1 break-words">{dependency.groupTitle ? `${dependency.groupTitle} / ` : ''}{dependency.title ?? dependency.taskId}</span>
        <button type="button" disabled={locked} aria-label={`Remove dependency ${dependency.title ?? dependency.taskId}`} onClick={() => { void mutate(dependency.taskId, true); }} className="min-h-11 rounded px-2 text-red-300 disabled:opacity-40">Remove</button>
      </div>)}
      {error && <p role="alert" className="text-xs text-red-300">{error}</p>}
    </div>}
  </details>;
}
