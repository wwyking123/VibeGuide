import { readdir, open, constants } from 'node:fs/promises';
import { dirname, extname, join, posix } from 'node:path';
import type { ProjectStore, ProjectRecord } from '../continuity/store.js';
import type { Workbench } from './state.js';
import { ensure } from './ledger.js';
import { currentFacts } from './memory.js';
const ignored = new Set(['node_modules', 'dist', 'build', 'coverage', 'vendor', 'artifacts', 'target']);
const extensions = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.css', '.html', '.json'];
/** Bounded static-reference graph; uncertainty is returned, never treated as absence of impact. */
export async function analyzeImpact(store: ProjectStore, state: Workbench, record: ProjectRecord, targets: string[]) {
  ensure(targets.length > 0 && targets.length <= 20, 'Select 1–20 changed/proposed files.');
  for (const file of targets) await store.stamp(file);
  const files = new Map<string, string>(), warnings = new Set<string>(); let bytes = 0;
  async function walk(relative = '') {
    for (const entry of await readdir(join(store.projectRoot, relative), { withFileTypes: true })) {
      if (entry.name.startsWith('.') || ignored.has(entry.name) || entry.isSymbolicLink()) continue;
      const path = relative ? `${relative}/${entry.name}` : entry.name;
      if (files.size >= 600 || bytes > 3 * 1024 * 1024) { warnings.add('扫描达到上限，未覆盖整个项目'); return; }
      if (entry.isDirectory()) { await walk(path); continue; }
      if (!entry.isFile() || !extensions.includes(extname(path))) continue;
      const handle = await open(join(store.projectRoot, path), constants.O_RDONLY | constants.O_NOFOLLOW);
      try { const stat = await handle.stat(); if (stat.size > 128 * 1024) { warnings.add(`大文件未分析：${path}`); continue; } const text = await handle.readFile('utf8'); bytes += stat.size; files.set(path, text); }
      finally { await handle.close(); }
    }
  }
  await walk();
  const aliases: Record<string, string[]> = {};
  try { const config = JSON.parse(files.get('tsconfig.json') ?? '{}'); for (const [key, value] of Object.entries(config.compilerOptions?.paths ?? {})) if (Array.isArray(value)) aliases[key] = value.filter(v => typeof v === 'string').map(v => posix.join(config.compilerOptions?.baseUrl ?? '.', v)); }
  catch { warnings.add('带注释或扩展配置的路径别名尚未解析'); }
  const edges: { from: string; to: string }[] = [], unresolved: { file: string; reference: string }[] = [];
  for (const [file, source] of files) {
    const pattern = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s*|@import\s*|\bsrc\s*=\s*)['"]([^'"]+)['"]/g;
    for (const match of source.matchAll(pattern)) {
      const ref = match[1]!; let candidates: string[] = [];
      if (ref.startsWith('.')) candidates = [posix.normalize(posix.join(dirname(file), ref))];
      else if (ref.startsWith('/') && !ref.startsWith('//')) candidates = [posix.normalize(ref.slice(1))];
      else for (const [alias, paths] of Object.entries(aliases)) {
        const prefix = alias.split('*')[0]!;
        if (alias.includes('*') ? ref.startsWith(prefix) : ref === alias) candidates.push(...paths.map(p => p.replace('*', ref.slice(prefix.length))));
      }
      if (!candidates.length) { if (ref.startsWith('@/') || ref.startsWith('~/')) unresolved.push({ file, reference: ref }); continue; }
      const target = candidates.flatMap(p => [p, ...extensions.map(e => p + e), ...extensions.map(e => posix.join(p, 'index' + e)), ...(p.endsWith('.js') ? [p.slice(0, -3) + '.ts', p.slice(0, -3) + '.tsx'] : [])]).find(p => files.has(p));
      if (target) edges.push({ from: file, to: target }); else unresolved.push({ file, reference: ref });
    }
    if (/\b(?:import|require)\s*\(\s*[^'"\s]/.test(source)) warnings.add(`存在动态依赖，需人工检查：${file}`);
  }
  const affected = new Set(targets.map(p => posix.normalize(p)));
  if (targets.some(p => /(?:^|\/)(?:package(?:-lock)?\.json|pnpm-lock\.yaml|yarn\.lock|tsconfig[^/]*\.json|vite\.config\.[^/]+)$/.test(p))) {
    for (const path of files.keys()) affected.add(path);
    warnings.add('依赖或构建配置变化可能影响整个项目，已扩大建议检查范围');
  }
  for (let added = true; added;) { added = false; for (const edge of edges) if (affected.has(edge.to) && !affected.has(edge.from)) { affected.add(edge.from); added = true; } }
  const liveFacts = currentFacts(record, state);
  const related = new Set(liveFacts.filter(f => f.files.some(p => affected.has(p))).map(f => f.id));
  for (let added = true; added;) { added = false; for (const f of liveFacts) if (f.relatedIds.some(id => related.has(id)) && !related.has(f.id)) { related.add(f.id); added = true; } }
  const facts = liveFacts.filter(f => related.has(f.id)), checks = state.checks.filter(c => c.files.some(p => affected.has(p)) || c.requirementIds.some(id => facts.some(f => f.requirementIds.includes(id))));
  const requirementIds = new Set([...facts.flatMap(f => f.requirementIds), ...checks.flatMap(c => c.requirementIds)]);
  return { targets, affectedFiles: [...affected], relationships: edges.filter(e => affected.has(e.to)), affectedProjectFacts: facts,
    requirementsToPreserve: record.requirements.filter(r => r.status === 'active' && (requirementIds.has(r.id) || !r.taskId)),
    regressionChecks: checks, relatedTestFiles: [...affected].filter(p => /(?:^|\/)(?:tests?|__tests__)\/|\.(?:test|spec)\./.test(p)), unresolved: unresolved.slice(0, 100), warnings: [...warnings],
    coverage: { scannedFiles: files.size, staticReferencesOnly: true, dynamicBehaviorVerified: false, checksExecuted: false },
    note: '这是静态引用与已记录业务关系的影响建议，不证明没有其他影响；不会改变要求或执行修改。请通过宿主工具运行相关检查并记录结果。' };
}
