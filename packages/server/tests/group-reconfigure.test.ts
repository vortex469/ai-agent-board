import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import { migrateSqliteDatabase } from '../src/db.js';
import { SqliteTaskRepository } from '../src/repositories/sqlite.js';
import { SqliteTaskGroupRepository } from '../src/repositories/sqlite-groups.js';
import { SqliteProjectRepository } from '../src/repositories/sqlite-projects.js';
import { createGroupsRouter } from '../src/routes/groups.js';
import { tickProjectAutoRun } from '../src/routes/projects.js';
import { AgentManager } from '../src/services/agent-manager.js';
import type { Task } from '../src/types.js';

async function fixture() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys=ON');
  migrateSqliteDatabase(db);
  const taskRepo = new SqliteTaskRepository(db);
  const groupRepo = new SqliteTaskGroupRepository(db);
  const projectRepo = new SqliteProjectRepository(db);
  await projectRepo.update('default', { autoRunEnabled: true, updatedAt: Date.now() });
  const started: Task[] = [];
  const running = new Set<string>();
  const callbacks = new Map<string, (status: Task['agentStatus']) => Promise<void>>();
  const manager = Object.assign(new AgentManager(), {
    isRunning: (id: string) => running.has(id), isGroupRunning: () => false,
    getAvailableAgents: () => ['copilot', 'codex', 'hermes'].map(name => ({ name, available: true })),
    startAgent: (task: Task, cb: (status: Task['agentStatus']) => Promise<void>) => { started.push(task); running.add(task.id); callbacks.set(task.id, cb); },
    startAgentChecked: (task: Task, cb: (status: Task['agentStatus']) => Promise<void>) => { started.push(task); running.add(task.id); callbacks.set(task.id, cb); },
    stopGroup: async () => {},
    resetEvents: async (id: string) => { await taskRepo.deleteEventsByTaskId(id); },
  }) as unknown as AgentManager;
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
  return { db, taskRepo, groupRepo, projectRepo, started, running, callbacks, manager, request, close };
}

const children = Array.from({ length: 6 }, (_, i) => ({ title: `Step ${i}`, description: `  Full description ${i}\n intact  `, agentType: 'copilot', useWorktree: false, dependsOnTaskIndexes: i ? [i - 1] : [] }));

async function create(f: Awaited<ReturnType<typeof fixture>>, roadmap = true) {
  const response = await f.request('', { title: 'Reconfigure', ...(roadmap ? { roadmapExecutionMode: 'backlog' } : {}), maxConcurrency: 1, baseBranch: 'main', children });
  assert.equal(response.status, 201, JSON.stringify(await response.json()));
  const group = await response.json();
  // Seed repository settings directly so this configuration test is independent
  // of the host's configured path whitelist.
  await f.groupRepo.update(group.id, { repoPath: process.cwd() });
  for (const child of group.children) await f.taskRepo.update(child.id, { repoPath: process.cwd() });
  return { ...(await f.groupRepo.getById(group.id)), children: await f.groupRepo.getChildTasks(group.id) };
}

test('six Copilot children become Codex without losing content, ordering, dependencies or execution configuration', async () => {
  const f = await fixture();
  try {
    const group = await create(f);
    const before = await f.groupRepo.getChildTasks(group.id);
    const relationships = await Promise.all(before.map(child => f.taskRepo.getRelationships(child.id)));
    const response = await f.request(`/${group.id}/reconfigure`, { agentType: 'codex', priority: 'critical', timeoutMinutes: 90 });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).updatedCount, 6);
    const after = await f.groupRepo.getChildTasks(group.id);
    assert.deepEqual(after, before.map(child => ({ ...child, agentType: 'codex', priority: 'critical', timeoutMinutes: 90 })));
    assert.deepEqual(await Promise.all(after.map(child => f.taskRepo.getRelationships(child.id))), relationships);
    assert.deepEqual(f.started, []);
    assert.deepEqual(await f.groupRepo.getById(group.id), Object.fromEntries(Object.entries(group).filter(([key]) => key !== 'children')));
    const project = (await f.projectRepo.getDefault())!;
    assert.equal((await tickProjectAutoRun({ project, orderedBacklogIds: [group.id], taskRepo: f.taskRepo, groupRepo: f.groupRepo, agentManager: f.manager })).started, true);
    assert.equal(f.started[0].agentType, 'codex');
    assert.equal(f.started[0].timeoutMinutes, 90);
    f.running.clear();
    await f.taskRepo.update(after[0].id, { columnId: 'done', agentStatus: 'complete' });
    assert.equal((await tickProjectAutoRun({ project, orderedBacklogIds: [group.id], taskRepo: f.taskRepo, groupRepo: f.groupRepo, agentManager: f.manager })).started, true);
    assert.equal(f.started[1].agentType, 'codex');
  } finally { await f.close(); }
});

test('bulk update excludes completed, running, failed and review children and rejects stale selections atomically', async () => {
  const f = await fixture();
  try {
    const group = await create(f);
    const ids = group.children.map((child: Task) => child.id);
    await f.taskRepo.update(ids[0], { columnId: 'done', agentStatus: 'complete', completedAt: 10 });
    await f.taskRepo.update(ids[1], { columnId: 'in-progress', agentStatus: 'executing', startedAt: 10 });
    await f.taskRepo.update(ids[2], { agentStatus: 'failed' });
    await f.taskRepo.update(ids[3], { columnId: 'review', agentStatus: 'idle' });
    await f.taskRepo.update(ids[4], { agentType: 'hermes' });
    const before = await f.groupRepo.getChildTasks(group.id);
    assert.equal((await f.request(`/${group.id}/reconfigure`, { agentType: 'codex', taskIds: [ids[4], ids[0]] })).status, 409);
    assert.deepEqual(await f.groupRepo.getChildTasks(group.id), before);
    const response = await f.request(`/${group.id}/reconfigure`, { agentType: 'codex' });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).updatedCount, 2);
    const after = await f.groupRepo.getChildTasks(group.id);
    assert.deepEqual(after.slice(0, 4), before.slice(0, 4));
    assert.ok(after.slice(4).every(child => child.agentType === 'codex'));
    assert.deepEqual(f.started, []);
  } finally { await f.close(); }
});

test('selected updates and timeout reset preserve unselected children; invalid settings have no side effects', async () => {
  const f = await fixture();
  try {
    const group = await create(f);
    const ids = group.children.map((child: Task) => child.id);
    for (const body of [{}, { agentType: 'missing' }, { priority: 'bad' }, { timeoutMinutes: 0 }, { timeoutMinutes: 241 }, { timeoutMinutes: 1.5 }, { agentType: 'codex', taskIds: [] }, { agentType: 'codex', taskIds: [ids[0], ids[0]] }, { description: 'replace', agentType: 'codex' }]) {
      assert.equal((await f.request(`/${group.id}/reconfigure`, body)).status, 400);
    }
    assert.deepEqual(await f.groupRepo.getChildTasks(group.id), group.children);
    assert.equal((await f.request(`/${group.id}/reconfigure`, { taskIds: [ids[1], ids[4]], agentType: 'codex', timeoutMinutes: 10 })).status, 200);
    assert.equal((await f.request(`/${group.id}/reconfigure`, { taskIds: [ids[1]], timeoutMinutes: null })).status, 200);
    const after = await f.groupRepo.getChildTasks(group.id);
    assert.equal(after[1].timeoutMinutes, undefined);
    assert.equal(after[4].timeoutMinutes, 10);
    for (const i of [0, 2, 3, 5]) assert.deepEqual(after[i], group.children[i]);
    f.running.add(ids[0]);
    assert.equal((await f.request(`/${group.id}/reconfigure`, { taskIds: [ids[0]], agentType: 'codex' })).status, 409);
    await f.taskRepo.update(ids[0], { runClaimedAt: 1 });
    f.running.clear();
    assert.equal((await f.request(`/${group.id}/reconfigure`, { taskIds: [ids[0]], agentType: 'codex' })).status, 409);
    await f.groupRepo.update(group.id, { archived: true });
    assert.equal((await f.request(`/${group.id}/reconfigure`, { agentType: 'codex' })).status, 409);
  } finally { await f.close(); }
});

test('legacy queue waits during reconfiguration and launches refreshed pending agent settings', async () => {
  const f = await fixture();
  try {
    const group = await create(f, false);
    const children = await f.groupRepo.getChildTasks(group.id);
    f.manager.startGroup(group, children, task => async status => { await f.taskRepo.update(task.id, { agentStatus: status }); }, () => async () => {}, async () => {});
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.started.length, 1);
    const first = f.started[0];
    // A queue reservation protects startup even before an SDK session/status exists.
    f.running.clear();
    const persist = f.taskRepo.reconfigureGroupChildren.bind(f.taskRepo);
    let entered!: () => void;
    let release!: () => void;
    const saving = new Promise<void>(resolve => { entered = resolve; });
    const resume = new Promise<void>(resolve => { release = resolve; });
    f.taskRepo.reconfigureGroupChildren = async (...args) => {
      entered();
      await resume;
      return persist(...args);
    };
    const request = f.request(`/${group.id}/reconfigure`, { agentType: 'codex', timeoutMinutes: 15 });
    await saving;
    await f.callbacks.get(first.id)!('complete');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.started.length, 1, 'queue admission stays paused while persistence is pending');
    release();
    const response = await request;
    assert.equal(response.status, 200);
    assert.equal((await response.json()).updatedCount, 5);
    assert.equal((await f.taskRepo.getById(first.id))?.agentType, 'copilot');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.started.length, 2);
    assert.equal(f.started[1].agentType, 'codex');
    assert.equal(f.started[1].timeoutMinutes, 15);
  } finally { await f.close(); }
});

test('repository bulk update rolls back when any selected task is no longer eligible', async () => {
  const f = await fixture();
  try {
    const group = await create(f);
    const ids = group.children.map((child: Task) => child.id);
    await f.taskRepo.update(ids[1], { startedAt: 1 });
    await assert.rejects(f.taskRepo.reconfigureGroupChildren(group.id, ids, { agentType: 'codex' }), /no longer pending/);
    assert.ok((await f.groupRepo.getChildTasks(group.id)).every(child => child.agentType === 'copilot'));
  } finally { await f.close(); }
});

test('ordered Auto Run waits for a concurrent configuration save and reads the new agent', async () => {
  const f = await fixture();
  try {
    const group = await create(f);
    const persist = f.taskRepo.reconfigureGroupChildren.bind(f.taskRepo);
    let entered!: () => void;
    let release!: () => void;
    const saving = new Promise<void>(resolve => { entered = resolve; });
    const resume = new Promise<void>(resolve => { release = resolve; });
    f.taskRepo.reconfigureGroupChildren = async (...args) => { entered(); await resume; return persist(...args); };
    const request = f.request(`/${group.id}/reconfigure`, { agentType: 'codex' });
    await saving;
    const admission = tickProjectAutoRun({ project: (await f.projectRepo.getDefault())!, orderedBacklogIds: [group.id], taskRepo: f.taskRepo, groupRepo: f.groupRepo, agentManager: f.manager });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(f.started, []);
    release();
    assert.equal((await request).status, 200);
    assert.equal((await admission).started, true);
    assert.equal(f.started[0].agentType, 'codex');
  } finally { await f.close(); }
});
