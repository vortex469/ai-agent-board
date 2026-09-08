import { createElement } from 'react';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { DependencyStatus, DependencyEditor, DependencyProvider, dependencyCandidates, wouldCreateDependencyCycle } from '../src/components/TaskDependencies';
import type { Task } from '../src/types';
import type { TaskDependencyGate } from '../../../shared/types';

const task: Task = { id: 'B3', groupId: 'B', projectId: 'project', title: 'Crafting', description: '', priority: 'medium', columnId: 'backlog', agentStatus: 'idle', createdAt: 1 };
const gate: TaskDependencyGate = { eligible: false, dependencies: [{ taskId: 'A2', groupId: 'A', groupTitle: 'Base Building', title: 'Placement', status: 'Waiting' }] };

test('cross-group dependency shows labels, status and waiting reason', () => {
  const html = renderToStaticMarkup(createElement(DependencyStatus, { task, gate }));
  for (const text of ['Synchronization gate', 'Base Building / Placement', 'Waiting for:', 'Waiting']) assert.ok(html.includes(text));
});

test('same-group dependencies have distinct presentation and successful prerequisites show Done', () => {
  const html = renderToStaticMarkup(createElement(DependencyStatus, { task, gate: { eligible: true, dependencies: [{ taskId: 'B1', groupId: 'B', title: 'Setup', status: 'Done' }] } }));
  assert.ok(html.includes('Done'));
  assert.ok(!html.includes('Synchronization gate'));
  assert.ok(!html.includes('Waiting for:'));
});

test('missing, failed and blocked states retain IDs or labels and integration reason', () => {
  for (const status of ['Missing', 'Failed', 'Blocked'] as const) {
    const html = renderToStaticMarkup(createElement(DependencyStatus, { task, gate: { eligible: false, reason: 'Integration required', dependencies: [{ taskId: 'deleted-id', status }] } }));
    assert.ok(html.includes(status)); assert.ok(html.includes('deleted-id')); assert.ok(html.includes('Integration required'));
  }
});

test('running task warns about reopened dependency without offering to terminate it', () => {
  const html = renderToStaticMarkup(createElement(DependencyStatus, { task: { ...task, agentStatus: 'executing' }, gate }));
  assert.ok(html.includes('role="alert"'));
  assert.ok(html.includes('Dependency changed during execution'));
});

test('selection rejects self, immediate and transitive cross-group cycles', () => {
  const gates = { A2: { eligible: false, dependencies: [{ taskId: 'C1', status: 'Waiting' as const }] }, C1: { eligible: false, dependencies: [{ taskId: 'B3', status: 'Waiting' as const }] } };
  assert.equal(wouldCreateDependencyCycle('B3', 'B3', gates), true);
  assert.equal(wouldCreateDependencyCycle('B3', 'C1', gates), true);
  assert.equal(wouldCreateDependencyCycle('B3', 'A2', gates), true);
  assert.equal(wouldCreateDependencyCycle('B3', 'unrelated', gates), false);
});

test('collapsed editor defers options to avoid cluttering task labels and preserves touch controls', () => {
  const prerequisite = { ...task, id: 'A2', groupId: 'A', title: 'Placement' };
  const otherProject = { ...task, id: 'foreign', groupId: 'foreign-group', projectId: 'other', title: 'Private task' };
  const html = renderToStaticMarkup(createElement(DependencyProvider, { tasks: [], groups: [
    { id: 'A', projectId: 'project', title: 'Base Building', priority: 'medium', columnId: 'backlog', maxConcurrency: 1, createdAt: 1, children: [prerequisite] },
    { id: 'B', projectId: 'project', title: 'Crafting group', priority: 'medium', columnId: 'backlog', maxConcurrency: 1, createdAt: 1, children: [task] },
    { id: 'foreign-group', projectId: 'other', title: 'Other project', priority: 'medium', columnId: 'backlog', maxConcurrency: 1, createdAt: 1, children: [otherProject] },
  ], children: createElement(DependencyEditor, { task }) }));
  assert.ok(html.includes('Edit dependencies'));
  assert.ok(!html.includes('Private task'));
  assert.ok(!html.includes('<select'));
  assert.ok(html.includes('min-h-11')); assert.ok(html.includes('w-full min-w-0'));
});

test('selection offers same-group and cross-group IDs only from the same project', () => {
  const candidates = dependencyCandidates(task, [task,
    { ...task, id: 'same-group' }, { ...task, id: 'cross-group', groupId: 'A' },
    { ...task, id: 'foreign-project', projectId: 'other' }, { ...task, id: 'archived', archived: true },
    { ...task, id: 'already-selected' },
  ], { B3: { eligible: false, dependencies: [{ taskId: 'already-selected', status: 'Waiting' }] } });
  assert.deepEqual(candidates.map(candidate => candidate.id), ['same-group', 'cross-group']);
});
