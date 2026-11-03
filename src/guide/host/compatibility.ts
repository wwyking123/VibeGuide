/** Exact desktop releases exercised by the integration suite. Shared with the installer. */
export const SUPPORTED_DESKTOP_VERSIONS: readonly string[] = Object.freeze(['0.2.1-rc.2', '0.2.1-rc.3']);

const parse = (version: string) => {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(version);
  return match && { core: match.slice(1, 4).map(Number), pre: match[4]?.split('.') ?? [] };
};
/** Semver precedence: a release ranks above its prereleases; numeric identifiers compare as numbers. */
function compare(a: NonNullable<ReturnType<typeof parse>>, b: NonNullable<ReturnType<typeof parse>>) {
  for (let i = 0; i < 3; i++) if (a.core[i] !== b.core[i]) return a.core[i]! - b.core[i]!;
  if (!a.pre.length || !b.pre.length) return b.pre.length - a.pre.length;
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    const x = a.pre[i], y = b.pre[i];
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
    if (x === y) continue;
    const nx = /^\d+$/.test(x), ny = /^\d+$/.test(y);
    return nx && ny ? Number(x) - Number(y) : nx ? -1 : ny ? 1 : x < y ? -1 : 1;
  }
  return 0;
}

/**
 * Later builds of the same minor line usually keep the APIs we use, so they load as `untested` instead of
 * leaving the sidebar dead after an automatic Harness update. Older or other-line releases still refuse.
 */
export function desktopCompatibility(version: string): 'verified' | 'untested' {
  if (SUPPORTED_DESKTOP_VERSIONS.includes(version)) return 'verified';
  const current = parse(version), oldest = parse(SUPPORTED_DESKTOP_VERSIONS[0]!), newest = parse(SUPPORTED_DESKTOP_VERSIONS.at(-1)!);
  if (current && oldest && newest && current.core[0] === newest.core[0] && current.core[1] === newest.core[1] && compare(current, oldest) > 0) return 'untested';
  throw new Error(`当前 Harness ${version} 与这个 VibeGuide 不兼容，请更新 VibeGuide。已验证版本：${SUPPORTED_DESKTOP_VERSIONS.join('、')}。`);
}

export function assertDesktopVersion(version: string): void { desktopCompatibility(version); }
