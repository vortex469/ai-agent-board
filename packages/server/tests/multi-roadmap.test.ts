import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { migrateSqliteDatabase } from '../src/db.js';
import { SqliteTaskRepository } from '../src/repositories/sqlite.js';
import { SqliteTaskGroupRepository } from '../src/repositories/sqlite-groups.js';
import { importRoadmap } from '../src/services/roadmap-import.js';
import { parseRoadmapText } from '../src/services/roadmap-intake.js';
import { validateRoadmapGroups } from '../src/services/multi-roadmap.js';
import type { RoadmapProposedGroup } from '@ai-agent-board/shared/types.js';

function parse(text: string) {
  const parsed = parseRoadmapText(text, 'multi-group');
  assert.notEqual(typeof parsed, 'string');
  return (parsed as { groups: RoadmapProposedGroup[] }).groups;
}
const source = `GROUP: v0.11 Base Building
AGENT: codex
AUTO RUN: true
01. Foundation
04. Integration
DEPENDS ON: 01
GROUP: v0.12 Advanced Crafting & Workstations
01. Definitions
04. Workstations
DEPENDS ON: v0.11 Base Building / 04, 01`;
function fixture() {
  const db = new Database(':memory:'); migrateSqliteDatabase(db);
  return { db, tasks: new SqliteTaskRepository(db), groups: new SqliteTaskGroupRepository(db), project: { id: 'default', name: 'Default', isDefault: true, createdAt: 1, updatedAt: 1 } };
}
for (const count of [2, 3]) test(`${count}-group import preserves order, stable IDs and multiple dependency links`, async () => {
  const f = fixture();
  try {
    const roadmap = parse(source + (count === 3 ? '\nGROUP: v0.13 Finish\n01. Ship\nDEPENDS ON: v0.11 Base Building / 04, v0.12 Advanced Crafting & Workstations / 04' : ''));
    const result = await importRoadmap(f.project, roadmap, f.groups, f.tasks);
    assert.equal(result.groups.length, count);
    assert.deepEqual(result.groups[0].children.map(t => t.groupOrder), [0, 1]);
    const dep = await f.tasks.getRelationships(result.groups[1].children[1].id);
    assert.deepEqual(new Set(dep.filter(d => d.direction === 'blocked-by').map(d => d.relatedTaskId)), new Set([result.groups[0].children[1].id, result.groups[1].children[0].id]));
    for (const t of result.tasks) assert.ok(await f.tasks.getById(t.id));
    assert.equal((await f.tasks.getById(result.tasks[0].id))?.provenance?.origin?.roadmapAutoRun, true);
    if (count === 3) assert.equal((await f.tasks.getRelationships(result.groups[2].children[0].id)).length, 2);
  } finally { f.db.close(); }
});
for (const [name, text, pattern] of [
  ['empty declaration', 'GROUP: A\n01. Task\nGROUP:\n02. Other', /Group title is required/],
  ['empty task', 'GROUP: A\n01. Task\n02.', /Task title is required/],
  ['bad group', source.replace('v0.11 Base Building / 04', 'Missing / 04'), /Unknown group/],
  ['bad task', source.replace('v0.11 Base Building / 04', 'v0.11 Base Building / 09'), /Unknown task/],
  ['self', 'GROUP: A\n01. A\nDEPENDS ON: 1', /Self dependency/],
  ['duplicate group', 'GROUP: A\n01. A\nGROUP: a\n01. B', /Duplicate ambiguous group/],
  ['duplicate task', 'GROUP: A\n01. A\n1. B', /Duplicate ambiguous task/],
  ['duplicate dependency aliases', 'GROUP: A\n01. A\n02. B\nDEPENDS ON: 01, A / 1', /Duplicate ambiguous dependency/],
  ['ordering cycle', 'GROUP: A\n01. A\nDEPENDS ON: 02\n02. B', /cycle/],
  ['cross cycle', 'GROUP: A\n01. A\nDEPENDS ON: B / 01\nGROUP: B\n01. B\nDEPENDS ON: A / 01', /cycle/],
  ['empty dependency', 'GROUP: A\n01. A\nDEPENDS ON:', /requires references/],
] as const) test(`rejects ${name} before creation`, () => assert.match(String(parseRoadmapText(text, 'multi-group')), pattern));
for (const phase of ['create', 'dependency', 'arm'] as const) test(`partial import rollback on ${phase} failure`, async () => {
  const f = fixture();
  try {
    if (phase === 'create') {
      const original = f.groups.create.bind(f.groups); let calls = 0;
      f.groups.create = async (...args) => { if (++calls === 2) throw new Error('injected'); return original(...args); };
    } else if (phase === 'dependency') f.tasks.createDependency = async () => { throw new Error('injected'); };
    else { const original = f.groups.update.bind(f.groups); let calls = 0; f.groups.update = async (...args) => { if (++calls === 2) throw new Error('injected'); return original(...args); }; }
    await assert.rejects(importRoadmap(f.project, parse(source), f.groups, f.tasks), /rolled back/);
    assert.equal((await f.groups.getAll()).length, 0); assert.equal(await f.tasks.count(), 0);
  } finally { f.db.close(); }
});
test('rejects existing duplicate groups and invalid edited payloads without creating anything else', async () => {
  const f = fixture();
  try {
    await importRoadmap(f.project, parse(source), f.groups, f.tasks);
    await assert.rejects(importRoadmap(f.project, parse(source), f.groups, f.tasks), /already exists/);
    assert.equal((await f.groups.getAll()).length, 2);
    const edited = parse(source); edited[1].tasks[1].dependencies = ['Missing / 01'];
    assert.match(String(validateRoadmapGroups(edited)), /Unknown group/);
  } finally { f.db.close(); }
});
test('rollback failure reports surviving IDs explicitly', async () => {
  const f = fixture();
  try {
    f.tasks.createDependency = async () => { throw new Error('injected'); };
    f.groups.delete = async () => false;
    await assert.rejects(importRoadmap(f.project, parse(source), f.groups, f.tasks), /rollback incomplete for group IDs.+Manual cleanup/);
  } finally { f.db.close(); }
});

test('arming rollback holds dependency admission until all staged groups are gone', async () => {
  const { withDependencyAdmissionLock } = await import('../src/services/task-dependencies.js');
  const f = fixture();
  let observed: Promise<number> | undefined;
  const update = f.groups.update.bind(f.groups); let calls = 0;
  f.groups.update = async (...args) => {
    if (++calls === 2) {
      observed = withDependencyAdmissionLock(() => f.tasks.count());
      throw new Error('arming failed');
    }
    return update(...args);
  };
  try {
    await assert.rejects(importRoadmap(f.project, parse(source), f.groups, f.tasks), /rolled back/);
    assert.equal(await observed, 0);
  } finally { f.db.close(); }
});

test('PostgreSQL persists imported Auto Run override on update and read', async () => {
  const { PostgresTaskRepository } = await import('../src/repositories/postgres.js');
  const provenance = { origin: { roadmapAutoRun: false } };
  const row = { id: 'task', project_id: 'default', title: 'Task', description: '', priority: 'medium', column_id: 'backlog', agent_status: 'idle', agent_type: 'codex', created_at: 1, provenance: JSON.stringify(provenance) };
  let persisted: unknown;
  const query = async (sql: string, args?: unknown[]) => { if (sql.includes('provenance=$22')) persisted = args?.[21]; return { rows: [row], rowCount: 1 }; };
  const repo = new PostgresTaskRepository({ query, connect: async () => ({ query, release() {} }) } as never);
  await repo.update('task', { provenance });
  assert.deepEqual(JSON.parse(String(persisted)), provenance);
  assert.deepEqual((await repo.getById('task'))?.provenance, provenance);
});

test('persisted group children retain Auto Run overrides and gated manual run intent', async () => {
  const f = fixture();
  try {
    const result = await importRoadmap(f.project, parse(source), f.groups, f.tasks);
    const child = result.groups[1].children[0];
    await f.tasks.requestRun(child.id, 123);
    const persisted = (await f.groups.getChildTasks(child.groupId!))[0];
    assert.equal(persisted.runRequestedAt, 123);
    assert.equal(persisted.provenance?.origin?.roadmapAutoRun, false);
  } finally { f.db.close(); }
});

test('PostgreSQL group children retain persisted automatic and manual admission settings', async () => {
  const { PostgresTaskGroupRepository } = await import('../src/repositories/postgres-groups.js');
  const row = { id: 'child', project_id: 'default', title: 'Child', description: '', priority: 'medium', column_id: 'backlog', agent_status: 'idle', created_at: 1, run_requested_at: '123', run_claimed_at: null, provenance: JSON.stringify({ origin: { roadmapAutoRun: false } }) };
  const repo = new PostgresTaskGroupRepository({ query: async () => ({ rows: [row] }) } as never);
  const [child] = await repo.getChildTasks('group');
  assert.equal(child.runRequestedAt, 123);
  assert.equal(child.runClaimedAt, undefined);
  assert.equal(child.provenance?.origin?.roadmapAutoRun, false);
});
