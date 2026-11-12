import { open, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'

const MAX_ENTRIES = 40
const MAX_BYTES = 200 * 1024
const HEAD = 2048
const SKIP = /^(\.git|node_modules|\.next|dist|build|\.venv|venv|__pycache__|\.DS_Store)$|^\.env/i
const PEEK = [/^package\.json$/i, /^readme(\.[a-z]+)?$/i, /^index\.html?$/i, /^requirements\.txt$/i, /^pyproject\.toml$/i, /^app\.(py|js|ts)$/i, /^main\.(py|js|ts)$/i]

async function head(file) {
  const h = await open(file, 'r')
  try { const buf = Buffer.alloc(HEAD); const { bytesRead } = await h.read(buf, 0, HEAD, 0); return buf.subarray(0, bytesRead).toString('utf8') }
  finally { await h.close() }
}

/**
 * Bounded look at the project folder so the interview does not ask what the files already say.
 * Reads names at the top level and the first 2 KB of a few telling files. Never executes anything.
 */
export async function scanProject(root) {
  if (!root) return { empty: true, entries: [], peeks: [] }
  let names
  try { names = await readdir(root) } catch { return { empty: true, entries: [], peeks: [] } }
  const entries = names.filter((n) => !SKIP.test(n)).slice(0, MAX_ENTRIES)
  const peeks = []
  let budget = MAX_BYTES
  for (const name of entries) {
    if (!PEEK.some((re) => re.test(name)) || budget <= 0) continue
    try {
      const file = join(root, name)
      if (!(await stat(file)).isFile()) continue
      const text = await head(file)
      budget -= text.length
      peeks.push({ name, text })
    } catch { /* unreadable: skip */ }
  }
  return { empty: entries.length === 0, entries, peeks }
}

export function describeScan(scan) {
  if (scan.empty) return '项目文件夹是空的（从零开始）。'
  return [`项目文件夹里已有：${scan.entries.join('、')}`, ...scan.peeks.map((p) => `--- ${p.name} 开头 ---\n${p.text}`)].join('\n')
}
