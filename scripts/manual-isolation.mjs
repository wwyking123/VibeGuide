import { realpath, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { dirname } from 'node:path';

// Every Harness host and its descendants run inside this OS file boundary.
// Changing the Harness permission dropdown cannot widen the outer boundary.
export async function isolationPolicy(directory, app, otherPort, workspace) {
  const quote = value => JSON.stringify(value);
  const writable = [await realpath(directory)];
  if (workspace) writable.push(await realpath(workspace));
  const roots = [...writable, app, '/System', '/usr', '/bin', '/sbin', '/Library', '/opt/homebrew', '/private/etc', '/dev'];
  const readable = new Set();
  for (const root of roots) {
    try { readable.add(await realpath(root)); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const ancestors = new Set(['/']);
  for (const root of readable) {
    for (let parent = dirname(root); !ancestors.has(parent); parent = dirname(parent)) ancestors.add(parent);
  }
  return [
    '(version 1)',
    '(allow default)',
    '(deny file-read-data file-write*)',
    // Node/dyld open parent directories while resolving their runtime paths.
    // Literal directory access does not grant access to files below them.
    ...[...ancestors].map(root => `(allow file-read-data (literal ${quote(root)}))`),
    ...[...readable].map(root => `(allow file-read-data (subpath ${quote(root)}))`),
    ...writable.map(root => `(allow file-write* (subpath ${quote(root)}))`),
    '(allow file-write-data (literal "/dev/null") (literal "/dev/tty"))',
    ...(otherPort ? [`(deny network-outbound (remote tcp "localhost:${otherPort}"))`] : []),
    '',
  ].join('\n');
}

export function isolatedEnvironment(directory, executable) {
  // Do not pass unrelated API keys, shell hooks, or another agent's environment.
  const env = {};
  for (const key of ['PATH', 'LANG', 'LC_ALL', 'LC_CTYPE', 'USER', 'LOGNAME', 'SHELL', 'HOME']) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return {
    ...env,
    DSH_HOME: `${directory}/home`,
    TMPDIR: `${directory}/tmp`,
    XDG_CACHE_HOME: `${directory}/cache`,
    npm_config_cache: `${directory}/cache/npm`,
    DSH_TELEMETRY_DISABLED: '1',
    ELECTRON_RUN_AS_NODE: '1',
    DSH_DESKTOP_NODE_EXECUTABLE: executable,
  };
}

export async function probeFileIsolation({ directory, other, policy, executable }) {
  const marker = `${directory}/probe.txt`;
  await writeFile(marker, 'local isolation probe\n', { mode: 0o600 });
  const program = `
    const fs = require('node:fs');
    const {spawnSync} = require('node:child_process');
    const assert = require('node:assert/strict');
    assert.equal(fs.readFileSync(process.argv[1], 'utf8'), 'local isolation probe\\n');
    for (const path of process.argv.slice(2)) {
      assert.throws(() => fs.readFileSync(path), e => ['EACCES','EPERM'].includes(e.code));
      const child = spawnSync('/bin/cat', [path], {encoding:'utf8'});
      assert.notEqual(child.status, 0);
      assert.equal(child.stdout, '');
    }
    console.log('file isolation passed');
  `;
  const result = spawnSync('/usr/bin/sandbox-exec', ['-f', policy, executable, '-e', program, marker, `${other}/probe.txt`, `${directory}/other-link/probe.txt`], {
    cwd: directory, env: isolatedEnvironment(directory, executable), encoding: 'utf8', timeout: 15000,
  });
  if (result.status !== 0) throw new Error(`Isolation probe failed (${result.status ?? result.signal}): ${result.stderr || result.error?.message || result.stdout}`);
  return { directReadBlocked: true, childReadBlocked: true, symlinkReadBlocked: true };
}
