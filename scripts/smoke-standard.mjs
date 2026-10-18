import assert from 'node:assert/strict';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { findHarness } from './harness.mjs';
import { installPreset } from './install-preset.mjs';

const { values } = parseArgs({ options: { 'harness-root': { type: 'string' } } });
const harness = await findHarness(values['harness-root']);
const temporary = await mkdtemp(join(tmpdir(), 'vibeguide-standard-'));
const previousHome = process.env.DSH_HOME;
const previousCwd = process.cwd();
process.env.DSH_HOME = temporary;
process.chdir(temporary);
let root;
try {
  const { boot, loadOptionalPatches } = await harness.import('@deepseek-ai/dsh-app-boot');
  const { scopeOf } = await harness.import('@deepseek-ai/dsh-scope');
  await installPreset({ home: temporary, harness });
  // The product launcher creates a profile module fallback. Reproduce that
  // resolution in this temporary home, using the same installed module copies.
  await symlink(join(harness.root, 'node_modules'), join(temporary, 'node_modules'), 'dir');
  const base = loadOptionalPatches('vibeguide-smoke', harness.resolve('@deepseek-ai/dsh-base/cordis.patch.yml'));
  const web = loadOptionalPatches('vibeguide-smoke', harness.resolve('@deepseek-ai/dsh-web-app/cordis.patch.yml'));
  // Use the real base services and the Web bundle's host/agent separation.
  // Exclude every Web insertion (HTTP, browser, startup, UI) and mount only
  // the preset roster. No session turn or inference is started.
  const patches = [
    ...base,
    ...web.filter(patch => !patch.insert),
    { id: 'hmr', disabled: true },
    { id: 'session-telemetry-otel', config: { mode: 'DISABLED' } },
    { id: 'session-title-llm', disabled: true },
    { id: 'fs-sandbox', config: { cwd: temporary } },
    { id: 'tools', config: { mode: 'native' } },
    { insert: [{ id: 'agent-presets', name: '@deepseek-ai/dsh-agent-presets', config: {
      default: 'standard', roots: [{ path: dirname(harness.standard), trust: 'system' }],
    } }] },
  ];
  const config = join(temporary, 'cordis.yml');
  await writeFile(config, '[]\n');
  root = await boot('vibeguide-smoke', config, patches, undefined, pathToFileURL(join(harness.root, 'lib', 'bin.js')).href);
  const standardKey = await root.agentPresets.standingKeyFor('standard');
  const vibeguideKey = await root.agentPresets.standingKeyFor('vibeguide');
  const standard = await root.systemPrompt.assemble({ scope: standardKey });
  const vibeguide = await root.systemPrompt.assemble({ scope: vibeguideKey });
  assert.ok(vibeguide.sections.some(section => section.name === 'vibeguide:communication'));
  assert.equal(standard.sections.some(section => section.name === 'vibeguide:communication'), false);
  assert.deepEqual(vibeguide.tools, standard.tools, 'all standard tool schemas must be preserved');
  assert.equal(vibeguide.tools.length, 25, 'rc.6 standard must expose its complete 25-tool catalog');
  assert.deepEqual(vibeguide.sections.filter(section => section.name !== 'vibeguide:communication'), standard.sections);

  const handle = await root.agents.create({
    sessionId: 'vibeguide-smoke-session',
    meta: { cwd: temporary, agentPreset: 'vibeguide' },
    setup: async agentCtx => { await root.agentPresets.mount(agentCtx, 'vibeguide'); },
  });
  const joined = await root.systemPrompt.assemble({ scope: scopeOf(handle.agent.ctx), agent: handle.agent });
  assert.ok(joined.sections.some(section => section.name === 'vibeguide:communication'));
  assert.ok(joined.tools.some(tool => tool.name === 'ask_user_question'), 'native questions must remain available');
  await handle.dispose();
  console.log(JSON.stringify({
    harnessVersion: harness.version,
    fullStandardMounted: true,
    standardToolCount: standard.tools.length,
    matchingToolSchemas: true,
    matchingHostAndStandardSections: true,
    realAgentCreatedAndDisposed: true,
    nativeQuestionToolPreserved: true,
    modelCalled: false,
    serverStarted: false,
    userProfileModified: false,
  }, null, 2));
} finally {
  try { if (root) await root.fiber.dispose(); }
  finally {
    process.chdir(previousCwd);
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
    await rm(temporary, { recursive: true, force: true });
  }
}
