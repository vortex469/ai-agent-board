import type { RoadmapProposedGroup, RoadmapGroupTask } from '@ai-agent-board/shared/types.js';
import { isValidAgentType, isValidPriority, MAX_TITLE_LENGTH, MAX_DESCRIPTION_LENGTH, MAX_GROUP_CHILDREN } from '@ai-agent-board/shared/constants.js';

const key = (value: string) => value.trim().toLowerCase();
const refKey = (value: string) => /^\d+$/.test(value.trim()) ? String(Number(value)) : key(value);
export function validateRoadmapGroups(input: unknown): { groups: RoadmapProposedGroup[]; edges: [number, number][] } | string {
  if (!Array.isArray(input) || input.length < 1 || input.length > 25) return 'groups must contain 1 to 25 groups';
  const groups = input as RoadmapProposedGroup[];
  const names = new Map<string, number>();
  const refs: Map<string, number>[] = [];
  let total = 0;
  for (const [gi, group] of groups.entries()) {
    if (!group || typeof group.title !== 'string' || !group.title.trim() || group.title.length > MAX_TITLE_LENGTH) return 'Each group requires a valid title';
    if (/[,;/]/.test(group.title)) return 'Group titles cannot contain /, comma or semicolon (reserved for dependency references)';
    if (names.has(key(group.title))) return `Duplicate ambiguous group: ${group.title}`;
    names.set(key(group.title), gi);
    if (!Array.isArray(group.tasks) || !group.tasks.length || group.tasks.length > MAX_GROUP_CHILDREN) return `Invalid task count in ${group.title}`;
    for (const item of [group, ...group.tasks]) {
      if (!item || typeof item !== 'object') return 'Invalid roadmap item';
      if (item.agentType !== undefined && !isValidAgentType(item.agentType)) return 'Invalid agent';
      if (item.priority !== undefined && !isValidPriority(item.priority)) return 'Invalid priority';
      if (item.autoRun !== undefined && typeof item.autoRun !== 'boolean') return 'autoRun must be boolean';
      if (item.useWorktree !== undefined && typeof item.useWorktree !== 'boolean') return 'useWorktree must be boolean';
      for (const field of ['repoPath', 'baseBranch', 'branchName'] as const) if (field in item && typeof (item as any)[field] !== 'string') return `${field} must be a string`;
    }
    const map = new Map<string, number>();
    const orders = new Set<number>();
    group.tasks = [...group.tasks].sort((a, b) => a.order - b.order);
    for (const task of group.tasks) {
      if (typeof task.ref !== 'string' || !task.ref.trim() || /[,/;]/.test(task.ref)) return 'Each task requires an unambiguous reference';
      if (map.has(refKey(task.ref))) return `Duplicate ambiguous task reference: ${group.title} / ${task.ref}`;
      if (!Number.isInteger(task.order) || task.order < 1 || orders.has(task.order)) return 'Task orders must be unique positive integers within a group';
      orders.add(task.order);
      if (typeof task.title !== 'string' || !task.title.trim() || task.title.length > MAX_TITLE_LENGTH) return 'Each task requires a valid title';
      if (typeof task.description !== 'string' || task.description.length > MAX_DESCRIPTION_LENGTH) return 'Invalid task description';
      if (!Array.isArray(task.dependencies) || task.dependencies.some(d => typeof d !== 'string' || !d.trim())) return 'dependencies must be an array of references';
      map.set(refKey(task.ref), total++);
    }
    refs.push(map);
  }
  if (total > 100) return 'Roadmap intake supports up to 100 tasks across groups';
  const edges: [number, number][] = [];
  let index = 0;
  for (const [gi, group] of groups.entries()) {
    for (const [ti, task] of group.tasks.entries()) {
      const seen = new Set<number>();
      for (const reference of task.dependencies) {
        const parts = reference.split('/').map(s => s.trim());
        if (parts.length > 2) return `Ambiguous dependency reference: ${reference}`;
        const targetGroup = parts.length === 2 ? names.get(key(parts[0])) : gi;
        if (targetGroup === undefined) return `Unknown group reference: ${parts[0]}`;
        const target = refs[targetGroup].get(refKey(parts.at(-1)!));
        if (target === undefined) return `Unknown task reference: ${reference}`;
        if (target === index) return `Self dependency: ${reference}`;
        if (seen.has(target)) return `Duplicate ambiguous dependency reference: ${reference}`;
        seen.add(target);
        edges.push([target, index]);
      }
      // Ordered groups also wait for every preceding task's integration.
      if (ti > 0 && !seen.has(index - 1)) edges.push([index - 1, index]);
      index++;
    }
  }
  const incoming = Array(total).fill(0) as number[];
  const outgoing: number[][] = Array.from({ length: total }, () => []);
  for (const [from, to] of edges) { incoming[to]++; outgoing[from].push(to); }
  const queue = incoming.flatMap((n, i) => n === 0 ? [i] : []);
  for (let i = 0; i < queue.length; i++) for (const to of outgoing[queue[i]]) if (--incoming[to] === 0) queue.push(to);
  if (queue.length !== total) return 'Dependency cycle detected (including group task ordering)';
  return { groups, edges };
}

export function parseMultiRoadmap(text: string): { groups: RoadmapProposedGroup[]; tasks: RoadmapGroupTask[] } | string {
  const groups: RoadmapProposedGroup[] = [];
  let group: RoadmapProposedGroup | undefined;
  let task: RoadmapGroupTask | undefined;
  for (const line of text.split('\n')) {
    const declaration = line.match(/^\s*GROUP:\s*(.*?)\s*$/i);
    if (declaration) { if (!declaration[1].trim()) return 'Group title is required'; group = { title: declaration[1], tasks: [] }; groups.push(group); task = undefined; continue; }
    if (!line.trim()) continue;
    if (!group) return 'Declare GROUP: before tasks or settings';
    if (/^\s*\d+[.)]\s*$/.test(line)) return 'Task title is required';
    const item = line.match(/^\s*(\d+)[.)]\s+(.+)$/);
    if (item) {
      task = { ref: item[1], order: Number(item[1]), title: item[2].trim(), description: '', sourceText: line, dependencies: [] };
      group.tasks.push(task); continue;
    }
    const dependency = line.match(/^\s*DEPENDS ON:\s*(.*)$/i);
    if (dependency) { if (!task) return 'DEPENDS ON requires a task'; if (!dependency[1].trim()) return 'DEPENDS ON requires references'; task.dependencies.push(...dependency[1].split(/[,;]/).map(s => s.trim())); continue; }
    const setting = line.match(/^\s*(AGENT|AUTO RUN|REPO|BASE BRANCH|BRANCH|PRIORITY|USE WORKTREE):\s*(.*?)\s*$/i);
    if (setting) {
      const target = task ?? group;
      const field = ({ AGENT: 'agentType', 'AUTO RUN': 'autoRun', REPO: 'repoPath', 'BASE BRANCH': 'baseBranch', BRANCH: task ? 'branchName' : 'baseBranch', PRIORITY: 'priority', 'USE WORKTREE': 'useWorktree' } as Record<string, string>)[setting[1].toUpperCase()];
      let value: string | boolean = setting[2];
      if (field === 'autoRun' || field === 'useWorktree') { if (!/^(true|false|yes|no|on|off)$/i.test(value)) return `${setting[1]} must be true or false`; value = /^(true|yes|on)$/i.test(value); }
      (target as any)[field] = value; continue;
    }
    if (!task) return `Unrecognized group setting: ${line.trim()}`;
    task.description += (task.description ? '\n' : '') + line;
    task.sourceText += '\n' + line;
  }
  const valid = validateRoadmapGroups(groups);
  return typeof valid === 'string' ? valid : { groups: valid.groups, tasks: valid.groups.flatMap(g => g.tasks) };
}
