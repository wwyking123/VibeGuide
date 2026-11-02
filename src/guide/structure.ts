import { captureFiles, changedFiles } from './files.js';
import type { FingerprintCache } from './files.js';
import type { Overview } from './project-types.js';
export class ProjectIndex {
  private roots = new Map<string, FingerprintCache>();
  async scan(root: string, excluded: string[]) {
    if (!this.roots.has(root)) { if (this.roots.size >= 8) this.roots.delete(this.roots.keys().next().value!); this.roots.set(root, new Map()); }
    return captureFiles(root, 1500, excluded, { cache: this.roots.get(root), maxFiles: 5000, maxBytes: 64 * 1024 * 1024 });
  }
}
export type StructureComparison = { from: string; to: string; added: string[]; removed: string[]; responsibilities: { before: string; after: string; descriptionChanged: boolean; scopeChanged: boolean }[]; sourceChanges: number; incomplete: boolean };
/** Compare stored descriptions and source membership, never infer a verified refactor. */
export function compareStructure(from: Overview, to: Overview): StructureComparison {
  const matches = new Map<string, string>(), used = new Set<string>();
  const candidates = from.nodes.flatMap(a => to.nodes.map(b => ({ a, b, overlap: a.files.filter(f => b.files.includes(f)).length }))).filter(p => p.overlap).sort((a, b) => b.overlap - a.overlap);
  for (const pair of candidates) if (!matches.has(pair.a.id) && !used.has(pair.b.id)) { matches.set(pair.a.id, pair.b.id); used.add(pair.b.id); }
  return { from: from.id, to: to.id, added: to.nodes.filter(n => !used.has(n.id)).map(n => n.title), removed: from.nodes.filter(n => !matches.has(n.id)).map(n => n.title),
    responsibilities: from.nodes.flatMap(a => { const b = to.nodes.find(n => n.id === matches.get(a.id)); if (!b) return [];
      const descriptionChanged = a.title !== b.title || a.purpose !== b.purpose || a.impact !== b.impact, scopeChanged = [...a.files].sort().join('\0') !== [...b.files].sort().join('\0');
      return descriptionChanged || scopeChanged ? [{ before: a.title, after: b.title, descriptionChanged, scopeChanged }] : []; }),
    sourceChanges: changedFiles(from.basis, to.basis).length, incomplete: !from.basis.complete || !to.basis.complete };
}
