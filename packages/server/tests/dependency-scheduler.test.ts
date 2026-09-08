import test from 'node:test';
import assert from 'node:assert/strict';
import type { Task, TaskGroup } from '../src/types.js';
import type { TaskRepository } from '../src/repositories/types.js';
import type { TaskGroupRepository } from '../src/repositories/group-types.js';
import type { ProjectRepository } from '../src/repositories/project-types.js';
import type { AgentManager } from '../src/services/agent-manager.js';
import { installDependencyScheduler } from '../src/services/dependency-scheduler.js';
import { broadcastTaskUpdate } from '../src/routes/helpers.js';
import { startOrderedGroupChild } from '../src/services/ordered-group.js';
import { tickProjectAutoRun } from '../src/routes/projects.js';
import { broadcast } from '../src/websocket.js';
import { withDependencyAdmissionLock } from '../src/services/task-dependencies.js';

function fixture() {
  const children = ['a1', 'a2', 'b1', 'b2'].map((id, index) => ({ id, title: id, projectId: 'p', groupId: id[0],
    groupOrder: index % 2, description: '', priority: 'medium', columnId: 'backlog', agentStatus: 'idle', agentType: 'codex', createdAt: index } as Task));
  const groups = ['a', 'b'].map(id => ({ id, title: id, projectId: 'p', columnId: 'in-progress', roadmapExecutionMode: 'full-roadmap' } as TaskGroup));
  const started: string[] = [];
  const repo = {
    getById: async (id: string) => children.find(t => t.id === id),
    getAll: async () => [],
    getOrderedGroupTasks: async () => undefined,
    getRelationships: async (id: string) => id === 'b2' ? [{ type: 'blocks', direction: 'blocked-by', relatedTaskId: 'a2' }] : [],
    requestRun: async (id: string) => Object.assign(children.find(t => t.id === id)!, { runRequestedAt: Date.now() }),
    claimRun: async (id: string) => Object.assign(children.find(t => t.id === id)!, { runClaimedAt: Date.now() }),
    update: async (id: string, update: Partial<Task>) => Object.assign(children.find(t => t.id === id)!, update),
  } as unknown as TaskRepository;
  const groupRepo = {
    getAll: async () => groups,
    getById: async (id: string) => groups.find(g => g.id === id),
    getChildTasks: async (id: string) => children.filter(t => t.groupId === id),
    update: async (id: string, update: Partial<TaskGroup>) => Object.assign(groups.find(g => g.id === id)!, update),
  } as unknown as TaskGroupRepository;
  const project = { id: 'p', name: 'P', autoRunEnabled: true, isDefault: false, createdAt: 1, updatedAt: 1 };
  const projects = { getById: async () => project, getAllWithCounts: async () => [project] } as unknown as ProjectRepository;
  const manager = { resetEvents: async () => {}, isRunning: () => false, reevaluateGroupQueues: () => {},
    getAvailableAgents: () => [{ name: 'codex', available: true }], startAgent: (task: Task) => started.push(task.id),
  } as unknown as AgentManager;
  return { children, groups, started, repo, groupRepo, projects, manager, project };
}
const settle = () => new Promise(resolve => setTimeout(resolve, 30));

test('server reevaluates two concurrent groups and unlocks external gates without a browser', async () => {
  const f = fixture();
  const stop = installDependencyScheduler(f.repo, f.groupRepo, f.projects, f.manager);
  try {
    await settle(); assert.deepEqual(f.started, ['a1', 'b1']);
    for (const id of ['a1', 'b1']) {
      const task = f.children.find(t => t.id === id)!;
      Object.assign(task, { columnId: 'done', agentStatus: 'complete' }); broadcastTaskUpdate(task);
    }
    await settle(); assert.deepEqual(f.started, ['a1', 'b1', 'a2']);
    assert.equal(f.children.find(t => t.id === 'b2')!.runClaimedAt, undefined);
    const a2 = f.children.find(t => t.id === 'a2')!;
    Object.assign(a2, { columnId: 'done', agentStatus: 'complete' }); broadcastTaskUpdate(a2);
    await settle(); assert.deepEqual(f.started, ['a1', 'b1', 'a2', 'b2']);
  } finally { stop(); }
});

test('Auto Run disabled leaves externally unlocked group pending', async () => {
  const f = fixture(); f.project.autoRunEnabled = false;
  const stop = installDependencyScheduler(f.repo, f.groupRepo, f.projects, f.manager);
  try { await settle(); assert.deepEqual(f.started, []); } finally { stop(); }
});

test('Next Eligible project tick permits independent groups while sibling executes', async () => {
  const f = fixture();
  f.children[0].agentStatus = 'executing';
  const result = await tickProjectAutoRun({ project: f.project, orderedBacklogIds: ['b'], groupRepo: f.groupRepo,
    taskRepo: f.repo, projectRepo: f.projects, agentManager: f.manager });
  assert.equal(result.started, true); assert.deepEqual(f.started, ['b1']);
});

test('Auto Run persists gated backlog group intent and completion wakes it automatically', async () => {
  const f = fixture();
  f.groups[1].columnId = 'backlog';
  Object.assign(f.children[2], { columnId: 'done', agentStatus: 'complete' });
  Object.assign(f.children[0], { columnId: 'done', agentStatus: 'complete' });
  f.children[1].agentStatus = 'executing';
  const tick = await tickProjectAutoRun({ project: f.project, orderedBacklogIds: ['b'], groupRepo: f.groupRepo,
    taskRepo: f.repo, projectRepo: f.projects, agentManager: f.manager });
  assert.equal(tick.started, false);
  assert.equal(f.groups[1].columnId, 'in-progress');
  assert.equal(f.children[3].runClaimedAt, undefined);
  const stop = installDependencyScheduler(f.repo, f.groupRepo, f.projects, f.manager);
  try {
    Object.assign(f.children[1], { columnId: 'done', agentStatus: 'complete' });
    broadcastTaskUpdate(f.children[1]);
    await settle(); assert.deepEqual(f.started, ['b2']);
  } finally { stop(); }
});

test('dependency notifications resume requested standalone dependents without starting unrelated backlog', async () => {
  const f = fixture(); f.groups.forEach(group => { group.archived = true; });
  const prerequisite = f.children[1]; Object.assign(prerequisite, { columnId: 'done', agentStatus: 'complete' });
  const dependent = { ...f.children[3], groupId: undefined, runRequestedAt: 1 };
  const unrelated = { ...f.children[0], id: 'unrelated', groupId: undefined, runRequestedAt: 1 };
  f.children[3] = dependent; f.children.push(unrelated);
  f.repo.getAll = async () => [unrelated, dependent];
  const stop = installDependencyScheduler(f.repo, f.groupRepo, f.projects, f.manager);
  try { await settle(); assert.deepEqual(f.started, ['b2']); } finally { stop(); }
});


for (const mode of ['backlog', 'first-card'] as const) test(`explicit Group Run in ${mode} mode wakes a gated child`, async () => {
  const f = fixture(); f.groups[0].archived = true; f.groups[1].roadmapExecutionMode = mode;
  Object.assign(f.children[2], { columnId: 'done', agentStatus: 'complete' });
  await startOrderedGroupChild('b', f.groupRepo, f.repo, f.manager, true, f.projects);
  assert.equal(f.children[3].runClaimedAt, undefined);
  assert.notEqual(f.children[3].runRequestedAt, undefined);
  const stop = installDependencyScheduler(f.repo, f.groupRepo, f.projects, f.manager);
  try {
    Object.assign(f.children[1], { columnId: 'done', agentStatus: 'complete' }); broadcastTaskUpdate(f.children[1]);
    await settle(); assert.deepEqual(f.started, ['b2']);
  } finally { stop(); }
});

test('imported task Auto Run false pauses automatic admission but permits explicit Run', async () => {
  const f = fixture();
  f.children[0].provenance = { origin: { roadmapAutoRun: false } };
  await startOrderedGroupChild('a', f.groupRepo, f.repo, f.manager, true, f.projects);
  assert.deepEqual(f.started, []);
  await startOrderedGroupChild('a', f.groupRepo, f.repo, f.manager, true, f.projects, 'a1');
  assert.deepEqual(f.started, ['a1']);
  Object.assign(f.children[0], { columnId: 'done', agentStatus: 'complete' });
  f.children[1].provenance = { origin: { roadmapAutoRun: false } };
  await startOrderedGroupChild('a', f.groupRepo, f.repo, f.manager, true, f.projects);
  assert.deepEqual(f.started, ['a1']);
});

for (const mode of ['backlog', 'first-card'] as const) test(`${mode} active group continues after merge without a successor Run request`, async () => {
  const f = fixture(); f.groups[1].archived = true; f.groups[0].roadmapExecutionMode = mode;
  Object.assign(f.children[0], { columnId: 'review', agentStatus: 'complete' });
  const stop = installDependencyScheduler(f.repo, f.groupRepo, f.projects, f.manager);
  try {
    await settle(); assert.deepEqual(f.started, []);
    assert.equal(f.children[1].runRequestedAt, undefined);
    f.children[0].columnId = 'done';
    for (let i = 0; i < 10; i++) {
      broadcastTaskUpdate(f.children[0]);
      broadcast({ type: 'group_updated', payload: f.groups[0] });
    }
    await settle(); assert.deepEqual(f.started, ['a2']);
  } finally { stop(); }
});

test('stopped active group is not resumed by integration broadcasts', async () => {
  const f = fixture(); f.groups[1].archived = true; f.groups[0].completedAt = 1;
  Object.assign(f.children[0], { columnId: 'done', agentStatus: 'complete' });
  const stop = installDependencyScheduler(f.repo, f.groupRepo, f.projects, f.manager);
  try { broadcastTaskUpdate(f.children[0]); await settle(); assert.deepEqual(f.started, []); }
  finally { stop(); }
});

test('Auto Run is rechecked after waiting for the admission lock', async () => {
  const f = fixture();
  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const held = withDependencyAdmissionLock(() => barrier);
  const start = startOrderedGroupChild('a', f.groupRepo, f.repo, f.manager, true, f.projects, undefined, true);
  await settle(); f.project.autoRunEnabled = false; release();
  await Promise.all([held, start]);
  assert.deepEqual(f.started, []);
});

test('one broken group does not starve an independent eligible group', async () => {
  const f = fixture(); const getChildren = f.groupRepo.getChildTasks;
  f.groupRepo.getChildTasks = async id => { if (id === 'a') throw new Error('repository unavailable'); return getChildren(id); };
  const stop = installDependencyScheduler(f.repo, f.groupRepo, f.projects, f.manager);
  try { await settle(); assert.deepEqual(f.started, ['b1']); } finally { stop(); }
});

test('group stop persisted while admission waits prevents successor reservation', async () => {
  const f = fixture();
  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const held = withDependencyAdmissionLock(async () => { await barrier; f.groups[0].completedAt = Date.now(); });
  const start = startOrderedGroupChild('a', f.groupRepo, f.repo, f.manager, true, f.projects, undefined, true);
  await settle(); release(); await Promise.all([held, start]);
  assert.deepEqual(f.started, []);
  assert.equal(f.children[0].runClaimedAt, undefined);
});

test('manual Run can resume a previously stopped group with Auto Run OFF', async () => {
  const f = fixture(); f.project.autoRunEnabled = false; f.groups[0].completedAt = 1;
  await startOrderedGroupChild('a', f.groupRepo, f.repo, f.manager, false, f.projects, 'a1');
  assert.deepEqual(f.started, ['a1']);
  assert.equal(f.groups[0].completedAt, undefined);
});

test('post-dispatch group bookkeeping cannot clear a newer stop token', async () => {
  const f = fixture(); let stopped: Promise<void> | undefined;
  f.manager.startAgent = task => {
    f.started.push(task.id);
    stopped = withDependencyAdmissionLock(async () => { f.groups[0].completedAt = 123; });
  };
  await startOrderedGroupChild('a', f.groupRepo, f.repo, f.manager, true, f.projects, undefined, true);
  await stopped;
  assert.equal(f.groups[0].completedAt, 123);
});
