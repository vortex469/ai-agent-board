import { createElement } from 'react';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { GroupChildActions } from '../src/components/GroupChildActions';
import type { Task } from '../src/types';

const task: Task = {
  id: 'child', projectId: 'default', groupId: 'group', title: 'Failed child',
  description: '', priority: 'medium', columnId: 'backlog',
  agentStatus: 'failed', createdAt: 1,
};
const action = () => {};
function render(overrides: Partial<Task> = {}) {
  return renderToStaticMarkup(createElement(GroupChildActions, { task: { ...task, ...overrides },
    onEdit: action, onRetry: action, onReset: action }));
}

test('failed grouped children expose enabled edit, retry and reset controls even in backlog', () => {
  const html = render();
  for (const label of ['Edit task', 'Retry task', 'Reset task']) {
    assert.ok(html.includes(`aria-label="${label}"`));
  }
  assert.ok(!html.includes('disabled='));
});

test('active children cannot be edited or reset; completed and idle children cannot retry', () => {
  for (const agentStatus of ['planning', 'executing'] as const) {
    const html = render({ agentStatus });
    assert.ok(html.includes('disabled='));
    assert.ok(!html.includes('Retry task'));
    assert.ok(!html.includes('Reset task'));
  }
  for (const agentStatus of ['idle', 'complete'] as const) {
    const html = render({ agentStatus });
    assert.ok(!html.includes('disabled='));
    assert.ok(!html.includes('Retry task'));
    assert.ok(!html.includes('Reset task'));
  }
});

test('archived failed children have no mutation controls', () => {
  assert.equal(render({ archived: true }), '');
});
