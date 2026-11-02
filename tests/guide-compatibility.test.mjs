import assert from 'node:assert/strict';
import test from 'node:test';
import { assertDesktopVersion } from '../dist/guide/host/compatibility.js';
import { guideCall } from '../dist/client/rpc.js';

test('desktop compatibility admits verified releases and rejects untested upgrades', () => {
  assert.doesNotThrow(() => assertDesktopVersion('0.2.1-rc.2'));
  assert.doesNotThrow(() => assertDesktopVersion('0.2.1-rc.3'));
  assert.throws(() => assertDesktopVersion('0.2.1-rc.4'), /尚未完成.*兼容验证/);
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
