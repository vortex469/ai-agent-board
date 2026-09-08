import { getTaskDependencyGate } from '../src/services/task-dependencies.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import { MAX_DESCRIPTION_LENGTH } from '@ai-agent-board/shared/constants.js';
import { migrateSqliteDatabase } from '../src/db.js';
import { SqliteTaskRepository } from '../src/repositories/sqlite.js';
import { SqliteTaskGroupRepository } from '../src/repositories/sqlite-groups.js';
import { SqliteProjectRepository } from '../src/repositories/sqlite-projects.js';
import { createGroupsRouter } from '../src/routes/groups.js';
import { tickProjectAutoRun } from '../src/routes/projects.js';
import type { AgentManager } from '../src/services/agent-manager.js';
import type { AgentEvent, Task } from '../src/types.js';

async function fixture() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys=ON');
  migrateSqliteDatabase(db);
  const taskRepo = new SqliteTaskRepository(db);
  const groupRepo = new SqliteTaskGroupRepository(db);
  const projectRepo = new SqliteProjectRepository(db);
  await projectRepo.update('default', { autoRunEnabled: true, updatedAt: Date.now() });
  const started: string[] = [];
  const callbacks = new Map<string, (status: Task['agentStatus']) => Promise<void>>();
  const manager = {
    isRunning: () => false, isGroupRunning: () => false,
    getAvailableAgents: () => [{ name: 'hermes', available: true }],
    startAgent: (task: Task, cb: (status: Task['agentStatus']) => Promise<void>) => { started.push(task.id); callbacks.set(task.id, cb); },
    stopGroup: async () => {},
    resetEvents: async (id: string) => { await taskRepo.deleteEventsByTaskId(id); },
  } as unknown as AgentManager;
  const router = createGroupsRouter(groupRepo, taskRepo, manager, projectRepo);
  const request = async (path: string, body: unknown, method = 'post') => {
    const routePath = path === '' ? '/' : '/:id' + (path.split('/')[2] ? '/' + path.split('/')[2] : '');
    const layer = (router as any).stack.find((entry: any) => entry.route?.path === routePath && entry.route.methods[method]);
    return new Promise<{ status: number; json: () => Promise<any> }>((resolve, reject) => {
      let status = 200;
      const response = { status(code: number) { status = code; return this; }, json(value: unknown) { resolve({ status, json: async () => value }); } };
      layer.route.stack[0].handle({ body, params: { id: path.split('/')[1] } }, response, reject);
    });
  };
  const close = async () => { db.close(); };
  return { db, taskRepo, groupRepo, projectRepo, started, callbacks, manager, request, close };
}

const children = Array.from({ length: 6 }, (_, index) => ({ title: `Feature ${String.fromCharCode(65 + index)}`, description: `  Complete body ${index}\n${'details '.repeat(1000)}\n  `, agentType: 'hermes', priority: 'high', useWorktree: false }));

test('roadmap group creates exactly six ordered children, preserves descriptions/defaults and persists reordering', async () => {
  const f = await fixture();
  try {
    const response = await f.request('', { title: 'v0.54', roadmapExecutionMode: 'backlog', children });
    assert.equal(response.status, 201);
    const group = await response.json();
    assert.equal((await f.groupRepo.getAll()).length, 1);
    assert.equal(await f.taskRepo.count(), 6);
    assert.equal((await f.taskRepo.getAll()).length, 0);
    assert.deepEqual(group.children.map((c: Task) => c.title), children.map(c => c.title));
    assert.deepEqual(group.children.map((c: Task) => c.description), children.map(c => c.description));
    assert.ok(group.children.every((c: Task) => c.agentType === 'hermes' && c.priority === 'high' && c.useWorktree === false));
    assert.equal((await f.groupRepo.getById(group.id))?.roadmapExecutionMode, 'backlog');
    const ids = group.children.map((c: Task) => c.id).reverse();
    const reordered = await f.request(`/${group.id}/reorder`, { orderedTaskIds: ids });
    assert.equal(reordered.status, 200);
    assert.deepEqual((await f.groupRepo.getChildTasks(group.id)).map(c => c.id), ids);
    const project = { ...(await f.projectRepo.getDefault())!, autoRunEnabled: true };
    const result = await tickProjectAutoRun({ project, orderedBacklogIds: [group.id], taskRepo: f.taskRepo, groupRepo: f.groupRepo, agentManager: f.manager });
    assert.equal(result.started, true);
    assert.deepEqual(f.started, [ids[0]]);
    await f.callbacks.get(ids[0])!('complete');
    assert.equal((await f.taskRepo.getById(ids[0]))?.columnId, 'review');
    const paused = await tickProjectAutoRun({ project, orderedBacklogIds: [group.id], taskRepo: f.taskRepo, groupRepo: f.groupRepo, agentManager: f.manager });
    assert.equal(paused.started, false);
    assert.deepEqual(f.started, [ids[0]]);
    await f.taskRepo.update(ids[0], { columnId: 'done' });
    await tickProjectAutoRun({ project, orderedBacklogIds: [group.id], taskRepo: f.taskRepo, groupRepo: f.groupRepo, agentManager: f.manager });
    assert.deepEqual(f.started, [ids[0], ids[1]]);
  } finally { await f.close(); }
});

test('group dependencies survive reorder and block Auto Run; failure also stops later children', async () => {
  const f = await fixture();
  try {
    const response = await f.request('', { title: 'Dependencies', roadmapExecutionMode: 'backlog', children: [children[0], { ...children[1], dependsOnTaskIndexes: [0] }] });
    const group = await response.json();
    const [first, second] = group.children as Task[];
    assert.equal((await f.taskRepo.getRelationships(second.id))[0].relatedTaskId, first.id);
    await f.request(`/${group.id}/reorder`, { orderedTaskIds: [second.id, first.id] });
    const args = { project: { ...(await f.projectRepo.getDefault())!, autoRunEnabled: true }, orderedBacklogIds: [group.id], taskRepo: f.taskRepo, groupRepo: f.groupRepo, agentManager: f.manager };
    assert.equal((await tickProjectAutoRun(args)).started, false);
    assert.deepEqual(f.started, []);
    await f.request(`/${group.id}/reorder`, { orderedTaskIds: [first.id, second.id] });
    await f.taskRepo.update(first.id, { agentStatus: 'failed' });
    assert.equal((await tickProjectAutoRun(args)).started, false);
    assert.deepEqual(f.started, []);
    assert.equal((await f.request(`/${group.id}/reorder`, { orderedTaskIds: [second.id, second.id] })).status, 400);
  } finally { await f.close(); }
});

test('first-card and full-roadmap start only the first child and preserve review fail-stop', async () => {
  for (const mode of ['first-card', 'full-roadmap']) {
    const f = await fixture();
    try {
      const response = await f.request('', { title: mode, roadmapExecutionMode: mode, children: children.slice(0, 2) });
      assert.equal(response.status, 201);
      const group = await response.json();
      assert.deepEqual(f.started, [group.children[0].id]);
      await f.callbacks.get(group.children[0].id)!('complete');
      assert.deepEqual(f.started, [group.children[0].id]);
    } finally { await f.close(); }
  }
});

async function passingCompletion(f: Awaited<ReturnType<typeof fixture>>, id: string) {
  await f.taskRepo.update(id, { useWorktree: true, repoPath: process.cwd(), branchName: 'agent/test', worktreePath: process.cwd() });
  const events: Array<Pick<AgentEvent, 'type' | 'content' | 'metadata'>> = [
    { type: 'test_result', content: 'Focused tests passed: all checks passed.', metadata: { state: 'succeeded' } },
    { type: 'complete', content: 'Hostile review passed: no regressions found.', metadata: { finalOutput: true } },
  ];
  for (const [index, event] of events.entries()) await f.taskRepo.insertEvent({ ...event, id: `${id}-${index}`, taskId: id, timestamp: Date.now() + index });
  await f.callbacks.get(id)!('complete');
}

test('full-roadmap blocks a legacy coding predecessor whose mocked merge has no recorded repository result', async () => {
  const f = await fixture();
  Object.assign(f.manager, { getMergeReadiness: () => ({ ready: true }), mergeLocal: async () => ({ baseBranch: 'main' }), removeWorktree: () => ({ status: 'removed' }) });
  try {
    const response = await f.request('', { title: 'Continuation', roadmapExecutionMode: 'full-roadmap', children: children.slice(0, 3) });
    const group = await response.json();
    const [first, second, third] = group.children as Task[];
    assert.equal((await f.request(`/${group.id}/reorder`, { orderedTaskIds: [third.id, second.id] })).status, 200);
    await passingCompletion(f, first.id);
    assert.equal((await f.taskRepo.getById(first.id))?.columnId, 'done');
    assert.deepEqual(f.started, [first.id]);
    assert.equal((await f.taskRepo.getById(third.id))?.columnId, 'backlog');
    const gate = await getTaskDependencyGate(f.taskRepo, third.id);
    assert.equal(gate.eligible, false);
    assert.match(gate.reason ?? '', /repository integration|repository result/);
  } finally { await f.close(); }
});

test('stopping, archiving and returning a roadmap group to backlog stops individually dispatched children', async () => {
  for (const action of ['stop', 'archive', 'backlog']) {
    const f = await fixture();
    const stopped: string[] = [];
    try {
      const response = await f.request('', { title: action, roadmapExecutionMode: 'full-roadmap', children: children.slice(0, 2) });
      const group = await response.json();
      Object.assign(f.manager, { isRunning: (id: string) => f.started.includes(id) && !stopped.includes(id), stopAgent: async (id: string) => { stopped.push(id); return true; } });
      const result = action === 'backlog'
        ? await f.request(`/${group.id}`, { columnId: 'backlog' }, 'patch')
        : await f.request(`/${group.id}/${action}`, {}, action === 'archive' ? 'patch' : 'post');
      assert.equal(result.status, 200);
      assert.deepEqual(stopped, [group.children[0].id]);
      if (action === 'backlog') assert.equal((await f.taskRepo.getById(group.children[0].id))?.columnId, 'backlog');
      assert.deepEqual(f.started, [group.children[0].id]);
    } finally { await f.close(); }
  }
});

test('turning Auto Run off during a full roadmap prevents continuation after successful completion', async () => {
  const f = await fixture();
  Object.assign(f.manager, { getMergeReadiness: () => ({ ready: true }), mergeLocal: async () => ({ baseBranch: 'main' }), removeWorktree: () => ({ status: 'removed' }) });
  try {
    const response = await f.request('', { title: 'Off means off', roadmapExecutionMode: 'full-roadmap', children: children.slice(0, 2) });
    const group = await response.json();
    await f.projectRepo.update('default', { autoRunEnabled: false, updatedAt: Date.now() });
    await passingCompletion(f, group.children[0].id);
    assert.equal((await f.taskRepo.getById(group.children[0].id))?.columnId, 'done');
    assert.deepEqual(f.started, [group.children[0].id]);
    assert.equal((await f.taskRepo.getById(group.children[1].id))?.columnId, 'backlog');
  } finally { await f.close(); }
});

test('single-item roadmap group defaults to serial execution without requiring maxConcurrency', async () => {
  const f = await fixture();
  try {
    const response = await f.request('', { title: 'Single milestone', roadmapExecutionMode: 'backlog', children: [children[0]] });
    assert.equal(response.status, 201);
    const group = await response.json();
    assert.equal(group.maxConcurrency, 1);
    assert.equal(group.children.length, 1);
    assert.equal((await f.groupRepo.getAll()).length, 1);
    assert.equal(await f.taskRepo.count(), 1);
    assert.deepEqual(f.started, []);
  } finally { await f.close(); }
});

test('invalid roadmap children are rejected before creating any group or tasks', async () => {
  const f = await fixture();
  try {
    const invalidChildren: Array<{ label: string; value: unknown }> = [
      { label: 'null children', value: null },
      { label: 'object children', value: {} },
      { label: 'empty children', value: [] },
      { label: 'null child', value: [null] },
      { label: 'non-object child', value: [42] },
      { label: 'missing title', value: [{}] },
      { label: 'overlength description', value: [{ ...children[0], description: 'x'.repeat(MAX_DESCRIPTION_LENGTH + 1) }] },
      { label: 'invalid agent', value: [{ ...children[0], agentType: 'unknown-agent' }] },
      { label: 'invalid priority', value: [{ ...children[0], priority: 'urgent' }] },
      { label: 'invalid worktree setting', value: [{ ...children[0], useWorktree: 'false' }] },
      { label: 'forward dependency', value: [{ ...children[0], dependsOnTaskIndexes: [1] }, children[1]] },
      { label: 'self dependency', value: [{ ...children[0], dependsOnTaskIndexes: [0] }] },
      { label: 'invalid dependency index', value: [children[0], { ...children[1], dependsOnTaskIndexes: ['0'] }] },
    ];
    for (const { label, value } of invalidChildren) {
      const response = await f.request('', { title: label, roadmapExecutionMode: 'backlog', children: value });
      assert.equal(response.status, 400, label);
      assert.equal((await f.groupRepo.getAll()).length, 0, `${label}: no group side effects`);
      assert.equal(await f.taskRepo.count(), 0, `${label}: no task side effects`);
      assert.deepEqual(f.started, [], `${label}: no agent dispatch`);
    }
  } finally { await f.close(); }
});

test('legacy group reorder API rejects changes and preserves legacy ordering', async () => {
  const f = await fixture();
  try {
    const response = await f.request('', { title: 'Legacy parallel group', children: children.slice(0, 2) });
    assert.equal(response.status, 201);
    const group = await response.json();
    assert.equal(group.roadmapExecutionMode, undefined);
    const ids = group.children.map((child: Task) => child.id);
    const reordered = await f.request(`/${group.id}/reorder`, { orderedTaskIds: [...ids].reverse() });
    assert.equal(reordered.status, 400);
    assert.deepEqual((await f.groupRepo.getChildTasks(group.id)).map(child => child.id), ids);
  } finally { await f.close(); }
});

test('explicit Run retries the failed first child while Auto Run remains stopped', async () => {
  const { startOrderedGroupChild } = await import('../src/services/ordered-group.js');
  const f = await fixture();
  try {
    const group = await (await f.request('', { title: 'Retry', roadmapExecutionMode: 'backlog', children: children.slice(0, 2) })).json();
    const first = group.children[0];
    await f.taskRepo.update(first.id, { agentStatus: 'failed', columnId: 'review' });
    await f.taskRepo.insertEvent({ id: 'old-evidence', taskId: first.id, type: 'output', content: 'Focused tests passed: stale run', timestamp: 1 });
    assert.equal(await startOrderedGroupChild(group.id, f.groupRepo, f.taskRepo, f.manager), undefined);
    assert.equal((await startOrderedGroupChild(group.id, f.groupRepo, f.taskRepo, f.manager, false, f.projectRepo, first.id))?.id, first.id);
    assert.deepEqual(f.started, [first.id]);
    assert.deepEqual(await f.taskRepo.getEventsByTaskId(first.id), []);
  } finally { await f.close(); }
});

test('central admission blocks restarting an earlier child while its successor runs', async () => {
  const { startAgentForTask } = await import('../src/routes/helpers.js');
  const { startOrderedGroupChild } = await import('../src/services/ordered-group.js');
  const f = await fixture();
  try {
    const group = await (await f.request('', { title: 'Concurrent retry', roadmapExecutionMode: 'backlog', children: children.slice(0, 2) })).json();
    const [first, second] = group.children;
    await f.taskRepo.update(first.id, { agentStatus: 'complete', columnId: 'done' });
    await startOrderedGroupChild(group.id, f.groupRepo, f.taskRepo, f.manager);
    await f.taskRepo.update(first.id, { agentStatus: 'idle', columnId: 'in-progress' });
    const requested = await f.taskRepo.requestRun(first.id, Date.now());
    await startAgentForTask(requested!, f.taskRepo, f.manager);
    assert.deepEqual(f.started, [second.id]);
    assert.match((await f.taskRepo.getEventsByTaskId(first.id)).map(e => e.content).join('\n'), /Another ordered group child is running/);
  } finally { await f.close(); }
});
