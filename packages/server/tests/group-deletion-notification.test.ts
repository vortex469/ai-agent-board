import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import { migrateSqliteDatabase } from '../src/db.js';
import { SqliteTaskRepository } from '../src/repositories/sqlite.js';
import { SqliteTaskGroupRepository } from '../src/repositories/sqlite-groups.js';
import { SqliteProjectRepository } from '../src/repositories/sqlite-projects.js';
import { createGroupsRouter } from '../src/routes/groups.js';
import { observeBroadcasts } from '../src/websocket.js';
import { getTaskDependencyGate } from '../src/services/task-dependencies.js';
import type { AgentManager } from '../src/services/agent-manager.js';
import type { Task, WSMessage } from '../src/types.js';

test('group deletion broadcasts after cascade persistence and retains a visible missing external gate', async () => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys=ON');
  migrateSqliteDatabase(db);
  const tasks = new SqliteTaskRepository(db);
  const groups = new SqliteTaskGroupRepository(db);
  const projects = new SqliteProjectRepository(db);
  const manager = { stopGroup: async () => undefined } as unknown as AgentManager;
  const messages: WSMessage[] = [];
  const unsubscribe = observeBroadcasts((message) => {
    if (message.type !== 'group_deleted') return;
    // Observer execution must see the committed deletion, never a premature notification.
    assert.equal(db.prepare('SELECT id FROM tasks WHERE id=?').get('prerequisite'), undefined);
    messages.push(message);
  });
  try {
    for (const id of ['source-group', 'dependent-group']) {
      db.prepare('INSERT INTO task_groups(id,project_id,title,created_at) VALUES (?, ?, ?, ?)').run(id, 'default', id, 1);
    }
    const task = (id: string, groupId: string): Task => ({ id, groupId, projectId: 'default', title: id,
      description: '', priority: 'medium', columnId: 'backlog', agentStatus: 'idle', createdAt: 1 });
    await tasks.create({ ...task('prerequisite', 'source-group'), columnId: 'done', agentStatus: 'complete' });
    await tasks.create(task('dependent', 'dependent-group'));
    await tasks.createDependency('prerequisite', 'dependent', 1);
    assert.equal((await getTaskDependencyGate(tasks, 'dependent')).eligible, true);
    const router = createGroupsRouter(groups, tasks, manager, projects);
    const route = (router as any).stack.find((entry: any) => entry.route?.path === '/:id' && entry.route.methods.delete);
    const status = await new Promise<number>((resolve, reject) => {
      let statusCode = 200;
      const response = {
        status(code: number) { statusCode = code; return this; },
        send() { resolve(statusCode); },
        json(body: unknown) { reject(new Error(JSON.stringify(body))); },
      };
      route.route.stack[0].handle({ params: { id: 'source-group' } }, response, reject);
    });
    assert.equal(status, 204);
    assert.deepEqual(messages, [{ type: 'group_deleted', payload: { id: 'source-group' } }]);
    const gate = await getTaskDependencyGate(tasks, 'dependent');
    assert.equal(gate.eligible, false);
    assert.equal(gate.dependencies[0].status, 'Missing');
    assert.equal(gate.dependencies[0].taskId, 'prerequisite');
  } finally { unsubscribe(); db.close(); }
});
