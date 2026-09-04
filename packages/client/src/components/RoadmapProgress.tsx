import { useMemo } from 'react';
import { AlertTriangle, CheckCircle2, CircleDot, ClipboardList, Loader2, SkipForward } from 'lucide-react';
import type { Task, ColumnId } from '@/types';
import type { TaskGroupWithChildren } from '@/lib/api';
import { cn } from '@/lib/utils';

type RoadmapCard = {
  id: string;
  title: string;
  columnId: ColumnId;
  createdAt: number;
  running: boolean;
  blockedOrReview: boolean;
  eligible: boolean;
};

interface RoadmapProgressProps {
  tasks: Task[];
  groups: TaskGroupWithChildren[];
}

function cardOrder(card: RoadmapCard): number {
  const match = card.title.match(/^\s*(\d+)[.)]/);
  return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
}

function sortCards(a: RoadmapCard, b: RoadmapCard): number {
  const orderDelta = cardOrder(a) - cardOrder(b);
  if (orderDelta !== 0) return orderDelta;
  return a.createdAt - b.createdAt;
}

function emptyLabel(label: string) {
  return <span className="text-muted-foreground/70">{label}</span>;
}

export function RoadmapProgress({ tasks, groups }: RoadmapProgressProps) {
  const progress = useMemo(() => {
    const taskCards: RoadmapCard[] = tasks
      .filter((task) => !task.archived)
      .map((task) => ({
        id: task.id,
        title: task.title,
        columnId: task.columnId,
        createdAt: task.createdAt,
        running: task.agentStatus === 'planning' || task.agentStatus === 'executing',
        blockedOrReview: task.agentStatus === 'failed' || task.columnId === 'review',
        eligible: task.columnId === 'backlog' || (task.columnId === 'in-progress' && task.agentStatus === 'idle'),
      }));

    const groupCards: RoadmapCard[] = groups
      .filter((group) => !group.archived)
      .map((group) => {
        const hasRunningChild = group.children.some((child) => child.agentStatus === 'planning' || child.agentStatus === 'executing');
        const hasFailedChild = group.children.some((child) => child.agentStatus === 'failed');
        const hasIdleChild = group.children.some((child) => child.agentStatus === 'idle');
        return {
          id: group.id,
          title: group.title,
          columnId: group.columnId,
          createdAt: group.createdAt,
          running: hasRunningChild,
          blockedOrReview: hasFailedChild || group.columnId === 'review',
          eligible: group.columnId === 'backlog' || (group.columnId === 'in-progress' && hasIdleChild && !hasRunningChild),
        };
      });

    const cards = [...taskCards, ...groupCards].sort(sortCards);
    return {
      total: cards.length,
      completed: cards.filter((card) => card.columnId === 'done').length,
      running: cards.find((card) => card.running),
      blockedOrReview: cards.find((card) => card.blockedOrReview),
      nextEligible: cards.find((card) => card.eligible && !card.running && !card.blockedOrReview),
    };
  }, [tasks, groups]);

  const percent = progress.total > 0 ? Math.round((progress.completed / progress.total) * 100) : 0;

  return (
    <section
      aria-label="Roadmap progress"
      className="shrink-0 border-b border-border bg-background/95 px-3 py-3 max-lg:px-[max(0.75rem,env(safe-area-inset-left))] lg:px-6"
    >
      <div className="grid gap-3 lg:grid-cols-[minmax(13rem,18rem)_1fr] lg:items-center">
        <div className="min-w-0">
          <div className="mb-2 flex items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-2">
              <ClipboardList className="h-4 w-4 shrink-0 text-primary" />
              <h2 className="truncate text-sm font-semibold text-foreground">Roadmap Progress</h2>
            </div>
            <span className="text-xs tabular-nums text-muted-foreground">{percent}%</span>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-muted">
            <div
              className={cn(
                'h-full rounded-full transition-all duration-500',
                progress.completed === progress.total && progress.total > 0 ? 'bg-emerald-500' : 'bg-primary',
              )}
              style={{ width: `${percent}%` }}
            />
          </div>
        </div>

        <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-5">
          <div className="rounded-lg border border-border bg-card px-3 py-2">
            <div className="mb-1 flex items-center gap-1.5 text-[11px] font-medium uppercase text-muted-foreground">
              <CircleDot className="h-3.5 w-3.5" />
              Total Cards
            </div>
            <div aria-label="Total cards" className="text-lg font-semibold tabular-nums text-foreground">{progress.total}</div>
          </div>
          <div className="rounded-lg border border-border bg-card px-3 py-2">
            <div className="mb-1 flex items-center gap-1.5 text-[11px] font-medium uppercase text-muted-foreground">
              <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />
              Completed Cards
            </div>
            <div aria-label="Completed cards" className="text-lg font-semibold tabular-nums text-foreground">{progress.completed}</div>
          </div>
          <div className="rounded-lg border border-border bg-card px-3 py-2">
            <div className="mb-1 flex items-center gap-1.5 text-[11px] font-medium uppercase text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 text-blue-400" />
              Current Running
            </div>
            <div aria-label="Current running card" className="truncate text-sm font-medium text-foreground">
              {progress.running ? progress.running.title : emptyLabel('None')}
            </div>
          </div>
          <div className="rounded-lg border border-border bg-card px-3 py-2">
            <div className="mb-1 flex items-center gap-1.5 text-[11px] font-medium uppercase text-muted-foreground">
              <AlertTriangle className="h-3.5 w-3.5 text-amber-400" />
              Blocked/Review
            </div>
            <div aria-label="Blocked or review card" className="truncate text-sm font-medium text-foreground">
              {progress.blockedOrReview ? progress.blockedOrReview.title : emptyLabel('None')}
            </div>
          </div>
          <div className="rounded-lg border border-border bg-card px-3 py-2">
            <div className="mb-1 flex items-center gap-1.5 text-[11px] font-medium uppercase text-muted-foreground">
              <SkipForward className="h-3.5 w-3.5 text-primary" />
              Next Eligible
            </div>
            <div aria-label="Next eligible card" className="truncate text-sm font-medium text-foreground">
              {progress.nextEligible ? progress.nextEligible.title : emptyLabel('None')}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
