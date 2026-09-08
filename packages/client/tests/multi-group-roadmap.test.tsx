import { createElement } from 'react';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { MultiGroupRoadmapPreview, renameRoadmapGroup, editRoadmapDependencies } from '../src/components/MultiGroupRoadmapPreview';
import type { RoadmapProposedGroup } from '../src/types';

const groups: RoadmapProposedGroup[] = [
  { title: 'v0.11 Base Building', agentType: 'codex', tasks: [{ ref: '04', order: 1, title: 'Construction', description: 'Foundation', sourceText: '', dependencies: [] }] },
  { title: 'v0.12 Advanced Crafting & Workstations', autoRun: true, tasks: [{ ref: '04', order: 1, title: 'Integration', description: '', sourceText: '', dependencies: ['v0.11 Base Building / 04', '02'] }] },
];

test('multi-group preview shows editable groups, tasks, ordering, inherited settings and dependency scope', () => {
  const html = renderToStaticMarkup(createElement(MultiGroupRoadmapPreview, { groups, defaultAgent: 'codex', onChange() {} }));
  for (const expected of ['Multi-group import preview', 'Group 1 name', 'Group 2 task 1 title', 'Group 2 task 1 order', 'Group 2 task 1 dependencies', 'Group 2 task 1 auto run', 'Inherit (On)', 'Cross-group: ', 'Within group: ', 'Base branch', 'Task settings']) assert.ok(html.includes(expected), expected);
});

test('renaming a group updates only its qualified dependencies and preserves references/order', () => {
  const input = structuredClone(groups);
  input[1].tasks[0].dependencies.push('  V0.11 BASE BUILDING / 04');
  const updated = renameRoadmapGroup(input, 0, 'v0.11 Renamed');
  assert.equal(updated[0].title, 'v0.11 Renamed');
  assert.deepEqual(updated[1].tasks[0].dependencies, ['v0.11 Renamed / 04', '02', 'v0.11 Renamed / 04']);
  assert.equal(updated[0].tasks[0].ref, '04');
  assert.equal(updated[0].tasks[0].order, 1);
  assert.equal(input[0].title, 'v0.11 Base Building');
});

test('dependency editing clears all references and retains malformed entries for server rejection', () => {
  assert.deepEqual(editRoadmapDependencies('  '), []);
  assert.deepEqual(editRoadmapDependencies('01, v0.11 Base Building / 04'), ['01', 'v0.11 Base Building / 04']);
  assert.deepEqual(editRoadmapDependencies('01,,02'), ['01', '', '02']);
});

test('same-group qualified references are not mislabeled cross-group despite case or padding', () => {
  const input = structuredClone(groups);
  input[0].tasks[0].dependencies = [' V0.11 BASE BUILDING / 02'];
  const html = renderToStaticMarkup(createElement(MultiGroupRoadmapPreview, { groups: [input[0]], defaultAgent: 'codex', onChange() {} }));
  assert.ok(html.includes('Within group: '));
  assert.ok(!html.includes('Cross-group: '));
});

test('preview retains touch targets and responsive single-column fields without a wide table', () => {
  const html = renderToStaticMarkup(createElement(MultiGroupRoadmapPreview, { groups, defaultAgent: 'codex', onChange() {}, disabled: true }));
  assert.ok(html.includes('min-h-11 w-full min-w-0'));
  assert.ok(html.includes('sm:grid-cols-2'));
  assert.ok(html.includes('break-words'));
  assert.ok(html.includes('<fieldset disabled=""'));
  assert.ok(!html.includes('<table'));
});
