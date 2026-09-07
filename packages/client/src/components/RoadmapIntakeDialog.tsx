import { useEffect, useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { ClipboardList, Loader2, Play, Trash2, X } from 'lucide-react';
import type { AgentInfo, AgentType, ColumnId, Priority, Project, RoadmapExecutionMode, RoadmapProposedTask } from '@/types';
import { api } from '@/lib/api';
import { AGENT_OPTIONS } from '@/lib/agent-config';
import { PRIORITY_OPTIONS } from '@/lib/priority-config';
import { slugify } from '@/lib/utils';
import { MAX_DESCRIPTION_LENGTH } from '@ai-agent-board/shared/constants.js';

interface RoadmapIntakeDialogProps {
  open: boolean;
  onClose: () => void;
  project: Project;
  onCreateTasks: (tasks: {
    title: string;
    description: string;
    priority: Priority;
    columnId: ColumnId;
    agentType: AgentType;
    autoRun?: boolean;
    repoPath?: string;
    branchName?: string;
    baseBranch?: string;
    useWorktree?: boolean;
    dependsOnTaskIndexes?: number[];
  }[]) => Promise<unknown>;
}

export function RoadmapIntakeDialog({ open, onClose, project, onCreateTasks }: RoadmapIntakeDialogProps) {
  const [text, setText] = useState('');
  const [preview, setPreview] = useState<RoadmapProposedTask[]>([]);
  const [error, setError] = useState('');
  const [executionMode, setExecutionMode] = useState<RoadmapExecutionMode>('backlog');
  const [agentType, setAgentType] = useState<AgentType>(project.defaultAgentType ?? 'codex');
  const [priority, setPriority] = useState<Priority>(project.defaultPriority ?? 'medium');
  const [submitting, setSubmitting] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [availableAgents, setAvailableAgents] = useState<AgentInfo[]>([]);

  const baseBranch = project.defaultBaseBranch || 'main';
  const useWorktree = project.defaultUseWorktree ?? false;

  useEffect(() => {
    if (!open) {
      setText('');
      setPreview([]);
      setError('');
      setExecutionMode('backlog');
      setSubmitting(false);
      setPreviewing(false);
      return;
    }

    setAgentType(project.defaultAgentType ?? 'codex');
    setPriority(project.defaultPriority ?? 'medium');
    api.getAgents().then(setAvailableAgents).catch(() => setAvailableAgents([]));
  }, [open, project.defaultAgentType, project.defaultPriority]);

  const agentAvailability = useMemo(
    () => new Map(availableAgents.map((agent) => [agent.name, agent])),
    [availableAgents],
  );

  const handlePreview = async () => {
    setPreviewing(true);
    setError('');
    try {
      const result = await api.previewRoadmapIntake({ text, projectId: project.id });
      setPreview(result.tasks);
    } catch (err) {
      setPreview([]);
      setError((err as Error).message);
    } finally {
      setPreviewing(false);
    }
  };

  const updateTask = (order: number, updates: Partial<Pick<RoadmapProposedTask, 'title' | 'description'>>) => {
    setPreview((tasks) => tasks.map((task) => task.order === order ? { ...task, ...updates } : task));
  };

  const removeTask = (order: number) => {
    setPreview((tasks) => tasks.filter((task) => task.order !== order));
  };

  const handleCreate = async () => {
    const accepted = preview.filter((task) => task.title.trim());
    if (accepted.length === 0) {
      setError('Keep at least one proposed task before creating cards');
      return;
    }
    if (accepted.some((task) => task.description.length > MAX_DESCRIPTION_LENGTH)) {
      setError(`Description must be at most ${MAX_DESCRIPTION_LENGTH.toLocaleString()} characters`);
      return;
    }
    if (executionMode !== 'backlog' && !project.repoPath) {
      setError('Immediate execution requires the selected project to have a local path');
      return;
    }

    setSubmitting(true);
    setError('');
    try {
      const result = await onCreateTasks(accepted.map((task, index) => ({
        title: task.title.trim(),
        description: task.description.trim(),
        priority,
        columnId: executionMode !== 'backlog' && index === 0 ? 'in-progress' : 'backlog',
        agentType,
        autoRun: executionMode === 'full-roadmap' || (executionMode === 'first-card' && index === 0) || undefined,
        repoPath: project.repoPath,
        baseBranch,
        useWorktree,
        branchName: useWorktree ? `task/${slugify(task.title)}` : undefined,
        dependsOnTaskIndexes: index > 0 ? [index - 1] : undefined,
      })));
      if (result === undefined) return;
      onClose();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm"
            onClick={onClose}
          />
          <motion.div
            role="dialog"
            aria-modal="true"
            aria-labelledby="roadmap-intake-title"
            initial={{ opacity: 0, scale: 0.96, y: 18 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, y: 18 }}
            transition={{ type: 'spring', damping: 25, stiffness: 300 }}
            className="fixed left-1/2 top-1/2 z-50 flex max-h-[90vh] w-[min(920px,calc(100vw-1.5rem))] -translate-x-1/2 -translate-y-1/2 flex-col rounded-xl border border-border bg-card p-5 shadow-2xl"
          >
            <div className="mb-4 flex items-center justify-between gap-3">
              <div className="flex min-w-0 items-center gap-2">
                <ClipboardList className="h-4 w-4 shrink-0 text-primary" />
                <h2 id="roadmap-intake-title" className="truncate text-base font-semibold">Roadmap Intake</h2>
              </div>
              <button
                onClick={onClose}
                className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                aria-label="Close roadmap intake"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="grid min-h-0 flex-1 gap-4 lg:grid-cols-[0.85fr_1.15fr]">
              <div className="flex min-h-0 flex-col gap-3">
                <label className="text-xs font-medium text-muted-foreground" htmlFor="roadmap-text">
                  Roadmap text
                </label>
                <textarea
                  id="roadmap-text"
                  value={text}
                  onChange={(event) => setText(event.target.value)}
                  placeholder="v0.40 - Improve task parsing&#10;- Add retry controls&#10;1. Harden validation"
                  className="min-h-56 flex-1 resize-none rounded-lg border border-border bg-background px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                />
                <button
                  type="button"
                  onClick={handlePreview}
                  disabled={previewing || submitting}
                  className="flex h-10 items-center justify-center gap-2 rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {previewing ? <Loader2 className="h-4 w-4 animate-spin" /> : <ClipboardList className="h-4 w-4" />}
                  Preview Cards
                </button>
                {error && (
                  <p role="alert" className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-400">
                    {error}
                  </p>
                )}
              </div>

              <div className="flex min-h-0 flex-col gap-3">
                <div className="grid gap-2 sm:grid-cols-3">
                  <label className="space-y-1">
                    <span className="block text-xs font-medium text-muted-foreground">Execution mode</span>
                    <select
                      value={executionMode}
                      onChange={(event) => setExecutionMode(event.target.value as RoadmapExecutionMode)}
                      className="h-10 w-full rounded-lg border border-border bg-background px-2 text-sm focus:border-primary focus:outline-none"
                    >
                      <option value="backlog">Backlog only</option>
                      <option value="first-card">Start first now</option>
                      <option value="full-roadmap">Auto-progress all</option>
                    </select>
                  </label>
                  <label className="space-y-1">
                    <span className="block text-xs font-medium text-muted-foreground">Agent</span>
                    <select
                      value={agentType}
                      onChange={(event) => setAgentType(event.target.value as AgentType)}
                      className="h-10 w-full rounded-lg border border-border bg-background px-2 text-sm focus:border-primary focus:outline-none"
                    >
                      {AGENT_OPTIONS.map((agent) => {
                        const info = agentAvailability.get(agent.value);
                        const suffix = info?.available === false ? ' (unavailable)' : '';
                        return <option key={agent.value} value={agent.value}>{agent.label}{suffix}</option>;
                      })}
                    </select>
                  </label>
                  <label className="space-y-1">
                    <span className="block text-xs font-medium text-muted-foreground">Priority</span>
                    <select
                      value={priority}
                      onChange={(event) => setPriority(event.target.value as Priority)}
                      className="h-10 w-full rounded-lg border border-border bg-background px-2 text-sm focus:border-primary focus:outline-none"
                    >
                      {PRIORITY_OPTIONS.map((option) => (
                        <option key={option.value} value={option.value}>{option.label}</option>
                      ))}
                    </select>
                  </label>
                </div>

                <div className="min-h-0 flex-1 overflow-y-auto rounded-lg border border-border">
                  {preview.length === 0 ? (
                    <div className="flex h-full min-h-56 items-center justify-center px-6 text-center text-sm text-muted-foreground">
                      Previewed cards appear here before anything is created.
                    </div>
                  ) : (
                    <div className="divide-y divide-border">
                      {preview.map((task) => (
                        <div key={task.order} className="grid gap-2 p-3">
                          <div className="flex items-start gap-2">
                            <span className="mt-2 w-6 shrink-0 text-right text-xs text-muted-foreground">{task.order}</span>
                            <input
                              aria-label={`Title for roadmap item ${task.order}`}
                              value={task.title}
                              onChange={(event) => updateTask(task.order, { title: event.target.value })}
                              className="min-w-0 flex-1 rounded-lg border border-border bg-background px-3 py-2 text-sm font-medium focus:border-primary focus:outline-none"
                            />
                            <button
                              type="button"
                              onClick={() => removeTask(task.order)}
                              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border text-muted-foreground transition-colors hover:bg-red-500/10 hover:text-red-400"
                              aria-label={`Remove roadmap item ${task.order}`}
                              title="Remove"
                            >
                              <Trash2 className="h-4 w-4" />
                            </button>
                          </div>
                          <textarea
                            aria-label={`Description for roadmap item ${task.order}`}
                            aria-describedby={`roadmap-description-count-${task.order}`}
                            aria-invalid={task.description.length > MAX_DESCRIPTION_LENGTH}
                            value={task.description}
                            onChange={(event) => updateTask(task.order, { description: event.target.value })}
                            rows={3}
                            className="ml-8 resize-none rounded-lg border border-border bg-background px-3 py-2 text-xs text-muted-foreground focus:border-primary focus:outline-none"
                          />
                          <p id={`roadmap-description-count-${task.order}`} className="ml-8 text-xs text-muted-foreground">
                            {task.description.length.toLocaleString()} / {MAX_DESCRIPTION_LENGTH.toLocaleString()} characters
                          </p>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>

            <div className="mt-4 flex justify-end gap-2 border-t border-border pt-4">
              <button
                type="button"
                onClick={onClose}
                className="rounded-lg px-4 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleCreate}
                disabled={submitting || preview.length === 0}
                className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
                Create {preview.length || ''} Cards
              </button>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
