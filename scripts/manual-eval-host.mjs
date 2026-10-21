import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { desktopHost } from './desktop.mjs';

const directory = dirname(dirname(fileURLToPath(import.meta.url)));
const config = JSON.parse(await readFile(join(directory, 'run.json'), 'utf8'));
process.chdir(config.workspace ?? join(directory, 'workspace'));
const host = await desktopHost(config.app);
const { loadProfileDirectory, loadLayeredEnv } = await host.load('@deepseek-ai/dsh-app-boot');
const { runProfile } = await host.load('@deepseek-ai/dsh/profile-boot');
const web = await host.load('@deepseek-ai/dsh-web-app');
web.internals.openBrowser = async () => { throw new Error('Open the printed comparison URL manually.'); };
const profile = loadProfileDirectory('vibeguide-manual', join(directory, 'home', 'profiles', 'desktop'), host.anchor);
let root;
try {
  const application = await runProfile({
    environment: loadLayeredEnv('vibeguide-manual'), profile: 'desktop',
    resolvedProfile: { profile, installAnchor: host.anchor },
    patchFiles: [],
    args: ['--no-open', '--host', '127.0.0.1', '--port', String(config.port)],
  });
  root = application.ctx;
  const roster = await root.agentPresets.list();
  assert.ok(roster.some(preset => preset.id === config.preset && !preset.broken));
  assert.equal((await root.agentPresets.resolve()).id, config.preset, 'New chats must use the intended default preset.');
  const lease = await root.agentPresets.acquireScope(config.preset);
  const assembly = await root.systemPrompt.assemble({ scope: lease.key });
  const hasPolicy = assembly.sections.some(section => section.name === 'vibeguide:communication');
  assert.equal(hasPolicy, config.preset === 'vibeguide');
  // Cold preset inspection excludes tools materialized only for a live Agent.
  assert.ok(assembly.tools.some(tool => tool.name === 'ask_user_question'));
  await lease[Symbol.asyncDispose]();
  await root.workspaceRegistry.create(process.cwd(), config.workspaceTitle ?? '公司官网');
  const account = await root.deepseekAccount.getState();
  // Different hostnames keep browser cookies separate as well as localStorage.
  const hostname = config.label === 'A' ? 'localhost' : '127.0.0.1';
  const url = root.connection.authenticatedUrl(`${root.webServer.protocol}//${hostname}:${root.webServer.port}`);
  await writeFile(join(directory, 'ready.json'), JSON.stringify({
    pid: process.pid, url, preset: config.preset, tools: assembly.tools,
    hasPolicy, accountStatus: account.status, preflightModelCalled: false, workspace: process.cwd(),
  }, null, 2), { mode: 0o600 });
  await new Promise(resolve => {
    process.once('SIGTERM', resolve);
    process.once('SIGINT', resolve);
  });
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  if (root) await root.fiber.dispose();
}
