import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import { migrateSqliteDatabase } from '../src/db.js';
import { PostgresTaskRepository } from '../src/repositories/postgres.js';
import { SqliteTaskRepository } from '../src/repositories/sqlite.js';
import type { Task } from '../src/types.js';

function fixture() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys=ON');
  migrateSqliteDatabase(db);
  for (const id of ['group-a', 'group-b', 'group-c']) {
    db.prepare('INSERT INTO task_groups(id,project_id,title,created_at) VALUES (?, ?, ?, ?)').run(id, 'default', id, 1);
  }
  return { db, repo: new SqliteTaskRepository(db) };
}
const task = (id: string, groupId = 'group-a'): Task => ({
  id, projectId: 'default', groupId, title: id, description: '', priority: 'medium',
  columnId: 'backlog', agentStatus: 'idle', agentType: 'hermes', createdAt: 1,
});

test('stable IDs support same-group and multiple cross-group edges, reject missing, self and multi-group cycles', async () => {
  const { db, repo } = fixture();
  try {
    for (const [id, group] of [['a', 'group-a'], ['a2', 'group-a'], ['b', 'group-b'], ['c', 'group-c']]) await repo.create(task(id, group));
    await repo.createDependency('a', 'a2', 1);
    await repo.createDependency('a2', 'b', 2);
    await repo.createDependency('b', 'c', 3);
    await repo.createDependency('a', 'c', 4);
    assert.deepEqual((await repo.getRelationships('c')).map((edge) => edge.relatedTaskId), ['b', 'a']);
    await assert.rejects(repo.createDependency('a2', 'a', 5), /cycle/);
    await assert.rejects(repo.createDependency('c', 'a', 5), /cycle/);
    await assert.rejects(repo.createDependency('missing', 'c', 5), /must exist/);
    await assert.rejects(repo.createDependency('a', 'a', 5), /itself/);
    assert.equal((await repo.createDependency('a', 'a2', 6)).created, false);
  } finally { db.close(); }
});

test('atomic claims require every prerequisite done and successful; reset, blocked, failed, missing never unlock', async () => {
  const { db, repo } = fixture();
  try {
    await repo.create(task('a')); await repo.create(task('b', 'group-b')); await repo.create(task('c', 'group-c'));
    await repo.createDependency('a', 'c', 1); await repo.createDependency('b', 'c', 2);
    await repo.requestRun('c', 100);
    for (const status of ['idle', 'failed', 'blocked', 'stopped', 'cancelled', 'needs-human', 'complete']) {
      db.prepare('UPDATE tasks SET agent_status=?, column_id=? WHERE id=?').run(status, status === 'complete' ? 'review' : 'done', 'a');
      assert.equal(await repo.claimRun('c', 101), undefined, status);
    }
    await repo.update('a', { agentStatus: 'complete', columnId: 'done' });
    assert.equal(await repo.claimRun('c', 101), undefined);
    await repo.update('b', { agentStatus: 'complete', columnId: 'done' });
    assert.equal((await repo.claimRun('c', 101))?.runClaimedAt, 101);
    await repo.clearRun('c'); await repo.requestRun('c', 102);
    await repo.update('a', { agentStatus: 'idle', columnId: 'backlog' });
    assert.equal(await repo.claimRun('c', 103), undefined);
    await repo.delete('a');
    assert.equal((await repo.getRelationships('c')).length, 2);
    assert.equal(await repo.claimRun('c', 103), undefined);
  } finally { db.close(); }
});

test('queued dependencies are editable but claimed and executing tasks reject edge changes', async () => {
  const { db, repo } = fixture();
  try {
    await repo.create(task('a')); await repo.create(task('b', 'group-b'));
    await repo.requestRun('b', 100);
    await repo.createDependency('a', 'b', 1);
    await repo.deleteRelationship('a', 'b');
    await repo.claimRun('b', 101);
    await assert.rejects(repo.createDependency('a', 'b', 1), /running or reserved/);
    await repo.clearRun('b'); await repo.createDependency('a', 'b', 1);
    await repo.update('b', { agentStatus: 'executing' });
    await assert.rejects(repo.deleteRelationship('a', 'b'), /running or reserved/);
    assert.equal((await repo.getRelationships('b')).length, 1);
  } finally { db.close(); }
});

test('legacy dependency migration preserves edges, tolerates repeat startup and retains deleted prerequisites', async () => {
  const { db, repo } = fixture();
  try {
    await repo.create(task('a')); await repo.create(task('b', 'group-b'));
    db.exec(`DROP TABLE task_dependencies;
      CREATE TABLE task_dependencies(prerequisite_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      dependent_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, created_at INTEGER NOT NULL,
      PRIMARY KEY(prerequisite_task_id, dependent_task_id));
      INSERT INTO task_dependencies VALUES ('a', 'b', 42);`);
    migrateSqliteDatabase(db); migrateSqliteDatabase(db);
    assert.equal((await repo.getRelationships('b'))[0].createdAt, 42);
    // Group deletion must preserve an external prerequisite gate too.
    db.prepare('DELETE FROM task_groups WHERE id=?').run('group-a');
    assert.equal(await repo.getById('a'), undefined);
    assert.equal((await repo.getRelationships('b'))[0].relatedTaskId, 'a');
    assert.deepEqual(db.pragma('foreign_key_check'), []);
    await repo.delete('b');
    assert.equal((db.prepare('SELECT * FROM task_dependencies').all()).length, 0);
  } finally { db.close(); }
});

test('PostgreSQL rejects a cycle inside the graph lock and rolls back before any insertion', async () => {
  const calls: string[] = [];
  let released = false;
  const client = {
    query: async (sql: string) => {
      calls.push(sql);
      if (sql.startsWith('SELECT dependent.*')) return { rows: [{ agent_status: 'idle', run_claimed_at: null }] };
      if (sql.startsWith('WITH RECURSIVE')) return { rows: [{ exists: 1 }] };
      return { rows: [] };
    },
    release: () => { released = true; },
  };
  const repo = new PostgresTaskRepository({ connect: async () => client } as never);
  await assert.rejects(repo.createDependency('a', 'c', 1), /cycle/);
  assert.equal(calls[0], 'BEGIN');
  assert.match(calls[1], /pg_advisory_xact_lock/);
  assert.match(calls[2], /FOR UPDATE OF dependent/);
  assert.equal(calls.some((sql) => sql.startsWith('INSERT')), false);
  assert.equal(calls.at(-1), 'ROLLBACK');
  assert.equal(released, true);
});

test('PostgreSQL claims lock graph and prerequisites before an authoritative fresh gate check', async () => {
  const calls: string[] = [];
  const client = {
    query: async (sql: string) => { calls.push(sql); return { rows: [] }; },
    release: () => undefined,
  };
  const repo = new PostgresTaskRepository({ connect: async () => client } as never);
  assert.equal(await repo.claimRun('dependent', 100), undefined);
  assert.equal(calls[0], 'BEGIN');
  assert.match(calls[1], /pg_advisory_xact_lock/);
  assert.match(calls[2], /FOR UPDATE OF p/);
  assert.match(calls[3], /p.id IS NULL OR p.agent_status IS DISTINCT FROM 'complete' OR p.column_id IS DISTINCT FROM 'done'/);
  assert.equal(calls.at(-1), 'COMMIT');
});
