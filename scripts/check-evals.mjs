import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const data = JSON.parse(await readFile(new URL('../evals/scenarios.json', import.meta.url), 'utf8'));
assert.equal(data.schemaVersion, 1);
assert.ok(Array.isArray(data.cases) && data.cases.length, 'Expected a nonempty scenario collection');
// Protect the existing coverage while allowing more regression scenarios.
const requiredIds = [
  'case-01-scratch-company-site',
  'case-02-existing-project-tweak',
  'case-03-colleague-updates-cases',
  'case-04-preserve-review-requirement',
  'case-05-external-dependencies',
  'case-06-missing-critical-requirement',
  'case-07-tool-failure-permission-denied',
  'case-08-tests-pass-uncovered-scenarios',
  'case-09-long-session-goal-pivot',
  'case-10-user-asks-tech-details',
  'case-11-vague-thinking-game-clarify-first',
  'case-12-explicit-new-game-proceed',
  'case-13-delegated-thinking-game-prototype',
];
const ids = new Set();
for (const item of data.cases) {
  assert.equal(typeof item.id, 'string');
  assert.match(item.id, /^case-\d{2,}-[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Case IDs must use the case-NN-description format');
  assert.ok(!ids.has(item.id), 'Case IDs must be unique');
  ids.add(item.id);
  assert.equal(typeof item.title, 'string');
  assert.ok(item.title.trim());
  assert.ok(Array.isArray(item.messages) && item.messages.length);
  for (const message of item.messages) {
    assert.ok(['user', 'assistant'].includes(message.role));
    assert.equal(typeof message.content, 'string');
    assert.ok(message.content.trim());
  }
  assert.equal(item.messages.at(-1).role, 'user', `${item.id} must end with the user's request`);
  for (const key of ['expectedBehaviors', 'criticalFailures', 'reviewQuestions']) {
    assert.ok(Array.isArray(item[key]) && item[key].length);
    assert.ok(item[key].every(value => typeof value === 'string' && value.trim()));
  }
}
for (const id of requiredIds) assert.ok(ids.has(id), `Missing required regression scenario: ${id}`);
console.log(`Validated ${data.cases.length} scenario records. This is schema validation, not a model-quality evaluation.`);
