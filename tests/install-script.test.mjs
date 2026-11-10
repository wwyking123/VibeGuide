import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../install.sh', import.meta.url));
const run = env => spawnSync('sh', [script], { env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env }, encoding: 'utf8' });
/** A stand-in app whose "Harness" binary only records that it was started. */
function fakeApp(root) {
  const bin = join(root, 'Fake.app', 'Contents', 'MacOS');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'DeepSeek Harness'), `#!/bin/sh\ntouch "${join(root, 'ran')}"\n`);
  chmodSync(join(bin, 'DeepSeek Harness'), 0o755);
  return join(root, 'Fake.app');
}

test('one-line installer stops with a plain message before touching anything', { skip: process.platform !== 'darwin' }, () => {
  const root = mkdtempSync(join(tmpdir(), 'vibeguide-install-'));
  const missingApp = run({ VIBEGUIDE_APP: join(root, 'Nope.app'), VIBEGUIDE_HOME: root });
  assert.equal(missingApp.status, 1);
  assert.match(missingApp.stderr, /没有找到 DeepSeek Harness/);

  const neverOpened = run({ VIBEGUIDE_APP: fakeApp(root), VIBEGUIDE_HOME: join(root, 'home') });
  assert.equal(neverOpened.status, 1);
  assert.match(neverOpened.stderr, /请先打开一次 DeepSeek Harness/);
  assert.doesNotMatch(neverOpened.stdout, /正在下载/);
});
