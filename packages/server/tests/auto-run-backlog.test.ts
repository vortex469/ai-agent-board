import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import { SqliteTaskRepository } from '../src/repositories/sqlite.js';
import {
  autoProgressCompletedTask,
  triggerAutomaticBacklogProgression,
  triggerAutomaticDependentProgression,
} from '../src/routes/helpers.js';
import type { AgentEvent, Task } from '../src/types.js';
import type { AgentManager } from '../src/services/agent-manager.js';

function makeDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys=ON');
  db.exec(`
    CREATE TABLE tasks (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL, description TEXT NOT NULL,
      priority TEXT, column_id TEXT, agent_status TEXT, agent_type TEXT, created_at INTEGER, started_at INTEGER,
      completed_at INTEGER, repo_path TEXT, branch_name TEXT, base_branch TEXT, use_worktree INTEGER,
      worktree_path TEXT, archived INTEGER, group_id TEXT, group_order INTEGER, summary TEXT, external_source TEXT,
      external_key TEXT, provenance TEXT, run_requested_at INTEGER, run_claimed_at INTEGER, timeout_minutes INTEGER);
    CREATE UNIQUE INDEX identity ON tasks(external_source,external_key) WHERE external_source IS NOT NULL AND external_key IS NOT NULL;
    CREATE TABLE events(id TEXT,task_id TEXT,type TEXT,content TEXT,timestamp INTEGER,metadata TEXT);
    CREATE TABLE task_relationships(task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      related_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, type TEXT NOT NULL DEFAULT 'related',
      created_at INTEGER NOT NULL, PRIMARY KEY(task_id,related_task_id), CHECK(task_id < related_task_id));
    CREATE TABLE task_dependencies(prerequisite_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      dependent_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, created_at INTEGER NOT NULL,
      PRIMARY KEY(prerequisite_task_id,dependent_task_id), CHECK(prerequisite_task_id <> dependent_task_id));
    CREATE TABLE execution_attempts(id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      external_source TEXT NOT NULL, external_key TEXT NOT NULL, title_snapshot TEXT NOT NULL, description_snapshot TEXT NOT NULL,
      agent_type TEXT NOT NULL, related_task_id TEXT, auto_start INTEGER NOT NULL, timeout_minutes INTEGER,
      request_snapshot TEXT NOT NULL DEFAULT '{}', status TEXT NOT NULL, created_at INTEGER NOT NULL, UNIQUE(external_source, external_key));
  `);
  return db;
}

const task = (id: string, overrides: Partial<Task> = {}): Task => ({
  id,
  projectId: 'project-a',
  title: id,
  description: '',
  priority: 'medium',
  columnId: 'backlog',
  agentStatus: 'idle',
  agentType: 'hermes',
  createdAt: Number(id.replace(/\D/g, '')) || 1,
  repoPath: '/tmp/agentboard-test-repo',
  baseBranch: 'main',
  branchName: `agent/${id}`,
  useWorktree: true,
  ...overrides,
});

function manager(started: string[] = [], overrides: Partial<AgentManager> = {}): AgentManager {
  return {
    getAvailableAgents: () => [{ name: 'hermes', displayName: 'Hermes', available: true }],
    isRunning: () => false,
    startAgent: (startedTask: Task) => { started.push(startedTask.id); },
    getMergeReadiness: () => ({ ready: true }),
    mergeLocal: async () => ({ baseBranch: 'main' }),
    removeWorktree: () => ({ status: 'removed' }),
    ...overrides,
  } as unknown as AgentManager;
}

let eventSeq = 0;
async function insertEvent(repo: SqliteTaskRepository, taskId: string, event: Partial<AgentEvent> & Pick<AgentEvent, 'type' | 'content'>): Promise<void> {
  await repo.insertEvent({
    id: `${taskId}-${event.type}-${eventSeq += 1}`,
    taskId,
    timestamp: Date.now(),
    ...event,
  });
}

test('auto run on admits the first eligible backlog card', async () => {
  const db = makeDb();
  const repo = new SqliteTaskRepository(db);
  const started: string[] = [];
  try {
    await repo.create(task('first', { createdAt: 1 }));
    await repo.create(task('second', { createdAt: 2 }));
    await repo.requestRun('second', 200);
    await repo.requestRun('first', 100);

    const admitted = await triggerAutomaticBacklogProgression(repo, 'project-a', manager(started));

    assert.equal(admitted?.id, 'first');
    assert.deepEqual(started, ['first']);
    assert.equal((await repo.getById('first'))?.columnId, 'in-progress');
    assert.equal((await repo.getById('second'))?.columnId, 'backlog');
  } finally { db.close(); }
});

test('auto run off leaves backlog unchanged', async () => {
  const db = makeDb();
  const repo = new SqliteTaskRepository(db);
  const started: string[] = [];
  try {
    await repo.create(task('manual'));

    const admitted = await triggerAutomaticBacklogProgression(repo, 'project-a', manager(started));

    assert.equal(admitted, undefined);
    assert.deepEqual(started, []);
    assert.equal((await repo.getById('manual'))?.columnId, 'backlog');
  } finally { db.close(); }
});

test('dependent backlog card waits for its prerequisite', async () => {
  const db = makeDb();
  const repo = new SqliteTaskRepository(db);
  const started: string[] = [];
  try {
    await repo.create(task('first', { columnId: 'review', agentStatus: 'complete' }));
    await repo.create(task('second'));
    await repo.createDependency('first', 'second', 10);
    await repo.requestRun('second', 20);

    const admitted = await triggerAutomaticBacklogProgression(repo, 'project-a', manager(started));

    assert.equal(admitted, undefined);
    assert.deepEqual(started, []);
    assert.equal((await repo.getById('second'))?.columnId, 'backlog');
  } finally { db.close(); }
});

test('completing prerequisite admits the dependent backlog card', async () => {
  const db = makeDb();
  const repo = new SqliteTaskRepository(db);
  const started: string[] = [];
  try {
    await repo.create(task('first', { columnId: 'review', agentStatus: 'complete' }));
    await repo.create(task('second'));
    await repo.createDependency('first', 'second', 10);
    await repo.requestRun('second', 20);

    const firstDone = await repo.update('first', { columnId: 'done' });
    assert(firstDone);
    await triggerAutomaticDependentProgression(repo, firstDone, manager(started));

    assert.deepEqual(started, ['second']);
    assert.equal((await repo.getById('second'))?.columnId, 'in-progress');
  } finally { db.close(); }
});

test('blocked failed and needs-human cards are not admitted', async () => {
  const db = makeDb();
  const repo = new SqliteTaskRepository(db);
  const started: string[] = [];
  try {
    await repo.create(task('blocked', { columnId: 'review', agentStatus: 'complete', runRequestedAt: 10 }));
    await repo.create(task('failed', { agentStatus: 'failed', runRequestedAt: 11 }));
    await repo.create(task('needs-human', { columnId: 'review', agentStatus: 'idle', runRequestedAt: 12 }));

    const admitted = await triggerAutomaticBacklogProgression(repo, 'project-a', manager(started));

    assert.equal(admitted, undefined);
    assert.deepEqual(started, []);
    assert.equal((await repo.getById('blocked'))?.columnId, 'review');
    assert.equal((await repo.getById('failed'))?.agentStatus, 'failed');
    assert.equal((await repo.getById('needs-human'))?.columnId, 'review');
  } finally { db.close(); }
});

test('enabling auto run with existing eligible backlog cards evaluates immediately', async () => {
  const db = makeDb();
  const repo = new SqliteTaskRepository(db);
  const started: string[] = [];
  try {
    await repo.create(task('existing'));
    await repo.requestRun('existing', 20);

    const admitted = await triggerAutomaticBacklogProgression(repo, 'project-a', manager(started));

    assert.equal(admitted?.id, 'existing');
    assert.deepEqual(started, ['existing']);
    assert.equal((await repo.getById('existing'))?.agentStatus, 'planning');
  } finally { db.close(); }
});

test('successful task progression still moves through review to done', async () => {
  const db = makeDb();
  const repo = new SqliteTaskRepository(db);
  try {
    await repo.create(task('successful', {
      columnId: 'in-progress',
      agentStatus: 'executing',
      worktreePath: '/tmp/agentboard-test-worktree',
      summary: 'Hostile review passed: no regressions found.',
    }));
    await insertEvent(repo, 'successful', {
      type: 'test_result',
      content: 'node --test auto-run-backlog.test.ts passed',
      metadata: { command: 'node --test auto-run-backlog.test.ts', state: 'succeeded' },
    });

    const done = await autoProgressCompletedTask(repo, 'successful', manager());

    assert.equal(done?.columnId, 'done');
    assert.equal(done?.agentStatus, 'complete');
    assert.equal(done?.worktreePath, undefined);
  } finally { db.close(); }
});

test('Local AI passing focused test evidence plus hostile review allows Done', async () => {
  const db = makeDb();
  const repo = new SqliteTaskRepository(db);
  try {
    await repo.create(task('local-valid', {
      columnId: 'in-progress',
      agentStatus: 'executing',
      agentType: 'local-openai',
      worktreePath: '/tmp/agentboard-test-worktree',
    }));
    await insertEvent(repo, 'local-valid', {
      type: 'command',
      content: 'bash: {"command":"npm run test -- tests/local-ai.test.ts"}',
      metadata: { agentType: 'local-openai', command: 'npm run test -- tests/local-ai.test.ts', state: 'running' },
    });
    await insertEvent(repo, 'local-valid', {
      type: 'test_result',
      content: '1 test passed',
      metadata: { agentType: 'local-openai', command: 'npm run test -- tests/local-ai.test.ts', state: 'succeeded' },
    });
    await insertEvent(repo, 'local-valid', {
      type: 'output',
      content: 'Hostile review passed: checked regressions, edge cases, security issues, and missing tests.',
      metadata: { agentType: 'local-openai' },
    });

    const done = await autoProgressCompletedTask(repo, 'local-valid', manager());

    assert.equal(done?.columnId, 'done');
    assert.equal(done?.agentStatus, 'complete');
  } finally { db.close(); }
});

test('Local AI passing tests without hostile review remains in Review', async () => {
  const db = makeDb();
  const repo = new SqliteTaskRepository(db);
  let merges = 0;
  try {
    await repo.create(task('no-review', {
      columnId: 'in-progress',
      agentStatus: 'executing',
      agentType: 'local-openai',
      worktreePath: '/tmp/agentboard-test-worktree',
    }));
    await insertEvent(repo, 'no-review', {
      type: 'test_result',
      content: 'ok',
      metadata: { agentType: 'local-openai', command: 'pnpm test packages/server/tests/auto-run-backlog.test.ts', state: 'succeeded' },
    });

    const reviewed = await autoProgressCompletedTask(repo, 'no-review', manager([], {
      mergeLocal: async () => { merges += 1; return { baseBranch: 'main' }; },
    }));

    assert.equal(merges, 0);
    assert.equal(reviewed?.columnId, 'review');
    assert.match(
      [...(await repo.getEventsByTaskId('no-review'))].reverse().find((event) => event.type === 'error')?.content ?? '',
      /missing passing hostile review evidence/i,
    );
  } finally { db.close(); }
});

test('Local AI hostile review with failing tests remains in Review', async () => {
  const db = makeDb();
  const repo = new SqliteTaskRepository(db);
  let merges = 0;
  try {
    await repo.create(task('failing-tests', {
      columnId: 'in-progress',
      agentStatus: 'executing',
      agentType: 'local-openai',
      worktreePath: '/tmp/agentboard-test-worktree',
    }));
    await insertEvent(repo, 'failing-tests', {
      type: 'test_result',
      content: '1 failed, 3 passed',
      metadata: { agentType: 'local-openai', command: 'node --test tests/focused.test.ts', state: 'failed' },
    });
    await insertEvent(repo, 'failing-tests', {
      type: 'output',
      content: 'Hostile review passed: no additional regressions found.',
      metadata: { agentType: 'local-openai' },
    });

    const reviewed = await autoProgressCompletedTask(repo, 'failing-tests', manager([], {
      mergeLocal: async () => { merges += 1; return { baseBranch: 'main' }; },
    }));

    assert.equal(merges, 0);
    assert.equal(reviewed?.columnId, 'review');
    assert.match(
      [...(await repo.getEventsByTaskId('failing-tests'))].reverse().find((event) => event.type === 'error')?.content ?? '',
      /focused tests evidence failed/i,
    );
  } finally { db.close(); }
});

test('focused-tests summary prose without structured test event remains blocked', async () => {
  const db = makeDb();
  const repo = new SqliteTaskRepository(db);
  try {
    await repo.create(task('vague-prose', {
      columnId: 'in-progress',
      agentStatus: 'executing',
      agentType: 'local-openai',
      worktreePath: '/tmp/agentboard-test-worktree',
      summary: 'Focused tests passed: npm test -- tests/focused.test.ts',
    }));
    await insertEvent(repo, 'vague-prose', {
      type: 'output',
      content: 'The tests passed and I reviewed the change.',
      metadata: { agentType: 'local-openai' },
    });
    await insertEvent(repo, 'vague-prose', {
      type: 'output',
      content: 'Hostile review passed: looked for regressions.',
      metadata: { agentType: 'local-openai' },
    });

    const reviewed = await autoProgressCompletedTask(repo, 'vague-prose', manager());

    assert.equal(reviewed?.columnId, 'review');
    assert.match(
      [...(await repo.getEventsByTaskId('vague-prose'))].reverse().find((event) => event.type === 'error')?.content ?? '',
      /missing passing focused tests evidence/i,
    );
  } finally { db.close(); }
});

test('missing structured tests and hostile review reports both categories', async () => {
  const db = makeDb();
  const repo = new SqliteTaskRepository(db);
  try {
    await repo.create(task('missing-both', {
      columnId: 'in-progress',
      agentStatus: 'executing',
      agentType: 'local-openai',
      worktreePath: '/tmp/agentboard-test-worktree',
    }));
    await insertEvent(repo, 'missing-both', {
      type: 'output',
      content: 'Implemented the change and everything looks good.',
      metadata: { agentType: 'local-openai' },
    });

    const reviewed = await autoProgressCompletedTask(repo, 'missing-both', manager());

    assert.equal(reviewed?.columnId, 'review');
    assert.match(
      [...(await repo.getEventsByTaskId('missing-both'))].reverse().find((event) => event.type === 'error')?.content ?? '',
      /missing passing focused tests and hostile review evidence/i,
    );
  } finally { db.close(); }
});

test('normalized command output test evidence is accepted', async () => {
  const db = makeDb();
  const repo = new SqliteTaskRepository(db);
  try {
    await repo.create(task('command-output', {
      columnId: 'in-progress',
      agentStatus: 'executing',
      agentType: 'local-openai',
      worktreePath: '/tmp/agentboard-test-worktree',
    }));
    await insertEvent(repo, 'command-output', {
      type: 'command_output',
      content: '10 passed, 0 failed, 0 errors',
      metadata: { agentType: 'local-openai', command: 'pytest tests/test_workbench.py', state: 'succeeded' },
    });
    await insertEvent(repo, 'command-output', {
      type: 'output',
      content: 'Hostile review passed: no regressions found.',
      metadata: { agentType: 'local-openai' },
    });

    const done = await autoProgressCompletedTask(repo, 'command-output', manager());

    assert.equal(done?.columnId, 'done');
  } finally { db.close(); }
});

test('Local AI wording variants normalize the same when structured test results exist', async () => {
  const cases = [
    { id: 'variant-a', content: 'Focused verification completed successfully.' },
    { id: 'variant-b', content: 'Focused tests passed: custom provider wording.' },
    { id: 'variant-c', content: 'All requested validation is green.' },
  ];

  for (const item of cases) {
    const db = makeDb();
    const repo = new SqliteTaskRepository(db);
    try {
      await repo.create(task(item.id, {
        columnId: 'in-progress',
        agentStatus: 'executing',
        agentType: 'local-openai',
        worktreePath: '/tmp/agentboard-test-worktree',
      }));
      await insertEvent(repo, item.id, {
        type: 'test_result',
        content: item.content,
        metadata: {
          agentType: 'local-openai',
          command: 'npm run test -w @ai-agent-board/server -- tests/auto-run-backlog.test.ts',
          state: 'succeeded',
          callId: item.id,
        },
      });
      await insertEvent(repo, item.id, {
        type: 'output',
        content: 'Hostile review passed: checked regressions, edge cases, security issues, and missing tests.',
        metadata: { agentType: 'local-openai' },
      });

      const done = await autoProgressCompletedTask(repo, item.id, manager());

      assert.equal(done?.columnId, 'done');
    } finally { db.close(); }
  }
});

test('duplicate normalized evidence is handled safely', async () => {
  const db = makeDb();
  const repo = new SqliteTaskRepository(db);
  let merges = 0;
  try {
    await repo.create(task('duplicate-events', {
      columnId: 'in-progress',
      agentStatus: 'executing',
      agentType: 'local-openai',
      worktreePath: '/tmp/agentboard-test-worktree',
    }));
    const event: Partial<AgentEvent> & Pick<AgentEvent, 'type' | 'content'> = {
      type: 'test_result',
      content: 'ok',
      metadata: { agentType: 'local-openai', command: 'npm test', state: 'succeeded', callId: 'dup-1' },
    };
    await insertEvent(repo, 'duplicate-events', event);
    await insertEvent(repo, 'duplicate-events', event);
    await insertEvent(repo, 'duplicate-events', {
      type: 'output',
      content: 'Hostile review passed: no issues found.',
      metadata: { agentType: 'local-openai' },
    });
    await insertEvent(repo, 'duplicate-events', {
      type: 'output',
      content: 'Hostile review passed: no issues found.',
      metadata: { agentType: 'local-openai' },
    });

    const done = await autoProgressCompletedTask(repo, 'duplicate-events', manager([], {
      mergeLocal: async () => { merges += 1; return { baseBranch: 'main' }; },
    }));

    assert.equal(done?.columnId, 'done');
    assert.equal(merges, 1);
  } finally { db.close(); }
});

test('DeepSeek Qwen style normalized events can move Review to Done with redacted output intact', async () => {
  const db = makeDb();
  const repo = new SqliteTaskRepository(db);
  try {
    await repo.create(task('deepseek-qwen', {
      columnId: 'in-progress',
      agentStatus: 'executing',
      agentType: 'local-openai',
      worktreePath: '/tmp/agentboard-test-worktree',
      summary: '## Completed\nImplemented the requested change.\n## Comments\nHostile review passed: verified regressions, edge cases, security issues, and missing tests.',
    }));
    await insertEvent(repo, 'deepseek-qwen', {
      type: 'command',
      content: 'bash: {"command":"npm run test -w @ai-agent-board/server -- tests/task-relationships.test.ts"}',
      metadata: {
        agentType: 'local-openai',
        command: 'npm run test -w @ai-agent-board/server -- tests/task-relationships.test.ts',
        state: 'running',
        toolName: 'bash',
        callId: 'qwen-test',
      },
    });
    await insertEvent(repo, 'deepseek-qwen', {
      type: 'test_result',
      content: 'Focused server test passed with token=[redacted]',
      metadata: {
        agentType: 'local-openai',
        command: 'npm run test -w @ai-agent-board/server -- tests/task-relationships.test.ts',
        state: 'succeeded',
        toolName: 'bash',
        callId: 'qwen-test',
      },
    });
    const done = await autoProgressCompletedTask(repo, 'deepseek-qwen', manager());
    const contents = (await repo.getEventsByTaskId('deepseek-qwen')).map((event) => event.content).join('\n');

    assert.equal(done?.columnId, 'done');
    assert.match(contents, /\[redacted\]/);
    assert.doesNotMatch(contents, /sk-test|secret-token|api_key:\s*\w/i);
  } finally { db.close(); }
});
