// Which files the decode host and valence-media:// may read: the library, archive and staging
// roots plus anything explicitly allowed by other main-process modules (never by the renderer).

import { realpathSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'

const win = process.platform === 'win32'
const norm = (p: string) => (win ? resolve(p).toLowerCase() : resolve(p))

function real(p: string): string | null {
  try {
    return realpathSync.native(p)
  } catch {
    return null
  }
}

export function isUnder(root: string, p: string): boolean {
  const rel = relative(norm(root), norm(p))
  return rel === '' || (!!rel && !rel.startsWith('..') && !isAbsolute(rel))
}

export interface AudioAccess {
  /** Resolved real path when readable, else null. */
  resolve(path: string): string | null
  allowPaths(paths: string[]): void
  allowRoot(dir: string): void
}

export function createAudioAccess(roots: () => (string | null | undefined)[]): AudioAccess {
  const extraRoots = new Set<string>()
  const files = new Set<string>()
  return {
    resolve(path) {
      if (typeof path !== 'string' || !path || !isAbsolute(path)) return null
      const r = real(path)
      if (!r) return null
      if (files.has(norm(r))) return r
      for (const root of [...roots(), ...extraRoots]) {
        if (!root) continue
        const rr = real(root) ?? root
        if (isUnder(rr, r)) return r
      }
      return null
    },
    allowPaths(paths) {
      for (const p of paths) {
        const r = real(p)
        if (r) files.add(norm(r))
      }
    },
    allowRoot(dir) {
      extraRoots.add(resolve(dir))
    },
  }
}
