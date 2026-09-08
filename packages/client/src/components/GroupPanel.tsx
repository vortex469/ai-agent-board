import { DependencyEditor, DependencyStatus, useDependencies } from './TaskDependencies';
import { useMemo, useState } from 'react';
import { GroupChildActions } from './GroupChildActions';
import { motion, AnimatePresence } from 'framer-motion';
import {
  X, Layers, Play, Square,
  ChevronRight, ArrowUp, ArrowDown,
} from 'lucide-react';
import type { Task, AgentStatus } from '@/types';
import type { TaskGroupWithChildren } from '@/lib/api';
import { AGENT_DISPLAY } from '@/lib/agent-config';
import { computeGroupStatus, statusIcon } from '@/lib/group-utils';
import { cn, formatDuration } from '@/lib/utils';

interface GroupPanelProps {
  group: TaskGroupWithChildren | null;
  onClose: () => void;
  onRunGroup: (id: string) => void;
  onStopGroup: (id: string) => void;
  onRetryChild: (taskId: string) => void;
  onEditChild: (task: Task) => void;
  onResetChild: (task: Task) => void;
  onChildClick: (task: Task) => void;
  onReorderChildren: (groupId: string, orderedTaskIds: string[]) => Promise<unknown>;
}

function statusLabel(status: AgentStatus): string {
  switch (status) {
    case 'executing': return 'Running';
    case 'planning': return 'Planning';
    case 'complete': return 'Complete';
    case 'failed': return 'Failed';
    default: return 'Pending';
  }
}

export function GroupPanel({ group, onClose, onRunGroup, onStopGroup, onRetryChild, onEditChild, onResetChild, onChildClick, onReorderChildren }: GroupPanelProps) {
  const { gates } = useDependencies();
  const status = useMemo(() => group ? computeGroupStatus(group.children) : null, [group]);
  const [reordering, setReordering] = useState(false);
  const [reorderError, setReorderError] = useState('');

  if (!group || !status) return null;

  const isRunning = status.executing > 0 || status.planning > 0;
  const pct = status.total > 0 ? (status.completed / status.total) * 100 : 0;
  const elapsed = group.startedAt ? Date.now() - group.startedAt : 0;
  const backlog = group.children.filter((child) => child.columnId === 'backlog' && !child.archived);
  const moveChild = async (childId: string, direction: number) => {
    const ids = backlog.map((child) => child.id);
    const index = ids.indexOf(childId);
    const target = index + direction;
    if (reordering || index < 0 || target < 0 || target >= ids.length) return;
    [ids[index], ids[target]] = [ids[target], ids[index]];
    setReordering(true);
    setReorderError('');
    try {
      await onReorderChildren(group.id, ids);
    } catch (err) {
      setReorderError(err instanceof Error ? err.message : 'Failed to reorder children');
    } finally {
      setReordering(false);
    }
  };

  return (
    <AnimatePresence>
      <motion.div
        key="group-panel"
        initial={{ x: '100%' }}
        animate={{ x: 0 }}
        exit={{ x: '100%' }}
        transition={{ type: 'spring', damping: 25, stiffness: 200 }}
        className="fixed inset-0 z-[60] flex w-full flex-col bg-zinc-900 shadow-2xl pt-[env(safe-area-inset-top)] pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)] pb-[env(safe-area-inset-bottom)] lg:inset-auto lg:right-0 lg:top-0 lg:h-full lg:max-w-md lg:border-l lg:border-zinc-700"
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-zinc-700 px-4 py-3">
          <div className="flex items-center gap-2 min-w-0">
            <Layers className="h-5 w-5 shrink-0 text-blue-400" />
            <h2 className="truncate text-sm font-semibold text-zinc-100">{group.title}</h2>
          </div>
          <div className="flex items-center gap-2">
            {!isRunning && status.idle > 0 && (
              <button
                onClick={() => onRunGroup(group.id)}
                className="flex min-h-11 items-center gap-1 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-500 lg:min-h-0"
              >
                <Play className="h-3 w-3" /> Run
              </button>
            )}
            {isRunning && (
              <button
                onClick={() => onStopGroup(group.id)}
                className="flex min-h-11 items-center gap-1 rounded-lg bg-red-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-500 lg:min-h-0"
              >
                <Square className="h-3 w-3" /> Stop All
              </button>
            )}
            <button onClick={onClose} className="flex h-11 w-11 items-center justify-center rounded-lg text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200 lg:h-auto lg:w-auto lg:p-1">
              <X className="h-5 w-5" />
            </button>
          </div>
        </div>

        {/* Progress summary */}
        <div className="border-b border-zinc-700/50 px-4 py-3">
          <div className="flex items-center justify-between text-xs text-zinc-400 mb-1.5">
            <span>{status.completed}/{status.total} complete</span>
            {isRunning && elapsed > 0 && (
              <span className="text-blue-400">⏱ {formatDuration(elapsed)}</span>
            )}
          </div>
          <div className="h-2 w-full overflow-hidden rounded-full bg-zinc-700">
            <div
              className={cn(
                'h-full rounded-full transition-all duration-500',
                status.failed > 0 && status.completed === 0 ? 'bg-red-500' :
                status.completed === status.total ? 'bg-emerald-500' : 'bg-blue-500',
              )}
              style={{ width: `${pct}%` }}
            />
          </div>
          <div className="mt-2 flex flex-wrap gap-3 text-xs text-zinc-500">
            {status.executing > 0 && <span className="text-blue-400">⚡ {status.executing} running</span>}
            {status.planning > 0 && <span className="text-purple-400">🧠 {status.planning} planning</span>}
            {status.completed > 0 && <span className="text-emerald-400">✓ {status.completed} done</span>}
            {status.failed > 0 && <span className="text-red-400">✕ {status.failed} failed</span>}
            {status.idle > 0 && <span>{status.idle} pending</span>}
          </div>
          {!isRunning && status.idle > 0 && group.children.filter(child => child.agentStatus === 'idle' && !child.archived).every(child => gates[child.id]?.eligible === false) && <p role="status" className="mt-2 text-xs text-violet-300">Waiting for dependency synchronization</p>}
          {group.description && (
            <p className="mt-2 text-xs text-zinc-500">{group.description}</p>
          )}
        </div>

        {/* Child task list */}
        {reorderError && <p role="alert" className="px-4 py-2 text-sm text-red-400">{reorderError}</p>}
        <div className="flex-1 overflow-y-auto">
          {group.children.map((child, idx) => {
            const agentDisplay = AGENT_DISPLAY[child.agentType as keyof typeof AGENT_DISPLAY];
            const duration = child.completedAt && child.startedAt
              ? formatDuration(child.completedAt - child.startedAt) : null;
            const elapsed = child.startedAt && !child.completedAt
              ? formatDuration(Date.now() - child.startedAt) : null;

            return (
              <div
                key={child.id}
                data-testid="group-child"
                className={cn(
                  'flex flex-wrap items-center gap-3 border-b border-zinc-800 px-4 py-3 cursor-pointer hover:bg-zinc-800/50 transition-colors',
                  child.agentStatus === 'executing' && 'bg-blue-500/5',
                  child.agentStatus === 'failed' && 'bg-red-500/5',
                )}
                onClick={() => onChildClick(child)}
              >
                {/* Order number */}
                <span className="text-xs font-medium text-zinc-600 w-4 text-right">{idx + 1}</span>

                {/* Status icon */}
                {statusIcon(child.agentStatus)}

                {/* Content */}
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <button type="button" aria-label={`Open ${child.title}`} className="truncate text-left text-sm text-zinc-200">{child.title}</button>
                  </div>
                  <div className="flex items-center gap-2 mt-0.5 text-xs text-zinc-500">
                    <span>{agentDisplay?.emoji} {agentDisplay?.label}</span>
                    <span>· {statusLabel(child.agentStatus)}</span>
                    {duration && <span>· {duration}</span>}
                    {elapsed && <span className="text-blue-400">· {elapsed}</span>}
                  </div>
                </div>

                {/* Actions */}
                <div className="flex items-center gap-1">
                  {group.roadmapExecutionMode && backlog.some((task) => task.id === child.id) && ([-1, 1] as const).map((direction) => (
                    <button
                      key={direction}
                      aria-label={`Move ${child.title} ${direction < 0 ? 'up' : 'down'}`}
                      disabled={reordering || backlog.findIndex((task) => task.id === child.id) + direction < 0 || backlog.findIndex((task) => task.id === child.id) + direction >= backlog.length}
                      onClick={(event) => { event.stopPropagation(); void moveChild(child.id, direction); }}
                      className="flex h-11 w-11 shrink-0 items-center justify-center rounded text-zinc-400 hover:bg-zinc-700 disabled:opacity-30 lg:h-8 lg:w-8"
                    >
                      {direction < 0 ? <ArrowUp className="h-4 w-4" /> : <ArrowDown className="h-4 w-4" />}
                    </button>
                  ))}
                  <GroupChildActions task={child} onEdit={onEditChild}
                    onRetry={(task) => onRetryChild(task.id)} onReset={onResetChild} />
                  <ChevronRight className="h-4 w-4 text-zinc-600" />
                </div>
                <div className="w-full min-w-0">
                  <DependencyStatus task={child} gate={gates[child.id]} />
                  <DependencyEditor task={child} />
                </div>
              </div>
            );
          })}
        </div>

        {/* Footer info */}
        <div className="border-t border-zinc-700 px-4 py-2 text-xs text-zinc-500">
          {group.repoPath && <span>📁 {group.repoPath}</span>}
          {group.baseBranch && <span> · 🌿 {group.baseBranch}</span>}
          <span> · Concurrency: {group.maxConcurrency}</span>
        </div>
      </motion.div>
    </AnimatePresence>
  );
}
