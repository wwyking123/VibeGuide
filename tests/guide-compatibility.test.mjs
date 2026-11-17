import assert from 'node:assert/strict';
import test from 'node:test';
import { assertDesktopVersion, desktopCompatibility } from '../dist/guide/host/compatibility.js';
import { vibeGuidePreset } from '../dist/guide/host/preset.js';
import { guideCall } from '../dist/client/rpc.js';

test('a newer Harness always loads as untested; only one older than the first supported release is refused', () => {
  assert.equal(desktopCompatibility('0.2.1-rc.2'), 'verified');
  assert.equal(desktopCompatibility('0.2.1-rc.3'), 'verified');
  assert.equal(desktopCompatibility('0.2.2-rc.3'), 'verified');
  for (const later of ['0.2.1-rc.4', '0.2.1-rc.10', '0.2.1', '0.2.2-rc.4', '0.2.5', '0.3.0', '1.2.1', 'nightly']) assert.equal(desktopCompatibility(later), 'untested', later);
  for (const older of ['0.2.1-rc.1', '0.2.0', '0.1.9']) assert.throws(() => assertDesktopVersion(older), /更新 Harness/, older);
});

test('VibeGuide mode is the current standard mode plus the communication rules, with nothing copied or rewritten', () => {
  const expression = { js: 'createRequire(baseUrl)' };
  const plugins = [{ id: 'persona', name: '@deepseek-ai/dsh-persona' }, { id: 'skills', name: '@deepseek-ai/dsh-skill-filesystem', config: { customSkillDirs: [expression] } }];
  const rows = [{ insert: [{ id: 'preset-standard', name: '@deepseek-ai/dsh-agent-preset', config: { id: 'standard', order: 1, plugins } }] }];
  const preset = vibeGuidePreset(rows, 'file:///plugins/vibeguide/dist/index.js');
  assert.equal(preset.id, 'vibeguide'); assert.equal(preset.name, 'VibeGuide'); assert.equal(preset.order, 2);
  assert.deepEqual(preset.plugins.slice(0, -1), plugins);
  assert.equal(preset.plugins[1].config.customSkillDirs[0], expression, 'host expressions must reach the registry as the same objects');
  assert.deepEqual(preset.plugins.at(-1), { id: 'vibeguide-communication', name: 'file:///plugins/vibeguide/dist/index.js' });
  assert.equal(plugins.length, 2, 'the standard definition itself is not modified');
  for (const missing of [undefined, [], [{ insert: [{ config: { id: 'minimal', plugins: [] } }] }], [{ insert: [{ config: { id: 'standard' } }] }]]) {
    assert.throws(() => vibeGuidePreset(missing, 'file:///x'), /没有找到标准模式/);
  }
});

test('missing backend gives an actionable explanation without raw transport details', async () => {
  const connection = { rpc: { call: async () => { throw new Error('transport failure for /api/vibeGuide/getSnapshot: HTTP 404'); } } };
  await assert.rejects(guideCall(connection, 'getSnapshot', { sessionId: 'one' }, new AbortController().signal), error => {
    assert.match(error.message, /更新 VibeGuide/);
    assert.match(error.message, /主对话仍可使用/);
    assert.doesNotMatch(error.message, /HTTP|transport|\/api\//);
    return true;
  });
});

test('RPC preserves mode guidance and cancellation while hiding unknown backend diagnostics', async () => {
  const controller = new AbortController();
  let result = { ok: true, value: { enabled: true } };
  const connection = { rpc: { call: async (...args) => {
    assert.equal(args[0], '/api'); assert.equal(args[1], 'vibeGuide/getSnapshot');
    assert.deepEqual(args[2], { args: { request: { sessionId: 'one' } } });
    return result;
  } } };
  const run = () => guideCall(connection, 'getSnapshot', { sessionId: 'one' }, controller.signal);
  assert.deepEqual(await run(), { enabled: true });
  result = { ok: false, error: { code: 'vibeguide/mode_required', message: '请回主对话选择 VibeGuide 模式。' } };
  await assert.rejects(run(), /选择 VibeGuide 模式/);
  result = { ok: false, error: { code: 'internal', message: 'private stack trace' } };
  await assert.rejects(run(), error => !error.message.includes('private') && error.message.includes('刷新进展'));
  controller.abort();
  connection.rpc.call = async () => { throw controller.signal.reason; };
  await assert.rejects(run(), { name: 'AbortError' });
});
