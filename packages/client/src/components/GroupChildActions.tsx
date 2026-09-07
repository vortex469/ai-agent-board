import { Pencil, RotateCcw, Undo2 } from 'lucide-react';
import type { Task } from '@/types';

interface GroupChildActionsProps {
  task: Task;
  onEdit?: (task: Task) => void;
  onRetry?: (task: Task) => void;
  onReset?: (task: Task) => void;
}

export function GroupChildActions({ task, onEdit, onRetry, onReset }: GroupChildActionsProps) {
  const active = task.agentStatus === 'planning' || task.agentStatus === 'executing';
  if (task.archived) return null;
  const actions = [
    { label: 'Edit task', Icon: Pencil, callback: onEdit, visible: true },
    { label: 'Retry task', Icon: RotateCcw, callback: onRetry, visible: task.agentStatus === 'failed' },
    { label: 'Reset task', Icon: Undo2, callback: onReset, visible: task.agentStatus === 'failed' },
  ];
  return (
    <div className="flex shrink-0 items-center" onClick={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.stopPropagation()}
      onTouchStart={(event) => event.stopPropagation()}>
      {actions.map(({ label, Icon, callback, visible }) => callback && visible && (
        <button key={label} type="button" aria-label={label} title={label} disabled={active}
          onClick={() => callback(task)}
          className="flex h-11 w-11 items-center justify-center rounded text-zinc-400 hover:bg-zinc-700 hover:text-amber-400 disabled:opacity-40 lg:h-7 lg:w-7">
          <Icon className="h-3.5 w-3.5" />
        </button>
      ))}
    </div>
  );
}
