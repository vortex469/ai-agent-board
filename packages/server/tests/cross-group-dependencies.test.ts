import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { Task } from '../src/types.js';
import type { TaskRepository } from '../src/repositories/types.js';
import { createAgentRouter } from '../src/routes/agent.js';
import { AgentManager } from '../src/services/agent-manager.js';
import { getTaskDependencyGate, withDependencyAdmissionLock, assertDependencyDoesNotCycle } from '../src/services/task-dependencies.js';

function fixture() {
  const tasks = new Map<string, Task>();
  const events: import('../src/types.js').AgentEvent[] = [];
  const edges = new Map<string, string[]>();
  const make = (id: string, overrides: Partial<Task> = {}) => {
    const task = { id, title: id, projectId: 'default', groupId: id, description: '', columnId: 'backlog', agentStatus: 'idle', priority: 'medium', createdAt: 1, ...overrides } as Task;
    tasks.set(id, task); return task;
  };
  const repo = {
    getById: async (id: string) => tasks.get(id),
    getRelationships: async (id: string) => (edges.get(id) ?? []).map(relatedTaskId => ({ relatedTaskId, type: 'blocks', direction: 'blocked-by' })),
    clearRun: async () => undefined,
    insertEvent: async (event: import('../src/types.js').AgentEvent) => { events.push(event); },
    getEventsByTaskId: async (id: string) => events.filter(event => event.taskId === id),
  } as unknown as TaskRepository;
  return { tasks, edges, make, repo };
}

for (const group of ['same', 'external']) test(`${group} group gate requires true successful completion and closes after reset`, async () => {
  const f = fixture();
  f.make('dependent', { groupId: 'same' });
  const prerequisite = f.make('prerequisite', { groupId: group });
  f.edges.set('dependent', ['prerequisite']);
  for (const state of [
    { columnId: 'backlog', agentStatus: 'idle' },
    { columnId: 'done', agentStatus: 'idle' },
    { columnId: 'done', agentStatus: 'failed' },
    { columnId: 'review', agentStatus: 'complete' },
  ] as Partial<Task>[]) {
    Object.assign(prerequisite, state);
    assert.equal((await getTaskDependencyGate(f.repo, 'dependent')).eligible, false);
  }
  Object.assign(prerequisite, { columnId: 'done', agentStatus: 'complete' });
  assert.equal((await getTaskDependencyGate(f.repo, 'dependent')).eligible, true);
  prerequisite.agentStatus = 'idle';
  assert.equal((await getTaskDependencyGate(f.repo, 'dependent')).eligible, false);
});

test('multiple external prerequisites, missing IDs and blocked tasks fail closed', async () => {
  const f = fixture(); f.make('dependent');
  f.make('a', { columnId: 'done', agentStatus: 'complete' });
  const b = f.make('b', { columnId: 'done', agentStatus: 'complete', archived: true });
  f.edges.set('dependent', ['a', 'b', 'missing']);
  let gate = await getTaskDependencyGate(f.repo, 'dependent');
  assert.deepEqual(gate.dependencies.map(d => d.status), ['Done', 'Blocked', 'Missing']);
  assert.equal(gate.eligible, false);
  b.archived = false; f.make('missing', { columnId: 'done', agentStatus: 'complete' });
  gate = await getTaskDependencyGate(f.repo, 'dependent');
  assert.equal(gate.eligible, true);
});

test('runtime rejects gated start before worktree creation or session reservation', async () => {
  const f = fixture(); const task = f.make('dependent', { useWorktree: true }); f.make('a'); f.edges.set(task.id, ['a']);
  const manager = new AgentManager(); manager.initEventPersistence(f.repo);
  let worktrees = 0; let statuses = 0;
  manager.setupWorktree = () => { worktrees++; return undefined; };
  manager.startAgent(task, () => { statuses++; });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(worktrees, 0); assert.equal(statuses, 0); assert.equal(manager.isRunning(task.id), false);
});

test('repository gate requires integration and rejects an existing stale dependent branch', async () => {
  const f = fixture();
  const root = fs.mkdtempSync(path.join(process.cwd(), '.dependency-baseline-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: 'pipe' }).trim();
  try {
    git('init', '-b', 'main'); git('config', 'user.email', 'test@example.invalid'); git('config', 'user.name', 'Test');
    fs.writeFileSync(path.join(root, 'base'), 'base'); git('add', '.'); git('commit', '-m', 'base');
    const oldBase = git('rev-parse', 'HEAD');
    git('branch', 'stale'); git('checkout', '-b', 'prerequisite');
    fs.writeFileSync(path.join(root, 'result'), 'result'); git('add', '.'); git('commit', '-m', 'result');
    git('checkout', 'main');
    const dependent = f.make('dependent', { repoPath: root, baseBranch: 'main', branchName: 'dependent', useWorktree: true });
    f.make('a', { repoPath: root, branchName: 'prerequisite', useWorktree: true, columnId: 'done', agentStatus: 'complete' });
    f.edges.set('dependent', ['a']);
    assert.match((await getTaskDependencyGate(f.repo, 'dependent')).reason!, /integration required/);
    git('merge', '--ff-only', 'prerequisite');
    assert.equal((await getTaskDependencyGate(f.repo, 'dependent')).eligible, true);
    dependent.repositoryBaseline = { startCommit: oldBase };
    assert.equal((await getTaskDependencyGate(f.repo, 'dependent')).eligible, false);
    delete dependent.repositoryBaseline;
    dependent.branchName = 'stale';
    assert.equal((await getTaskDependencyGate(f.repo, 'dependent')).eligible, false);
    delete dependent.branchName;
    dependent.useWorktree = false;
    git('checkout', 'stale');
    assert.equal((await getTaskDependencyGate(f.repo, 'dependent')).eligible, false);
    git('checkout', 'main');
    assert.equal((await getTaskDependencyGate(f.repo, 'dependent')).eligible, true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('concurrent group queue waits on external gate and automatically resumes on reevaluation', async () => {
  const f = fixture();
  const a = f.make('a', { groupId: 'group-a' });
  const b1 = f.make('b1', { groupId: 'group-b' });
  const b2 = f.make('b2', { groupId: 'group-b' });
  f.edges.set('b2', ['a']);
  const manager = new AgentManager(); manager.initEventPersistence(f.repo);
  const started: string[] = [];
  const callbacks = new Map<string, (status: Task['agentStatus']) => void | Promise<void>>();
  Object.assign(manager, { startAgentChecked: (task: Task, callback: (status: Task['agentStatus']) => void | Promise<void>) => { started.push(task.id); callbacks.set(task.id, callback); } });
  const group = (id: string) => ({ id, maxConcurrency: 2 } as Parameters<AgentManager['startGroup']>[0]);
  const status = (task: Task) => async (value: Task['agentStatus']) => { task.agentStatus = value; if (value === 'complete') task.columnId = 'done'; };
  manager.startGroup(group('group-a'), [a], status, () => () => {}, () => {});
  manager.startGroup(group('group-b'), [b1, b2], status, () => () => {}, () => {});
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(started.sort(), ['a', 'b1']);
  assert.equal(manager.isGroupRunning('group-b'), true);
  await callbacks.get('a')!('complete');
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(started.sort(), ['a', 'b1', 'b2']);
});


test('admission lock orders prerequisite reset before dependent reservation', async () => {
  const f = fixture(); f.make('dependent');
  const prerequisite = f.make('a', { columnId: 'done', agentStatus: 'complete' });
  f.edges.set('dependent', ['a']);
  let release!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; });
  const reset = withDependencyAdmissionLock(async () => { await wait; prerequisite.agentStatus = 'idle'; });
  let reserved = false;
  const admission = withDependencyAdmissionLock(async () => { reserved = (await getTaskDependencyGate(f.repo, 'dependent')).eligible; });
  release(); await Promise.all([reset, admission]);
  assert.equal(reserved, false);
});

test('coding prerequisite without a recorded branch fails closed', async () => {
  const f = fixture(); f.make('dependent', { repoPath: process.cwd() });
  f.make('a', { repoPath: process.cwd(), useWorktree: true, columnId: 'done', agentStatus: 'complete' });
  f.edges.set('dependent', ['a']);
  const gate = await getTaskDependencyGate(f.repo, 'dependent');
  assert.equal(gate.eligible, false);
  assert.match(gate.reason!, /no verifiable repository result/);
});


test('reset prerequisite warns a running dependent without aborting its session', async () => {
  const f = fixture(); f.make('dependent'); const prerequisite = f.make('a', { columnId: 'done', agentStatus: 'complete' });
  f.edges.set('dependent', ['a']);
  const manager = new AgentManager(); manager.initEventPersistence(f.repo);
  let aborts = 0;
  Object.assign(manager, { sessions: new Map([['dependent', { session: { abort: () => { aborts++; } } }]]) });
  prerequisite.agentStatus = 'idle';
  manager.reevaluateGroupQueues();
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(manager.isRunning('dependent'), true);
  assert.equal(aborts, 0);
  assert.match((await manager.getEvents('dependent'))[0].content, /Dependency inconsistency while running/);
});


test('legacy queue does not reserve a child while prerequisite reset holds admission lock', async () => {
  const f = fixture();
  const task = f.make('dependent', { groupId: 'group' });
  const prerequisite = f.make('a', { columnId: 'done', agentStatus: 'complete' });
  f.edges.set(task.id, ['a']);
  const manager = new AgentManager(); manager.initEventPersistence(f.repo);
  let launches = 0;
  Object.assign(manager, { startAgentChecked: () => { launches++; } });
  let release!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; });
  const reset = withDependencyAdmissionLock(async () => { await wait; prerequisite.agentStatus = 'idle'; });
  manager.startGroup({ id: 'group', maxConcurrency: 1 } as Parameters<AgentManager['startGroup']>[0], [task], () => () => {}, () => () => {}, () => {});
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(manager.isGroupChildRunning('group', task.id), false);
  release(); await reset;
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(launches, 0);
  assert.equal(manager.isGroupChildRunning('group', task.id), false);
  assert.equal(manager.isGroupRunning('group'), true);
});


test('successful read-only prerequisite in a project requires no repository integration', async () => {
  const f = fixture(); f.make('dependent', { repoPath: process.cwd() });
  f.make('a', { repoPath: process.cwd(), useWorktree: false, columnId: 'done', agentStatus: 'complete' });
  f.edges.set('dependent', ['a']);
  assert.equal((await getTaskDependencyGate(f.repo, 'dependent')).eligible, true);
});

test('stop cancels pending admission but a fresh immediate retry is admitted', async () => {
  const f = fixture(); const task = f.make('retry');
  const manager = new AgentManager(); manager.initEventPersistence(f.repo);
  let launches = 0;
  Object.assign(manager, { startAgentChecked: () => { launches++; } });
  let release!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; });
  const blocker = withDependencyAdmissionLock(async () => { await wait; });
  manager.startAgent(task, () => {});
  assert.equal(await manager.stopAgent(task.id), true, 'pending admission is a successful stop');
  assert.equal(await manager.stopAgent(task.id), false, 'already stopped admission is no longer active');
  manager.startAgent(task, () => {});
  release(); await blocker;
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(launches, 1, 'only the fresh retry launches, without waiting for a stopped-task TTL');
});

test('late failure from a stopped session cannot settle or remove an immediate retry', async () => {
  const f = fixture(); const task = f.make('retry-session', { agentType: 'copilot' });
  const manager = new AgentManager();
  const failures: Array<(error: Error) => void> = [];
  Object.assign(manager, {
    availableAgents: [{ name: 'copilot', available: true }],
    providers: new Map([['copilot', { displayName: 'Test', stop: async () => {}, createSession: async () => ({
      execute: () => new Promise((_resolve, reject) => { failures.push(reject); }),
      abort: async () => {}, destroy: async () => {},
    }) }]]),
  });
  const statuses: string[] = [];
  try {
    manager.startAgent(task, status => { statuses.push(status); });
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(failures.length, 1);
    await manager.stopAgent(task.id);
    manager.startAgent(task, status => { statuses.push(status); });
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(failures.length, 2);
    failures[0](new Error('Old aborted execution failed late'));
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(manager.isRunning(task.id), true);
    assert.equal(statuses.includes('failed'), false);
  } finally { manager.shutdownAll(); }
});

test('implicit ordered predecessors are rechecked after reset without inventing editable dependencies', async () => {
  const f = fixture();
  const predecessor = f.make('first', { groupId: 'ordered', columnId: 'done', agentStatus: 'complete' });
  const dependent = f.make('second', { groupId: 'ordered' });
  f.repo.getOrderedGroupTasks = async () => [predecessor, dependent];
  assert.equal((await getTaskDependencyGate(f.repo, dependent.id)).eligible, true);
  predecessor.agentStatus = 'idle';
  const gate = await getTaskDependencyGate(f.repo, dependent.id);
  assert.equal(gate.eligible, false);
  assert.deepEqual(gate.dependencies, []);
  assert.match(gate.reason!, /ordered predecessor first/);
  const manager = new AgentManager(); manager.initEventPersistence(f.repo);
  let starts = 0;
  Object.assign(manager, { startAgentChecked: () => { starts++; } });
  manager.startAgent(dependent, () => {});
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(starts, 0);
  assert.equal(manager.isRunning(dependent.id), false);
});


test('cycle validation includes implicit group order and cross-group paths', async () => {
  const f = fixture();
  const first = f.make('first', { groupId: 'ordered' });
  const second = f.make('second', { groupId: 'ordered' });
  f.make('external', { groupId: 'other' });
  f.repo.getOrderedGroupTasks = async id => id === 'ordered' ? [first, second] : undefined;
  await assert.rejects(() => assertDependencyDoesNotCycle(f.repo, second.id, first.id), /cycle/);
  f.edges.set('external', [second.id]);
  await assert.rejects(() => assertDependencyDoesNotCycle(f.repo, 'external', first.id), /cycle/);
  await assertDependencyDoesNotCycle(f.repo, first.id, 'external');
});


test('stop route accepts pending planning admission and clears durable run intent', async () => {
  const f = fixture();
  const task = f.make('stop-pending-route', { agentStatus: 'planning', runRequestedAt: 1, runClaimedAt: 2 });
  f.repo.clearRun = async () => { delete task.runRequestedAt; delete task.runClaimedAt; return task; };
  f.repo.update = async (_id, changes) => Object.assign(task, changes);
  const manager = new AgentManager(); manager.initEventPersistence(f.repo);
  let starts = 0;
  Object.assign(manager, { startAgentChecked: () => { starts++; } });
  let release!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; });
  const blocker = withDependencyAdmissionLock(async () => { await wait; });
  manager.startAgent(task, () => {});
  try {
    const router = createAgentRouter(f.repo, manager);
    const layer = (router as any).stack.find((entry: any) => entry.route?.path === '/:id/stop');
    const response = await new Promise<{ status: number; task: Task }>((resolve, reject) => {
      let status = 200;
      const res = { status(value: number) { status = value; return this; }, json(value: Task) { resolve({ status, task: value }); } };
      layer.route.stack[0].handle({ params: { id: task.id } }, res, reject);
    });
    assert.equal(response.status, 200);
    assert.equal(response.task.agentStatus, 'failed');
    assert.equal(response.task.runRequestedAt, undefined);
    assert.equal(response.task.runClaimedAt, undefined);
  } finally { release(); await blocker; }
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(starts, 0);
});
