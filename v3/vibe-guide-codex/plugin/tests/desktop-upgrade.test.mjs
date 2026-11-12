import assert from 'node:assert/strict';
import test from 'node:test';
import { composeDesktopPatch } from '../scripts/desktop.mjs';

const include = id => ({ id, name: 'cordis:include', config: { path: `/plugins/${id}/preset.yml` } });
const addition = { insert: [include('vibeguide-presets')] };

test('desktop upgrade consolidates both modes while preserving unrelated configuration', () => {
  const model = { id: 'agent-default-model', config: { provider: 'example', model: 'existing' } };
  const other = include('other-plugin');
  const before = [model, { insert: [include('vibeguide-presets'), other] }, { insert: [include('vibeguide-p0-presets')] }, { id: 'agent-preset-registry', config: { default: 'vibeguide-p0', other: 7 } }];
  const snapshot = structuredClone(before);
  assert.deepEqual(composeDesktopPatch(before, addition, true), [model, { insert: [other] }, { id: 'agent-preset-registry', config: { default: 'vibeguide', other: 7 } }, addition]);
  assert.deepEqual(before, snapshot);
});

test('fresh install and subsequent upgrade each retain a single VibeGuide declaration', () => {
  const original = [{ id: 'hmr', disabled: true }];
  const installed = composeDesktopPatch(original, addition);
  assert.deepEqual(installed, [...original, addition]);
  assert.throws(() => composeDesktopPatch(installed, addition), /--upgrade/);
  assert.deepEqual(composeDesktopPatch(installed, addition, true), installed);
  assert.deepEqual(composeDesktopPatch([include('vibeguide-presets')], addition, true), [addition]);
});

test('ambiguous or manual declarations are rejected without changing the input', () => {
  for (const previous of [
    [{ insert: [include('vibeguide-presets'), include('vibeguide-presets')] }],
    [{ id: 'vibeguide-presets', name: 'custom-plugin' }],
    [{ insert: [{ id: 'custom', config: { id: 'vibeguide' } }] }],
  ]) {
    const snapshot = structuredClone(previous);
    assert.throws(() => composeDesktopPatch(previous, addition, true));
    assert.deepEqual(previous, snapshot);
  }
});
