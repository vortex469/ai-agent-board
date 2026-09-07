import assert from 'node:assert/strict';
import test from 'node:test';
import { MAX_DESCRIPTION_LENGTH } from '@ai-agent-board/shared/constants.js';
import { validateTaskFields } from '../src/routes/helpers.js';

for (const length of [0, 100, 5_001, 20_000]) {
  test(`shared task creation and batch validator accepts ${length} description characters`, () => {
    assert.equal(MAX_DESCRIPTION_LENGTH, 20_000);
    assert.equal(validateTaskFields({ title: 'Description boundary', description: 'x'.repeat(length) }), null);
  });
}

test('shared task validator rejects 20,001 characters with a clear error', () => {
  assert.equal(
    validateTaskFields({ title: 'Description boundary', description: 'x'.repeat(20_001) }),
    'description must be at most 20000 characters',
  );
});
