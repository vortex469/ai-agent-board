import type { Priority, AgentType, RoadmapProposedGroup } from '@/types';
import { PRIORITY_OPTIONS } from '@/lib/priority-config';
import { AGENT_OPTIONS } from '@/lib/agent-config';
import { MAX_TITLE_LENGTH, MAX_DESCRIPTION_LENGTH } from '@ai-agent-board/shared/constants.js';

/** Keep preview references intact when the operator renames a lane. */
export function renameRoadmapGroup(groups: RoadmapProposedGroup[], index: number, title: string): RoadmapProposedGroup[] {
  const oldTitle = groups[index].title.trim().toLowerCase();
  return groups.map((group, groupIndex) => ({
    ...group,
    title: groupIndex === index ? title : group.title,
    tasks: group.tasks.map(task => ({ ...task, dependencies: task.dependencies.map(reference => {
      const slash = reference.lastIndexOf('/');
      return slash >= 0 && reference.slice(0, slash).trim().toLowerCase() === oldTitle
        ? `${title.trim()} / ${reference.slice(slash + 1).trim()}` : reference;
    }) })),
  }));
}

export const editRoadmapDependencies = (value: string): string[] => value.trim() ? value.split(',').map(reference => reference.trim()) : [];

const field = 'min-h-11 w-full min-w-0 rounded-lg border border-border bg-background px-2 py-2 text-sm';
const settingValue = (value?: boolean) => value === undefined ? '' : String(value);
const booleanSetting = (value: string) => value === '' ? undefined : value === 'true';

export function MultiGroupRoadmapPreview({ groups, onChange, defaultAgent, disabled = false }: {
  groups: RoadmapProposedGroup[];
  onChange: (groups: RoadmapProposedGroup[]) => void;
  defaultAgent: AgentType;
  disabled?: boolean;
}) {
  const updateGroup = (index: number, updates: Partial<RoadmapProposedGroup>) =>
    onChange(groups.map((group, i) => i === index ? { ...group, ...updates } : group));
  const updateTask = (groupIndex: number, taskIndex: number, updates: Partial<RoadmapProposedGroup['tasks'][number]>) =>
    updateGroup(groupIndex, { tasks: groups[groupIndex].tasks.map((task, i) => i === taskIndex ? { ...task, ...updates } : task) });
  const agents = AGENT_OPTIONS.map(agent => <option key={agent.value} value={agent.value}>{agent.label}</option>);
  return <fieldset disabled={disabled} className="min-w-0 space-y-4" aria-label="Multi-group import preview">
    <p className="text-xs text-muted-foreground">Edit groups and tasks before creation. Dependencies use task references (01) or Group / 01; separate multiple references with commas. Cross-group gates wait for integration.</p>
    {groups.map((group, gi) => <section key={gi} className="min-w-0 space-y-3 rounded-lg border border-border p-3" aria-label={`Group ${gi + 1} preview`}>
      <label className="block text-xs">Group
        <input aria-label={`Group ${gi + 1} name`} value={group.title} maxLength={MAX_TITLE_LENGTH} className={field}
          onChange={event => onChange(renameRoadmapGroup(groups, gi, event.target.value))} />
      </label>
      <div className="grid min-w-0 gap-2 sm:grid-cols-2">
        <label className="min-w-0 text-xs">Agent
          <select aria-label={`Group ${gi + 1} agent`} className={field} value={group.agentType ?? ''} onChange={event => updateGroup(gi, { agentType: (event.target.value || undefined) as AgentType | undefined })}>
            <option value="">Project default ({defaultAgent})</option>{agents}
          </select>
        </label>
        <label className="min-w-0 text-xs">Auto Run
          <select aria-label={`Group ${gi + 1} auto run`} className={field} value={settingValue(group.autoRun)} onChange={event => updateGroup(gi, { autoRun: booleanSetting(event.target.value) })}>
            <option value="">Off (default)</option><option value="false">Off</option><option value="true">On — respect dependency gates</option>
          </select>
        </label>
        <label className="min-w-0 text-xs">Repo
          <input aria-label={`Group ${gi + 1} repo`} className={field} placeholder="Project repository" value={group.repoPath ?? ''} onChange={event => updateGroup(gi, { repoPath: event.target.value || undefined })} />
        </label>
        <label className="min-w-0 text-xs">Base branch
          <input aria-label={`Group ${gi + 1} base branch`} className={field} placeholder="Project base branch" value={group.baseBranch ?? ''} onChange={event => updateGroup(gi, { baseBranch: event.target.value || undefined })} />
        </label>
      </div>
      {group.tasks.map((task, ti) => <div key={ti} className="min-w-0 space-y-2 border-t border-border pt-3" aria-label={`Group ${gi + 1} task ${ti + 1}`}>
        <p className="text-xs text-muted-foreground">Task reference: {task.ref}</p>
        <div className="flex min-w-0 gap-2">
          <label className="w-20 shrink-0 text-xs">Order
            <input aria-label={`Group ${gi + 1} task ${ti + 1} order`} type="number" min={1} className={field} value={task.order} onChange={event => updateTask(gi, ti, { order: Number(event.target.value) })} />
          </label>
          <label className="min-w-0 flex-1 text-xs">Task
            <input aria-label={`Group ${gi + 1} task ${ti + 1} title`} className={field} maxLength={MAX_TITLE_LENGTH} value={task.title} onChange={event => updateTask(gi, ti, { title: event.target.value })} />
          </label>
        </div>
        <textarea aria-label={`Group ${gi + 1} task ${ti + 1} description`} className={field} rows={2} maxLength={MAX_DESCRIPTION_LENGTH} value={task.description} onChange={event => updateTask(gi, ti, { description: event.target.value })} />
        <label className="block text-xs">Dependencies
          <input aria-label={`Group ${gi + 1} task ${ti + 1} dependencies`} className={field} value={task.dependencies.join(', ')} onChange={event => updateTask(gi, ti, { dependencies: editRoadmapDependencies(event.target.value) })} />
        </label>
        <div className="flex min-w-0 flex-wrap gap-1" aria-label="Dependency display">
          {task.dependencies.filter(Boolean).map((dependency, di) => <span key={di} className="max-w-full break-words rounded bg-accent px-2 py-1 text-xs">
            {dependency.includes('/') && dependency.slice(0, dependency.lastIndexOf('/')).trim().toLowerCase() !== group.title.trim().toLowerCase() ? 'Cross-group: ' : 'Within group: '}{dependency}
          </span>)}
          {task.dependencies.filter(Boolean).length === 0 && <span className="text-xs text-muted-foreground">No explicit dependencies</span>}
        </div>
        <div className="grid min-w-0 gap-2 sm:grid-cols-2">
          <label className="min-w-0 text-xs">Agent
            <select aria-label={`Group ${gi + 1} task ${ti + 1} agent`} className={field} value={task.agentType ?? ''} onChange={event => updateTask(gi, ti, { agentType: (event.target.value || undefined) as AgentType | undefined })}>
              <option value="">Inherit ({group.agentType ?? defaultAgent})</option>{agents}
            </select>
          </label>
          <label className="min-w-0 text-xs">Auto Run
            <select aria-label={`Group ${gi + 1} task ${ti + 1} auto run`} className={field} value={settingValue(task.autoRun)} onChange={event => updateTask(gi, ti, { autoRun: booleanSetting(event.target.value) })}>
              <option value="">Inherit ({group.autoRun ? 'On' : 'Off'})</option><option value="false">Off</option><option value="true">On</option>
            </select>
          </label>
        </div>
        <details className="min-w-0 text-xs">
          <summary className="min-h-11 cursor-pointer py-3">Task settings</summary>
          <div className="grid min-w-0 gap-2 sm:grid-cols-2">
            <label className="min-w-0">Priority
              <select aria-label={`Group ${gi + 1} task ${ti + 1} priority`} className={field} value={task.priority ?? ''} onChange={event => updateTask(gi, ti, { priority: (event.target.value || undefined) as Priority | undefined })}>
                <option value="">Inherit</option>{PRIORITY_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
            </label>
            <label className="min-w-0">Worktree
              <select aria-label={`Group ${gi + 1} task ${ti + 1} worktree`} className={field} value={settingValue(task.useWorktree)} onChange={event => updateTask(gi, ti, { useWorktree: booleanSetting(event.target.value) })}>
                <option value="">Inherit</option><option value="false">Off</option><option value="true">On</option>
              </select>
            </label>
            {(['repoPath', 'baseBranch', 'branchName'] as const).map(setting => <label key={setting} className="min-w-0">{setting === 'repoPath' ? 'Repo' : setting === 'baseBranch' ? 'Base branch' : 'Branch'}
              <input aria-label={`Group ${gi + 1} task ${ti + 1} ${setting}`} className={field} placeholder="Inherit" value={task[setting] ?? ''} onChange={event => updateTask(gi, ti, { [setting]: event.target.value || undefined })} />
            </label>)}
          </div>
        </details>
      </div>)}
    </section>)}
  </fieldset>;
}
