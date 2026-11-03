// Recursive fs.watch on the library with debouncing, plus a periodic full rescan as a safety net
// (watch events can be dropped, e.g. when Syncthing writes many files at once).

import { watch, type FSWatcher } from 'node:fs'
import { isIgnoredName } from '@shared/sanitize'
import { isAudioPath } from '@main/tags/read'

export type ChangeKind = 'audio' | 'valence' | 'playlist'

export interface WatchHandle {
  close(): void
}

export function classifyChange(rel: string): ChangeKind | null {
  const parts = rel.split('/')
  const name = parts[parts.length - 1]
  if (!name || isIgnoredName(name) && !name.includes('.sync-conflict-')) return null
  if (parts[0] === '.valence') return 'valence'
  if (parts[0].toLowerCase() === 'playlists' && /\.m3u8?$/i.test(name)) return 'playlist'
  if (parts.some((p, i) => i < parts.length - 1 && p.startsWith('.'))) return null
  if (name.endsWith('.valence-tmp')) return null
  return isAudioPath(name) || !name.includes('.') ? 'audio' : null
}

export function watchLibrary(
  root: string,
  onChange: (kind: ChangeKind, rels: string[]) => void,
  opts: { debounceMs?: number; rescanMs?: number; onRescan?: () => void } = {},
): WatchHandle {
  const pending = new Map<ChangeKind, Set<string>>()
  let timer: NodeJS.Timeout | null = null
  const flush = () => {
    timer = null
    for (const [kind, set] of pending) if (set.size) onChange(kind, [...set])
    pending.clear()
  }
  let watcher: FSWatcher | null = null
  try {
    watcher = watch(root, { recursive: true }, (_ev, filename) => {
      if (!filename) return
      const rel = String(filename).replace(/\\/g, '/')
      const kind = classifyChange(rel)
      if (!kind) return
      if (!pending.has(kind)) pending.set(kind, new Set())
      pending.get(kind)!.add(rel)
      if (timer) clearTimeout(timer)
      timer = setTimeout(flush, opts.debounceMs ?? 2500)
    })
    watcher.on('error', () => {})
  } catch {
    /* recursive watch unsupported: rely on periodic rescans */
  }
  const rescan = opts.onRescan ? setInterval(opts.onRescan, opts.rescanMs ?? 30 * 60 * 1000) : null
  return {
    close() {
      watcher?.close()
      if (timer) clearTimeout(timer)
      if (rescan) clearInterval(rescan)
    },
  }
}
