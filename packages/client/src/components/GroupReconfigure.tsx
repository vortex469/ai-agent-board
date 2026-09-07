import { useEffect, useState } from 'react';
import type { AgentInfo, AgentType, Priority, ReconfigureTaskGroupInput } from '@/types';
import { isPendingGroupChild } from '@ai-agent-board/shared/constants.js';
import { api, type TaskGroupWithChildren } from '@/lib/api';
import { AGENT_DISPLAY, AGENT_OPTIONS } from '@/lib/agent-config';
import { PRIORITY_OPTIONS } from '@/lib/priority-config';

interface Props {
  group: TaskGroupWithChildren;
  onApply: (id: string, updates: ReconfigureTaskGroupInput) => Promise<unknown>;
  onSaved: () => void;
}

export function GroupReconfigure({ group, onApply, onSaved }: Props) {
  const pending = group.archived ? [] : group.children.filter(isPendingGroupChild);
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [agentType, setAgentType] = useState<AgentType | ''>('');
  const [priority, setPriority] = useState<Priority | ''>('');
  const [changeTimeout, setChangeTimeout] = useState(false);
  const [timeout, setTimeout] = useState('');
  const [scope, setScope] = useState('all');
  const [selected, setSelected] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    api.getAgents().then((result) => { if (active) setAgents(result); })
      .catch(() => { if (active) setError('Could not load available agents. Retry by reopening this dialog.'); });
    return () => { active = false; };
  }, []);
  const affected = scope === 'all' ? pending : pending.filter((child) => selected.includes(child.id));
  const counts = new Map<AgentType, number>();
  for (const child of pending) {
    const type = child.agentType ?? 'copilot';
    counts.set(type, (counts.get(type) ?? 0) + 1);
  }
  const invalidTimeout = changeTimeout && timeout !== '' && (!Number.isInteger(Number(timeout)) || Number(timeout) < 1 || Number(timeout) > 240);
  const hasChanges = !!agentType || !!priority || changeTimeout;
  async function apply() {
    if (saving || !hasChanges || !affected.length || invalidTimeout) return;
    setSaving(true);
    setError('');
    try {
      // Always submit the displayed IDs: a newly eligible child must not be
      // included without the operator seeing it in the affected count.
      await onApply(group.id, {
        taskIds: affected.map((child) => child.id),
        ...(agentType ? { agentType } : {}),
        ...(priority ? { priority } : {}),
        ...(changeTimeout ? { timeoutMinutes: timeout === '' ? null : Number(timeout) } : {}),
      });
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not reconfigure pending tasks');
    } finally {
      setSaving(false);
    }
  }
  const fieldClass = 'w-full min-w-0 rounded-lg border border-border bg-background px-3 py-2 text-sm';
  return (
    <section aria-label="Pending task configuration" className="space-y-3 rounded-lg border border-border p-3">
      <h3 className="text-sm font-semibold">Pending execution settings</h3>
      <p className="text-sm text-muted-foreground">Current pending agents: {counts.size ? [...counts].map(([type, count]) => `${AGENT_DISPLAY[type].label} (${count})`).join(', ') : 'None'}</p>
      <p className="text-xs text-muted-foreground">Only unstarted backlog tasks can change here. Running, completed, failed, review and Needs Human tasks are excluded. Saving does not start tasks.</p>
      <fieldset disabled={saving || pending.length === 0} className="space-y-3 disabled:opacity-50">
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="space-y-1 text-sm">Agent
            <select aria-label="Pending agent" value={agentType} onChange={(e) => setAgentType(e.target.value as AgentType | '')} className={fieldClass}>
              <option value="">Keep current agents</option>
              {AGENT_OPTIONS.map((agent) => <option key={agent.value} value={agent.value} disabled={!agents.some((info) => info.name === agent.value && info.available)}>{agent.label}{!agents.some((info) => info.name === agent.value && info.available) ? ' (unavailable)' : ''}</option>)}
            </select>
          </label>
          <label className="space-y-1 text-sm">Pending priority
            <select aria-label="Pending priority" value={priority} onChange={(e) => setPriority(e.target.value as Priority | '')} className={fieldClass}>
              <option value="">Keep current priorities</option>
              {PRIORITY_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          </label>
        </div>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={changeTimeout} onChange={(e) => setChangeTimeout(e.target.checked)} />Change timeout</label>
        {changeTimeout && <label className="block space-y-1 text-sm">Timeout (minutes)
          <input aria-label="Timeout (minutes)" type="number" min={1} max={240} step={1} value={timeout} onChange={(e) => setTimeout(e.target.value)} placeholder="Server default" className={fieldClass} />
          <span className="text-xs text-muted-foreground">1–240 minutes; leave blank to use the server default.</span>
        </label>}
        <label className="block space-y-1 text-sm">Apply to
          <select aria-label="Apply to" value={scope} onChange={(e) => setScope(e.target.value)} className={fieldClass}>
            <option value="all">All pending children</option>
            <option value="selected">Selected pending children</option>
          </select>
        </label>
        {scope === 'selected' && <div className="max-h-48 space-y-2 overflow-y-auto">
          {pending.map((child) => <label key={child.id} className="flex items-start gap-2 text-sm">
            <input type="checkbox" className="mt-1" checked={selected.includes(child.id)} onChange={(e) => setSelected((prev) => e.target.checked ? [...prev, child.id] : prev.filter((id) => id !== child.id))} />
            <span className="min-w-0 break-words">{child.title}</span>
          </label>)}
        </div>}
        <p role="status" className="text-sm">{hasChanges ? affected.length : 0} pending child tasks will be affected.</p>
        {invalidTimeout && <p className="text-sm text-red-400">Timeout must be a whole number from 1 to 240.</p>}
        <button type="button" onClick={apply} disabled={!hasChanges || !affected.length || invalidTimeout} className="w-full rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-foreground disabled:opacity-40">
          {saving ? 'Applying…' : `Apply to ${affected.length} pending tasks`}
        </button>
      </fieldset>
      {error && <p role="alert" className="text-sm text-red-400">{error}</p>}
    </section>
  );
}
