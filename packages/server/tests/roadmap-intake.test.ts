import assert from 'node:assert/strict';
import test from 'node:test';
import { parseRoadmapText, ROADMAP_TASK_LIMIT, ROADMAP_TEXT_LIMIT } from '../src/services/roadmap-intake.js';

test('parses versioned roadmap sections into ordered cards', () => {
  const result = parseRoadmapText(`
## v0.40
- Build roadmap parser
- Add preview endpoint

## v0.41 - Kanban creation flow
Create accepted cards through the task APIs.
  `);

  assert.notEqual(typeof result, 'string');
  if (typeof result === 'string') return;
  assert.deepEqual(result.tasks.map((task) => task.order), [1, 2]);
  assert.equal(result.tasks[0].title, '01. v0.40: Build roadmap parser');
  assert.equal(result.tasks[1].title, '02. v0.41: Kanban creation flow');
  assert.match(result.tasks[0].description, /Source roadmap item:\n\n## v0\.40/);
});

test('parses a single plain-text instruction into one ordered card', () => {
  const result = parseRoadmapText('Build the roadmap intake parser regression coverage.');

  assert.notEqual(typeof result, 'string');
  if (typeof result === 'string') return;
  assert.equal(result.tasks.length, 1);
  assert.equal(result.tasks[0].order, 1);
  assert.equal(result.tasks[0].title, '01. Build the roadmap intake parser regression coverage.');
  assert.equal(result.tasks[0].sourceText, 'Build the roadmap intake parser regression coverage.');
});

test('parses a single dash bullet into one ordered card', () => {
  const result = parseRoadmapText('- Build roadmap intake preview support');

  assert.notEqual(typeof result, 'string');
  if (typeof result === 'string') return;
  assert.equal(result.tasks.length, 1);
  assert.equal(result.tasks[0].title, '01. Build roadmap intake preview support');
  assert.equal(result.tasks[0].sourceText, '- Build roadmap intake preview support');
});

test('parses a single star bullet into one ordered card', () => {
  const result = parseRoadmapText('* Build roadmap intake preview support');

  assert.notEqual(typeof result, 'string');
  if (typeof result === 'string') return;
  assert.equal(result.tasks.length, 1);
  assert.equal(result.tasks[0].title, '01. Build roadmap intake preview support');
  assert.equal(result.tasks[0].sourceText, '* Build roadmap intake preview support');
});

test('keeps multiple bullet items as separate ordered cards', () => {
  const result = parseRoadmapText(`
- Build roadmap parser
* Add preview endpoint
- Document rollback checklist
  `);

  assert.notEqual(typeof result, 'string');
  if (typeof result === 'string') return;
  assert.deepEqual(result.tasks.map((task) => task.title), [
    '01. Build roadmap parser',
    '02. Add preview endpoint',
    '03. Document rollback checklist',
  ]);
});

test('parses numbered roadmap items without an LLM', () => {
  const result = parseRoadmapText(`
1. Add webhook retry controls: expose failed delivery actions
2. Harden API validation
  `);

  assert.notEqual(typeof result, 'string');
  if (typeof result === 'string') return;
  assert.deepEqual(result.tasks.map((task) => task.title), [
    '01. Add webhook retry controls',
    '02. Harden API validation',
  ]);
  assert.match(result.tasks[0].sourceText, /Add webhook retry controls/);
});

test('keeps multiline continuation text with its roadmap item', () => {
  const result = parseRoadmapText(`
- Build roadmap intake parser
Accept one plain instruction as a single card.
  Preserve limits and validation.
- Add regression tests
  `);

  assert.notEqual(typeof result, 'string');
  if (typeof result === 'string') return;
  assert.equal(result.tasks.length, 2);
  assert.equal(result.tasks[0].title, '01. Build roadmap intake parser');
  assert.match(result.tasks[0].sourceText, /Accept one plain instruction as a single card/);
  assert.match(result.tasks[0].sourceText, /Preserve limits and validation/);
  assert.equal(result.tasks[1].sourceText, '- Add regression tests');
});

test('rejects empty, ambiguous, oversized, and excessive roadmap input safely', () => {
  assert.match(String(parseRoadmapText('   ')), /Paste roadmap text/);
  assert.match(String(parseRoadmapText(`
Build the roadmap parser
Add the preview endpoint
  `)), /clear task boundaries/);
  assert.match(String(parseRoadmapText('x'.repeat(ROADMAP_TEXT_LIMIT + 1))), /at most/);

  const tooMany = Array.from({ length: ROADMAP_TASK_LIMIT + 1 }, (_, i) => `- Task ${i + 1}`).join('\n');
  assert.match(String(parseRoadmapText(tooMany)), /up to 25 cards/);
});
