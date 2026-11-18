import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { pathParts } from '../dist/guide/store.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { appLayout, prepareDesktopPlugin } from '../scripts/desktop.mjs';
import { selfTest } from '../scripts/selftest.mjs';

test('storage folders are split by the system separator, so a Windows path is not one giant folder name', () => {
  assert.deepEqual(pathParts('C:\\Users\\li\\.dsh\\vibeguide-v2-state\\guide-v1', 'C:\\', '\\'), ['Users', 'li', '.dsh', 'vibeguide-v2-state', 'guide-v1']);
  assert.deepEqual(pathParts('/Users/li/.dsh/state/guide-v1', '/', '/'), ['Users', 'li', '.dsh', 'state', 'guide-v1']);
});

test('the installer finds the app files in a macOS bundle and in a Windows folder', () => {
  assert.deepEqual(appLayout('/Applications/DeepSeek Harness.app', false), {
    executable: '/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness', resources: '/Applications/DeepSeek Harness.app/Contents/Resources' });
  const windows = appLayout('C:/Programs/DeepSeek Harness', true);
  assert.match(windows.executable, /DeepSeek Harness\.exe$/);
  assert.match(windows.resources, /resources$/);
});

test('the plugin location is recorded as a file URL, which the Harness can also resolve on Windows', async () => {
  const directory = join(await mkdtemp(join(tmpdir(), 'vibeguide-prepare-')), 'plugin');
  try {
    const prepared = await prepareDesktopPlugin({ anchor: '/harness/package.json', dump: JSON.stringify }, directory);
    const recorded = prepared.patch.insert[0].config.path;
    assert.equal(fileURLToPath(recorded), join(directory, 'preset.cordis.yml'));
    // The Harness resolves the recorded value against the profile folder's URL, exactly like this.
    const profile = 'file:///C:/Users/li/.dsh/profiles/desktop/';
    assert.equal(new URL(pathToFileURL(join(directory, 'preset.cordis.yml')).href, profile).protocol, 'file:');
    assert.equal(new URL('file:///C:/Users/li/.dsh/plugins/vibeguide/preset.cordis.yml', profile).protocol, 'file:');
    assert.equal(new URL('C:\\Users\\li\\.dsh\\plugins\\vibeguide\\preset.cordis.yml', profile).protocol, 'c:', 'a plain Windows path is not a file location to the Harness');
  } finally { await rm(join(directory, '..'), { recursive: true, force: true }); }
});

test('installed as a bundle the records default to the folder the one-line installer has always used', async () => {
  const { defaultStorageRoot } = await import('../dist/guide/plugin.js');
  assert.equal(defaultStorageRoot({}, '/Users/li'), join('/Users/li', '.dsh', 'vibeguide-p0-state'));
  assert.equal(defaultStorageRoot({ DSH_HOME: '/data/dsh' }, '/Users/li'), join('/data/dsh', 'vibeguide-p0-state'));
  assert.equal(defaultStorageRoot({ DSH_HOME: '  ' }, '/Users/li'), join('/Users/li', '.dsh', 'vibeguide-p0-state'));
});

test('the package declares a Harness bundle whose rows name nothing outside the package', () => {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const patch = readFileSync(new URL(`../${manifest.dsh.bundle.patch}`, import.meta.url), 'utf8');
  assert.ok(manifest.files.includes('cordis.patch.yml'));
  assert.equal(manifest.os, undefined, 'an os list would stop the Harness installing it on Windows');
  const names = [...patch.matchAll(/^\s+name: (\S+)$/gm)].map(match => match[1]);
  assert.deepEqual(names, ['vibeguide', 'vibeguide/preset']);
  for (const name of names) assert.ok(manifest.exports[name === 'vibeguide' ? '.' : `./${name.split('/')[1]}`], name);
  assert.ok(manifest.dsh.client.inject.length > 0);
  assert.doesNotMatch(patch, /^\s+config:/m);
});

test('the pre-install self-test passes on this machine and leaves nothing behind', async () => {
  await selfTest();
});

test('the Windows installer avoids syntax that the built-in PowerShell 5.1 cannot run', () => {
  const source = readFileSync(new URL('../install.ps1', import.meta.url), 'utf8');
  // Drop comments and string contents so only code structure is inspected.
  const code = source.split('\n').map(line => line.replace(/^\s*#.*$/, '')).join('\n')
    .replace(/'(?:[^']|'')*'/g, "''").replace(/"(?:[^"`]|`.)*"/g, '""');
  for (const [open, close] of [['{', '}'], ['(', ')'], ['[', ']']]) {
    assert.equal(code.split(open).length, code.split(close).length, `unbalanced ${open}${close}`);
  }
  assert.doesNotMatch(code, /\?\?|&&|\|\||\?\s*[^:\s]+\s*:/, 'PowerShell 7-only operator');
  assert.doesNotMatch(code, /\bexit\b/, 'exit would close the window when run through iex');
  // A variable name must never run straight into a full-width character.
  assert.doesNotMatch(source, /\$[A-Za-z_][A-Za-z0-9_]*[\u3000-\u9fff\uff00-\uffef]/);
  // Mirrors serve the script without a charset, and PowerShell 5.1 then reads it as Latin-1.
  // The script must notice and restore itself; that only works while the misreading loses nothing
  // and produces no character PowerShell would treat as a quote or a dash.
  assert.match(source, /if \('中'\.Length -eq 1\) \{ Install-VibeGuide \}\s*\nelse \{[^]*GetEncoding\(28591\)[^]*\}\s*$/);
  const misread = readFileSync(new URL('../install.ps1', import.meta.url)).toString('latin1');
  assert.equal(Buffer.from(misread, 'latin1').toString('utf8'), source);
  assert.doesNotMatch(misread, /[\u2010-\u201f]/);
  assert.notEqual([...misread.match(/if \('([^']+)'\.Length -eq 1\)/)[1]].length, 1, 'the probe character must read as more than one character when misdecoded');
});
