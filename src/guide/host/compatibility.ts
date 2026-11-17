/** Exact desktop releases exercised by the integration suite. Shared with the installer. */
export const SUPPORTED_DESKTOP_VERSIONS: readonly string[] = Object.freeze(['0.2.1-rc.2', '0.2.1-rc.3', '0.2.2-rc.3']);

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
 * Harness updates itself, so anything other than a release older than the first one we worked with
 * loads and is tried. Releases we have not run the integration suite on report as `untested`, which
 * the settings page mentions in one line. Refusing them would only guarantee a dead sidebar.
 */
export function desktopCompatibility(version: string): 'verified' | 'untested' {
  if (SUPPORTED_DESKTOP_VERSIONS.includes(version)) return 'verified';
  const current = parse(version), oldest = parse(SUPPORTED_DESKTOP_VERSIONS[0]!);
  if (current && oldest && compare(current, oldest) < 0) {
    throw new Error(`当前 Harness ${version} 比这个 VibeGuide 支持的最早版本 ${SUPPORTED_DESKTOP_VERSIONS[0]} 还旧，请先更新 Harness。`);
  }
  return 'untested';
}

export function assertDesktopVersion(version: string): void { desktopCompatibility(version); }
