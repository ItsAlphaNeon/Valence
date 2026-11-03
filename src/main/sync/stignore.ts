// Maintains a marked block inside <library>/.stignore. .stignore is per-device (not synced),
// so every desktop writes its own copy. User lines outside the block are preserved.

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const BEGIN = '// BEGIN Valence (managed — edits inside this block are overwritten)'
const END = '// END Valence'

export const STIGNORE_LINES = [
  '*.valence-tmp',
  '(?d).DS_Store',
  '(?d)._*',
  '(?d)Thumbs.db',
  '(?d)desktop.ini',
  '(?d).thumbnails',
  '(?d).Trashes',
  '(?d).Spotlight-V100',
  '(?d).fseventsd',
  // Apple Music / GarageBand / Logic data that macOS keeps in ~/Music.
  '/Music',
  '/iTunes',
  '/GarageBand',
  '/Audio Music Apps',
  '/Logic',
]

export function renderStignore(existing: string, lines = STIGNORE_LINES): string {
  const block = [BEGIN, ...lines, END].join('\n')
  const start = existing.indexOf(BEGIN)
  const end = existing.indexOf(END)
  if (start >= 0 && end > start) {
    return existing.slice(0, start) + block + existing.slice(end + END.length)
  }
  const sep = existing && !existing.endsWith('\n') ? '\n' : ''
  return `${existing}${sep}${existing ? '\n' : ''}${block}\n`
}

/** Ensures the managed block is present and current. Returns true if the file changed. */
export function ensureStignore(libraryRoot: string): boolean {
  const file = join(libraryRoot, '.stignore')
  const before = existsSync(file) ? readFileSync(file, 'utf8') : ''
  const after = renderStignore(before)
  if (after === before) return false
  writeFileSync(file, after)
  return true
}
