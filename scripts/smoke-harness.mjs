import assert from 'node:assert/strict';
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { findHarness } from './harness.mjs';
import { installPreset, PLUGIN_ROW } from './install-preset.mjs';

const { values } = parseArgs({ options: { 'harness-root': { type: 'string' } } });
const harness = await findHarness(values['harness-root']);
const temporary = await mkdtemp(join(tmpdir(), 'vibeguide-host-'));
const previousHome = process.env.DSH_HOME;
process.env.DSH_HOME = temporary;
let root;
try {
  // Import all host packages from the installed CLI, not this project's dev deps.
  const [{ Context }, { Loader }, { SystemPrompt, renderPrompt }, { AgentPresets }, { createScope }] = await Promise.all([
    harness.import('@deepseek-ai/cordis'),
    harness.import('@deepseek-ai/cordis-plugin-loader'),
    harness.import('@deepseek-ai/dsh-system-prompt'),
    harness.import('@deepseek-ai/dsh-agent-presets'),
    harness.import('@deepseek-ai/dsh-scope'),
  ]);
  const installed = await installPreset({ home: temporary, harness });
  const standardText = await readFile(join(harness.standard, 'agent.cordis.yml'), 'utf8');
  assert.equal(await readFile(join(installed.destination, 'agent.cordis.yml'), 'utf8'), standardText + PLUGIN_ROW);

  // A minimal real preset tests the loader/scope boundary without starting a
  // model, web server, shell executor, or the rest of the standard host stack.
  const probe = join(temporary, '.agent-presets', 'vibeguide-probe');
  await mkdir(probe);
  await cp(join(installed.destination, '.vibeguide-plugin'), join(probe, '.vibeguide-plugin'), { recursive: true });
  await writeFile(join(probe, 'agent.cordis.yml'), PLUGIN_ROW);
  const ordinary = join(temporary, '.agent-presets', 'ordinary-probe');
  await mkdir(ordinary);
  await writeFile(join(ordinary, 'agent.cordis.yml'), '- id: ordinary\n  name: ./ordinary.mjs\n');
  await writeFile(join(ordinary, 'ordinary.mjs'), 'export const inject = ["systemPrompt"]; export function apply(ctx) { ctx.systemPrompt.section({ name: "ordinary:marker", order: 50, text: "Ordinary preset only." }); }\n');

  root = new Context();
  await root.plugin(Loader, { baseUrl: pathToFileURL(join(harness.root, 'lib', 'bin.js')).href });
  await root.plugin(SystemPrompt, { persona: 'Host persona remains.' });
  await root.plugin(AgentPresets, { default: 'vibeguide-probe', roots: [], includeUserRoot: true });
  const discovered = await root.agentPresets.resolve('vibeguide');
  assert.equal(discovered.broken, undefined);
  const key = await root.agentPresets.standingKeyFor('vibeguide-probe');
  const ordinaryKey = await root.agentPresets.standingKeyFor('ordinary-probe');
  const agentKey = {};
  const agent = createScope(root, agentKey);
  await root.agentPresets.mount(agent.ctx, 'vibeguide-probe');
  const hasRules = assembly => assembly.sections.some(section => section.name === 'vibeguide:communication');
  const active = await root.systemPrompt.assemble({ scope: agentKey });
  assert.ok(hasRules(active));
  assert.ok(hasRules(await root.systemPrompt.assemble({ scope: key })));
  assert.equal(hasRules(await root.systemPrompt.assemble()), false);
  assert.equal(hasRules(await root.systemPrompt.assemble({ scope: ordinaryKey })), false);
  assert.equal(active.sections.some(section => section.name === 'ordinary:marker'), false);
  assert.match(renderPrompt(active), /Host persona remains/);
  await agent.dispose();
  assert.ok(hasRules(await root.systemPrompt.assemble({ scope: key })), 'standing preset survives session disposal');
  console.log(JSON.stringify({
    harnessVersion: harness.version,
    checks: ['complete standard copied without changes', 'preset discovered', 'relative plugin loaded by installed Harness', 'agent inherits rules', 'other preset and global prompt isolated', 'host persona preserved', 'prompt renders', 'shared preset lifetime preserved'],
    modelCalled: false,
    fullStandardMounted: false,
    userProfileModified: false,
  }, null, 2));
} finally {
  try { if (root) await root.fiber.dispose(); }
  finally {
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
    await rm(temporary, { recursive: true, force: true });
  }
}
