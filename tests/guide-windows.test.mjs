import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { pathParts } from '../dist/guide/store.js';
import { appLayout } from '../scripts/desktop.mjs';
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
  assert.match(source, /Install-VibeGuide\s*$/);
});
