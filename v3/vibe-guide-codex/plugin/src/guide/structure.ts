import { captureFiles } from './files.js';
import type { FingerprintCache } from './files.js';
export class ProjectIndex {
  private roots = new Map<string, FingerprintCache>();
  async scan(root: string, excluded: string[]) {
    if (!this.roots.has(root)) { if (this.roots.size >= 8) this.roots.delete(this.roots.keys().next().value!); this.roots.set(root, new Map()); }
    return captureFiles(root, 1500, excluded, { cache: this.roots.get(root), maxFiles: 5000, maxBytes: 64 * 1024 * 1024 });
  }
}
