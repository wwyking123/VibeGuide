import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { once } from 'node:events';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { register, makeDemoEntries } from './fixture/registration.mjs';
import { createDemoServer } from './fixture/server.mjs';

const readJSON = async name => JSON.parse(await readFile(new URL(name, import.meta.url), 'utf8'));
const [scenario, template, manifest] = await Promise.all([
  readJSON('scenario.json'), readJSON('result-template.json'), readJSON('fixture-manifest.json'),
]);
assert.equal(scenario.executionStatus, 'not_run');
assert.equal(template.executionStatus, 'not_run');
assert.equal(template.scenarioId, scenario.id);
assert.equal(template.protocolVersion, scenario.protocolVersion);
assert.deepEqual(scenario.stages.map(item => item.id), template.stages.map(item => item.id));
assert.deepEqual(scenario.boundaryCases.map(item => item.id), template.boundaryCases.map(item => item.id));
assert.deepEqual(scenario.criticalDecision.options.map(item => item.id), ['reject', 'waitlist']);
assert.equal(scenario.criticalDecision.humanObservationRequired, true);
assert.equal(template.summary.humanUnderstanding, 'not_run');
assert.equal(template.decision.firstUserRestatementVerbatim, null);
assert.equal(template.decision.userChoice, null);
for (const item of [...template.stages, ...template.boundaryCases]) assert.equal(item.status, 'not_run');
assert.equal(new Set([...scenario.stages, ...scenario.boundaryCases].map(item => item.id)).size,
  scenario.stages.length + scenario.boundaryCases.length);

const files = await readdir(new URL('./fixture/', import.meta.url));
assert.deepEqual(files.sort(), Object.keys(manifest.files).sort());
for (const [filename, expected] of Object.entries(manifest.files)) {
  const path = new URL(`./fixture/${filename}`, import.meta.url);
  assert.equal(createHash('sha256').update(await readFile(path)).digest('hex'), expected, filename);
  if (filename.endsWith('.mjs')) {
    const syntax = spawnSync(process.execPath, ['--check', fileURLToPath(path)], { encoding: 'utf8' });
    assert.equal(syntax.status, 0, syntax.stderr);
  }
}

const entries = makeDemoEntries(19);
const twentieth = register(entries, { name: '演示二十', email: 'twenty@example.test' });
assert.equal(twentieth.ok, true);
assert.equal(entries.length, 19, 'registration must not mutate the supplied baseline');
assert.equal(twentieth.entries.length, 20);
const twentyFirst = register(twentieth.entries, { name: '演示二十一', email: 'twenty-one@example.test' });
assert.equal(twentyFirst.ok, true, 'original fixture intentionally has no attendance limit');
assert.equal(twentyFirst.entries.length, 21);
assert.equal(twentyFirst.entries.every(entry => entry.status === 'confirmed'), true);
const duplicate = register(twentyFirst.entries, { name: '重复报名', email: ' TWENTY@example.test ' });
assert.equal(duplicate.ok, false);
assert.equal(duplicate.entries.length, 21);
assert.equal(register([], { name: '', email: 'bad' }).ok, false);

const server = createDemoServer();
server.listen(0, '127.0.0.1');
await once(server, 'listening');
try {
  const origin = `http://127.0.0.1:${server.address().port}`;
  const page = await fetch(origin);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /本机演示/);
  assert.match(html, /没有真实登录或访问控制/);
  assert.match(html, /id="organizer-view"[^>]* hidden/);
  for (const asset of ['/app.mjs', '/registration.mjs', '/style.css']) {
    const response = await fetch(`${origin}${asset}`);
    assert.equal(response.status, 200);
    await response.arrayBuffer();
  }
  for (const privatePath of ['/README.md', '/server.mjs', '/.vibeguide/project.json', '/../scenario.json']) {
    const response = await fetch(`${origin}${privatePath}`);
    assert.equal(response.status, 404, privatePath);
    await response.arrayBuffer();
  }
  const post = await fetch(origin, { method: 'POST' });
  assert.equal(post.status, 405);
  await post.arrayBuffer();
} finally {
  await new Promise(resolve => server.close(resolve));
}
console.log('Fixture checks passed: frozen files, protocol/template consistency, original registration behavior, loopback HTTP assets and private-path exclusion.');
console.log('Not run: browser interaction/visual QA, real model conversations, persistence fault injection, cross-session behavior or human understanding.');
