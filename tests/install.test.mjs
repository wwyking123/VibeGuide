import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { installPreset, PLUGIN_ROW } from '../scripts/install-preset.mjs';

test('installation preserves base composition/assets and ships a standalone local plugin', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'vibeguide-install-'));
  try {
    const standard = join(temporary, 'base standard');
    await mkdir(join(standard, 'assets'), { recursive: true });
    const original = '# Preserve custom YAML tags.\n- id: shell\n  name: example-shell\n  disabled: !!js process.platform === "win32"\n';
    await writeFile(join(standard, 'agent.cordis.yml'), original);
    await writeFile(join(standard, 'assets', 'guide.md'), 'unchanged');
    await mkdir(join(temporary, 'code'));
    const home = join(temporary, 'test home');
    const result = await installPreset({ home, harness: { standard, version: '0.1.0-rc.6' } });
    assert.equal(await readFile(join(result.destination, 'agent.cordis.yml'), 'utf8'), original + PLUGIN_ROW);
    assert.equal(await readFile(join(result.destination, 'assets', 'guide.md'), 'utf8'), 'unchanged');
    assert.equal(await readFile(join(standard, 'agent.cordis.yml'), 'utf8'), original);
    const manifest = JSON.parse(await readFile(join(result.destination, '.vibeguide.json'), 'utf8'));
    assert.equal(manifest.baseCompositionSha256, createHash('sha256').update(original).digest('hex'));
    const pluginRoot = join(result.destination, '.vibeguide-plugin');
    const installedPackage = JSON.parse(await readFile(join(pluginRoot, 'package.json'), 'utf8'));
    assert.equal(installedPackage.dependencies, undefined);
    assert.equal(installedPackage.peerDependencies, undefined);
    for (const file of await readdir(join(pluginRoot, 'dist'), { recursive: true })) {
      if (!/\.(?:js|mjs|cjs|d\.ts)$/.test(file)) continue;
      const text = await readFile(join(pluginRoot, 'dist', file), 'utf8');
      assert.ok(!text.includes('@deepseek-ai/'), `${file} must not import a second host instance or require external types`);
    }
    assert.equal((await stat(result.destination)).mode & 0o777, 0o700);
    assert.equal((await stat(join(pluginRoot, 'package.json'))).mode & 0o777, 0o600);
    await assert.rejects(installPreset({ home, harness: { standard, version: '0.1.0-rc.6' } }), /已存在/);
    assert.equal(await readFile(join(result.destination, 'agent.cordis.yml'), 'utf8'), original + PLUGIN_ROW);
    for (const id of ['../escape', '/absolute', 'standard', 'a/b']) {
      await assert.rejects(installPreset({ home, id, harness: { standard } }), /preset id/);
    }
    await assert.rejects(installPreset({ home, id: 'code', harness: { standard } }), /重名/);
    await mkdir(join(home, '.agent-presets', 'empty-existing'));
    await assert.rejects(installPreset({ home, id: 'empty-existing', harness: { standard } }), /已存在/);
    assert.deepEqual(await readdir(join(home, '.agent-presets', 'empty-existing')), []);
    assert.deepEqual((await readdir(join(home, '.agent-presets'))).sort(), ['empty-existing', 'vibeguide']);
    assert.deepEqual(await readdir(home), ['.agent-presets'], 'must not create or edit host profiles');
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
