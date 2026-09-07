import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTaskUpdateTracker } from '../src/lib/task-update-tracker';
import type { Task } from '../src/types';

const child: Task = {
  id: 'child', projectId: 'default', groupId: 'group', title: 'Failed child',
  description: '', priority: 'medium', columnId: 'backlog',
  agentStatus: 'failed', agentType: 'copilot', createdAt: 1,
};

test('saved child agent and retry status apply without WebSocket delivery', () => {
  const updates: Task[] = [];
  const tracker = createTaskUpdateTracker((task) => updates.push(task));
  const edited = { ...child, title: 'Recovered child', agentType: 'codex' as const };
  tracker.start(child.id)(edited);
  const running = { ...edited, agentStatus: 'executing' as const };
  tracker.start(child.id)(running);
  assert.deepEqual(updates, [edited, running]);
});

test('a delayed retry response cannot overwrite a newer WebSocket failure', () => {
  const updates: Task[] = [];
  const tracker = createTaskUpdateTracker((task) => updates.push(task));
  const finish = tracker.start(child.id);
  tracker.receive(child);
  finish({ ...child, agentStatus: 'planning' });
  assert.deepEqual(updates, [child]);
  // A later intentional retry must still be accepted.
  const running = { ...child, agentStatus: 'executing' as const };
  tracker.start(child.id)(running);
  assert.deepEqual(updates, [child, running]);
});

test('sibling broadcasts do not swallow the edited child response', () => {
  const updates: Task[] = [];
  const tracker = createTaskUpdateTracker((task) => updates.push(task));
  const finish = tracker.start(child.id);
  const sibling = { ...child, id: 'sibling' };
  tracker.receive(sibling);
  const edited = { ...child, agentType: 'codex' as const };
  finish(edited);
  assert.deepEqual(updates, [sibling, edited]);
});

test('out-of-order concurrent mutations preserve the latest child edit', () => {
  const updates: Task[] = [];
  const tracker = createTaskUpdateTracker((task) => updates.push(task));
  const older = tracker.start(child.id);
  const newer = tracker.start(child.id);
  const edited = { ...child, agentType: 'codex' as const };
  newer(edited);
  older(child);
  assert.deepEqual(updates, [edited]);
});

test('failed mutations do not change task state or block the next recovery', () => {
  const updates: Task[] = [];
  const tracker = createTaskUpdateTracker((task) => updates.push(task));
  tracker.start(child.id)(undefined);
  assert.deepEqual(updates, []);
  tracker.start(child.id)(child);
  assert.deepEqual(updates, [child]);
});
