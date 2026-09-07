import assert from 'node:assert/strict';
import test from 'node:test';
import { parseRoadmapText, ROADMAP_TASK_LIMIT, ROADMAP_TEXT_LIMIT } from '../src/services/roadmap-intake.js';

for (const length of [100, 5_001, 19_978, 19_979, 20_000]) {
  test(`preserves all ${length} characters of a roadmap source item`, () => {
    const source = '- Build coverage ' + 'x'.repeat(length - '- Build coverage '.length);
    const result = parseRoadmapText(source);
    assert.notEqual(typeof result, 'string');
    if (typeof result === 'string') return;
    assert.equal(result.tasks[0].sourceText, source);
    const labeled = `Source roadmap item:\n\n${source}`;
    assert.equal(result.tasks[0].description, labeled.length <= 20_000 ? labeled : source);
    assert.ok(result.tasks[0].description.length <= 20_000);
  });
}

test('rejects a 20,001-character roadmap without truncating', () => {
  assert.equal(parseRoadmapText('x'.repeat(20_001)), 'Roadmap text must be at most 20,000 characters');
});

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
  assert.equal(result.tasks[0].title, 'v0.40: Build roadmap parser');
  assert.equal(result.tasks[1].title, 'v0.41: Kanban creation flow');
  assert.equal(result.tasks[0].dependsOnTaskIndexes, undefined);
  assert.deepEqual(result.tasks[1].dependsOnTaskIndexes, [0]);
  assert.match(result.tasks[0].description, /Source roadmap item:\n\n## v0\.40/);
});

test('parses a single plain-text instruction into one ordered card', () => {
  const result = parseRoadmapText('Build the roadmap intake parser regression coverage.');

  assert.notEqual(typeof result, 'string');
  if (typeof result === 'string') return;
  assert.equal(result.tasks.length, 1);
  assert.equal(result.tasks[0].order, 1);
  assert.equal(result.tasks[0].title, '01. Build the roadmap intake parser regression coverage');
  assert.equal(result.tasks[0].sourceText, 'Build the roadmap intake parser regression coverage.');
});

test('rejects vague single-line request prose without a clear task boundary', () => {
  const result = parseRoadmapText('Please make the next release better.');
  assert.match(String(result), /clear task boundaries/i);
});

test('humanizes ordinary hyphenated display words while preserving source text', () => {
  const result = parseRoadmapText('- Build first-card payload');

  assert.notEqual(typeof result, 'string');
  if (typeof result === 'string') return;

  assert.equal(result.tasks[0].title, '01. Build first card payload');
  assert.equal(result.tasks[0].sourceText, '- Build first-card payload');
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

test('humanizes code-like identifiers in titles while preserving exact source descriptions', () => {
  const result = parseRoadmapText(`
- Create ROADMAP_PIPELINE_SMOKE.md
- Validate --dry-run behavior
- Read SOME_ENV_VAR before launch
- Update src/foo_bar.ts
- Pin package/name@1.2.3
- Write normal prose title
  `);

  assert.notEqual(typeof result, 'string');
  if (typeof result === 'string') return;
  assert.deepEqual(result.tasks.map((task) => task.title), [
    '01. Create roadmap pipeline smoke',
    '02. Validate dry run behavior',
    '03. Read some env var before launch',
    '04. Update foo bar',
    '05. Pin package name',
    '06. Write normal prose title',
  ]);
  assert.equal(result.tasks[0].sourceText, '- Create ROADMAP_PIPELINE_SMOKE.md');
  assert.equal(result.tasks[3].description, 'Source roadmap item:\n\n- Update src/foo_bar.ts');
});

test('summarizes long versioned roadmap items while keeping the source authoritative', () => {
  const result = parseRoadmapText('v0.1 - Improve Roadmap Intake card titles so generated titles are concise and readable while preserving exact identifiers in the source description.');

  assert.notEqual(typeof result, 'string');
  if (typeof result === 'string') return;
  assert.equal(result.tasks[0].title, 'v0.1: Improve Roadmap Intake card titles');
  assert.equal(
    result.tasks[0].description,
    'Source roadmap item:\n\nv0.1 - Improve Roadmap Intake card titles so generated titles are concise and readable while preserving exact identifiers in the source description.',
  );
});

test('uses the version identifier as the display ordering label for separately imported versioned cards', () => {
  const result = parseRoadmapText('v0.8 - Ship grouped task execution controls');

  assert.notEqual(typeof result, 'string');
  if (typeof result === 'string') return;
  assert.equal(result.tasks.length, 1);
  assert.equal(result.tasks[0].order, 1);
  assert.equal(result.tasks[0].title, 'v0.8: Ship grouped task execution controls');
  assert.equal(result.tasks[0].sourceText, 'v0.8 - Ship grouped task execution controls');
  assert.equal(result.tasks[0].dependsOnTaskIndexes, undefined);
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
