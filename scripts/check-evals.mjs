import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const data = JSON.parse(await readFile(new URL('../evals/scenarios.json', import.meta.url), 'utf8'));
assert.equal(data.schemaVersion, 1);
assert.equal(data.cases.length, 10, 'Expected the ten specified scenarios');
const ids = new Set();
for (const item of data.cases) {
  assert.equal(typeof item.id, 'string');
  assert.ok(item.id && !ids.has(item.id), 'Case IDs must be nonempty and unique');
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
console.log(`Validated ${data.cases.length} scenario records. This is schema validation, not a model-quality evaluation.`);
