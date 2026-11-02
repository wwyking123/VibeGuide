/** Exact desktop releases exercised by the integration suite. Shared with the installer. */
export const SUPPORTED_DESKTOP_VERSIONS: readonly string[] = Object.freeze(['0.2.1-rc.2', '0.2.1-rc.3']);

export function assertDesktopVersion(version: string): void {
  if (!SUPPORTED_DESKTOP_VERSIONS.includes(version)) {
    throw new Error(`当前 Harness ${version} 尚未完成 VibeGuide 兼容验证，请更新 VibeGuide。已验证版本：${SUPPORTED_DESKTOP_VERSIONS.join('、')}。`);
  }
}
