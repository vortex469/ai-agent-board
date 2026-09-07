import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import { migrateSqliteDatabase, initPostgresDatabase } from '../src/db.js';
import { SqliteTaskRepository } from '../src/repositories/sqlite.js';
import { PostgresTaskRepository } from '../src/repositories/postgres.js';

const baseline = { startCommit: 'a'.repeat(40), predecessorTaskId: 'p1', predecessorBranch: 'chain/p1', predecessorCommit: 'a'.repeat(40), resultCommit: 'b'.repeat(40) };

test('SQLite preserves immutable baseline through migration, create, claim and status updates', async () => {
  const db = new Database(':memory:');
  try {
    migrateSqliteDatabase(db);
    const repo = new SqliteTaskRepository(db);
    await repo.create({ id: 'p2', projectId: 'default', title: 'P2', description: '', priority: 'medium', columnId: 'backlog', agentStatus: 'idle', createdAt: 1, repositoryBaseline: baseline });
    migrateSqliteDatabase(db);
    await repo.requestRun('p2', 1);
    assert.deepEqual((await repo.claimRun('p2', 2))?.repositoryBaseline, baseline);
    await repo.update('p2', { agentStatus: 'complete' });
    assert.deepEqual((await repo.getById('p2'))?.repositoryBaseline, baseline);
  } finally { db.close(); }
});

test('PostgreSQL baseline is mapped on read/claim and persisted by updates', async () => {
  const row = { id: 'p2', project_id: 'default', title: 'P2', description: '', priority: 'medium', column_id: 'backlog', agent_status: 'idle', agent_type: 'hermes', created_at: 1, repository_baseline: JSON.stringify(baseline) };
  const queries: Array<{ sql: string; args?: unknown[] }> = [];
  const query = async (sql: string, args?: unknown[]) => { queries.push({ sql, args }); return { rows: [row], rowCount: 1 }; };
  const pool = { query, connect: async () => ({ query, release() {} }) };
  const repo = new PostgresTaskRepository(pool as never);
  assert.deepEqual((await repo.getById('p2'))?.repositoryBaseline, baseline);
  assert.deepEqual((await repo.claimRun('p2', 2))?.repositoryBaseline, baseline);
  await repo.update('p2', { repositoryBaseline: { ...baseline, resultCommit: 'c'.repeat(40) } });
  const update = queries.find(call => call.sql.includes('repository_baseline=$21'));
  assert.equal(JSON.parse(String(update?.args?.[20])).resultCommit, 'c'.repeat(40));
});

test('PostgreSQL installs the baseline column idempotently', async () => {
  const sql: string[] = [];
  await initPostgresDatabase({ query: async (query: string) => { sql.push(query); return { rows: [], rowCount: 0 }; } } as never);
  assert.ok(sql.some(query => query.includes('ALTER TABLE tasks ADD COLUMN repository_baseline TEXT')));
});
