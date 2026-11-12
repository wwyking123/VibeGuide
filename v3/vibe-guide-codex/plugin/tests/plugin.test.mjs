import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import { SystemPrompt, renderPrompt } from '@deepseek-ai/dsh-system-prompt';
import * as plugin from '../dist/index.js';

const hostRequire = createRequire(import.meta.resolve('@deepseek-ai/dsh-system-prompt'));
const { createScope } = await import(pathToFileURL(hostRequire.resolve('@deepseek-ai/dsh-scope')).href);

test('rules are scoped, inherited, reassembled and disposed through real Cordis', async () => {
  const root = new Context();
  try {
    await root.plugin(SystemPrompt, { persona: 'Existing coding persona.' });
    root.systemPrompt.section({ name: 'existing:permission', order: 100, text: 'Existing permission guidance.' });
    root.systemPrompt.context({ name: 'existing:runtime', order: 0, text: 'Existing runtime facts.' });
    root.systemPrompt.tools(() => ({ schemas: [{ name: 'existing_tool', description: 'Existing tool', parameters: { type: 'object', properties: {} } }] }));
    const presetKey = {};
    const firstKey = {};
    const secondKey = {};
    const ordinaryKey = {};
    const preset = createScope(root, presetKey);
    const first = createScope(root, firstKey, { parent: presetKey });
    const second = createScope(root, secondKey, { parent: presetKey });
    const ordinary = createScope(root, ordinaryKey);
    const baseline = await root.systemPrompt.assemble();
    const mounted = await preset.ctx.plugin(plugin);

    for (const scope of [presetKey, firstKey, secondKey]) {
      for (let turn = 0; turn < 2; turn++) {
        const assembly = await root.systemPrompt.assemble({ scope });
        const sections = assembly.sections.filter(item => item.name === plugin.SECTION_NAME);
        assert.equal(sections.length, 1);
        assert.match(sections[0].text, /VibeGuide communication policy/);
        assert.deepEqual(assembly.sections.filter(item => item.name !== plugin.SECTION_NAME), baseline.sections);
        assert.deepEqual(assembly.contexts, baseline.contexts);
        assert.deepEqual(assembly.tools, baseline.tools);
        assert.doesNotThrow(() => renderPrompt(assembly));
      }
    }
    assert.deepEqual(await root.systemPrompt.assemble(), baseline, 'must not affect global prompt');
    assert.deepEqual(await root.systemPrompt.assemble({ scope: ordinaryKey }), baseline, 'must not affect ordinary sessions');

    await first.dispose();
    assert.ok((await root.systemPrompt.assemble({ scope: secondKey })).sections.some(item => item.name === plugin.SECTION_NAME), 'closing a session must not unload a shared preset');
    await mounted.dispose();
    assert.deepEqual(await root.systemPrompt.assemble({ scope: secondKey }), baseline, 'unloading must remove the rule');

    await preset.ctx.plugin(plugin);
    assert.equal((await root.systemPrompt.assemble({ scope: secondKey })).sections.filter(item => item.name === plugin.SECTION_NAME).length, 1, 'reloading must not duplicate rules');
    await preset.dispose();
    assert.deepEqual(await root.systemPrompt.assemble({ scope: secondKey }), baseline);
    await second.dispose();
    await ordinary.dispose();
  } finally {
    await root.fiber.dispose();
  }
});
