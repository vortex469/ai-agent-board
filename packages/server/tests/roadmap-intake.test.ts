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

test('parses bulleted and numbered roadmap items without an LLM', () => {
  const result = parseRoadmapText(`
1. Add webhook retry controls: expose failed delivery actions
2. Harden API validation
- Document rollback checklist
  `);

  assert.notEqual(typeof result, 'string');
  if (typeof result === 'string') return;
  assert.deepEqual(result.tasks.map((task) => task.title), [
    '01. Add webhook retry controls',
    '02. Harden API validation',
    '03. Document rollback checklist',
  ]);
  assert.match(result.tasks[0].sourceText, /Add webhook retry controls/);
});

test('rejects empty, ambiguous, oversized, and excessive roadmap input safely', () => {
  assert.match(String(parseRoadmapText('   ')), /Paste roadmap text/);
  assert.match(String(parseRoadmapText('Build the next release with normal prose only.')), /clear task boundaries/);
  assert.match(String(parseRoadmapText('x'.repeat(ROADMAP_TEXT_LIMIT + 1))), /at most/);

  const tooMany = Array.from({ length: ROADMAP_TASK_LIMIT + 1 }, (_, i) => `- Task ${i + 1}`).join('\n');
  assert.match(String(parseRoadmapText(tooMany)), /up to 25 cards/);
});
