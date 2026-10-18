import { readFileSync } from 'node:fs';
import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-system-prompt';

export const name = 'vibeguide';
export const inject = ['systemPrompt'];
export const POLICY_VERSION = '2026-10-18.1';
export const SECTION_NAME = 'vibeguide:communication';

/** Structural port keeps the distributed .d.ts independent of host packages. */
export interface VibeGuideContext {
  systemPrompt: {
    section(section: { name: string; order: number; text: string }): unknown;
  };
}

// Type-only host imports are deliberate: the running Harness owns the registry
// and scope identity. Loading another copy of dsh-scope would split that identity.
const policy = readFileSync(new URL('../prompts/core.md', import.meta.url), 'utf8').trim();
if (!policy || policy.includes('{{')) {
  throw new Error('VibeGuide policy must be nonempty and contain no Harness variable references.');
}

/** Mount through an agent preset, never as a global host-plane plugin. */
export const apply = ((ctx: VibeGuideContext): void => {
  // The injected service binds registrations to this plugin's calling scope and
  // owns their disposal. No second agent, turn listener, or user-state cache.
  ctx.systemPrompt.section({
    name: SECTION_NAME,
    order: 300,
    text: `VibeGuide communication policy ${POLICY_VERSION}\n\n${policy}`,
  });
}) satisfies (ctx: Context) => void;
