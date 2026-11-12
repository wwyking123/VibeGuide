import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

/** Host versions this release was run against (see docs/M0_REPORT.md and the M1 integration run). */
export const TESTED = ['0.2.1-rc.2']

/** Reads the running Harness version: the dsh CLI is argv[1] in both DSH Desktop and `dsh web`. */
export function hostVersion(argv = process.argv) {
  try {
    const bin = argv[1] ?? ''
    if (/@deepseek-ai[\\/]dsh[\\/]lib[\\/]bin\.js$/.test(bin)) return JSON.parse(readFileSync(join(dirname(bin), '..', 'package.json'), 'utf8')).version
  } catch { /* fall through */ }
  try { return createRequire(import.meta.url)('@deepseek-ai/dsh/package.json').version } catch { return undefined }
}

const minor = (v) => /^(\d+)\.(\d+)\./.exec(v ?? '')?.slice(1, 3).join('.')

/**
 * UI-6: tested → everything on; same minor line → on, with a notice; other versions → rule-based
 * alerts only. An unreadable version is treated like an untested one on the tested line, and says so.
 */
export function compatibility(version) {
  if (version && TESTED.includes(version)) return { level: 'tested', version }
  if (!version) return { level: 'untested', version: null, notice: '读不到当前 DSH 的版本号，VibeGuide 按"未一起测试过"处理。' }
  if (TESTED.some((t) => minor(t) === minor(version))) return { level: 'untested', version, notice: `当前 DSH（${version}）还没和这个版本的 VibeGuide 一起测试过，可能有个别功能不正常。` }
  return { level: 'rules-only', version, notice: `当前 DSH（${version}）和这个版本的 VibeGuide 不匹配，只保留卡住提醒。请更新 VibeGuide。` }
}
