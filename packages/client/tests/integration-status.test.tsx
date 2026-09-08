import { createElement } from 'react';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntegrationStatus, IntegrationStatusView } from '../src/components/IntegrationStatus';
import type { Task } from '../src/types';

const render = (status: { synchronized: boolean; reason?: string }, busy = false) => renderToStaticMarkup(createElement(IntegrationStatusView, { status, busy, error: '', onRecheck: () => {} }));

test('unproven integration shows its reason and a recheck action without agent retry', () => {
  const html = render({ synchronized: false, reason: 'Task branch is not contained in main' });
  assert.match(html, /Repository: Integration pending/);
  assert.match(html, /Task branch is not contained in main/);
  assert.match(html, /Recheck integration/);
  assert.doesNotMatch(html, /Retry task|Reset task/);
});

test('synchronized integration removes stale failure messaging and recheck', () => {
  const html = render({ synchronized: true, reason: 'Previous merge failed' });
  assert.match(html, /Synchronized \/ integrated/);
  assert.doesNotMatch(html, /Previous merge failed|Recheck integration|Integration pending/);
});

test('recheck is disabled during inspection', () => {
  const html = render({ synchronized: false }, true);
  assert.match(html, /disabled=""/);
  assert.match(html, /Checking integration/);
});

test('running, failed, standalone and untracked tasks do not offer integration recheck', () => {
  const task: Task = { id: 'task', projectId: 'p', groupId: 'g', title: 'Task', description: '', priority: 'medium', columnId: 'review', agentStatus: 'complete', createdAt: 1, repositoryBaseline: { startCommit: 'start', resultCommit: 'result' } };
  for (const override of [{ agentStatus: 'executing' }, { agentStatus: 'failed' }, { groupId: undefined }, { repositoryBaseline: undefined }] as Partial<Task>[]) {
    assert.equal(renderToStaticMarkup(createElement(IntegrationStatus, { task: { ...task, ...override } })), '');
  }
});
