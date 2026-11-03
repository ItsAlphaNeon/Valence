// Walks the library root, diffs against the index by size+mtime and (re)probes changed files.

import { opendir, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { isIgnoredName, isReservedTopLevel, isSyncConflict } from '@shared/sanitize'
import { isAudioPath, probeFile } from '@main/tags/read'
import type { DB } from '@main/db/db'
import type { Indexer } from './indexer'

export interface WalkEntry {
  rel: string
  size: number
  mtimeMs: number
}

export interface WalkResult {
  files: WalkEntry[]
  conflicts: WalkEntry[]
  playlists: WalkEntry[]
}

export function shouldSkipDir(name: string, depth: number): boolean {
  if (name.startsWith('.')) return true
  if (isIgnoredName(name)) return true
  return depth === 0 && isReservedTopLevel(name)
}

export async function walkLibrary(root: string, signal?: AbortSignal): Promise<WalkResult> {
  const out: WalkResult = { files: [], conflicts: [], playlists: [] }
  const visit = async (abs: string, rel: string, depth: number): Promise<void> => {
    if (signal?.aborted) throw new Error('cancelled')
    let dir
    try {
      dir = await opendir(abs)
    } catch {
      return
    }
    for await (const ent of dir) {
      const childRel = rel ? `${rel}/${ent.name}` : ent.name
      const childAbs = join(abs, ent.name)
      if (ent.isDirectory()) {
        if (depth === 0 && ent.name.toLowerCase() === 'playlists') {
          await collectPlaylists(childAbs, childRel, out.playlists)
          continue
        }
        if (shouldSkipDir(ent.name, depth)) continue
        await visit(childAbs, childRel, depth + 1)
      } else if (ent.isFile()) {
        const lower = ent.name.toLowerCase()
        if (isSyncConflict(lower) && isAudioPath(lower.replace(/\.sync-conflict-[^.]*/, ''))) {
          const st = await stat(childAbs).catch(() => null)
          if (st) out.conflicts.push({ rel: childRel, size: st.size, mtimeMs: st.mtimeMs })
          continue
        }
        if (isIgnoredName(ent.name) || ent.name.startsWith('.') || !isAudioPath(ent.name)) continue
        const st = await stat(childAbs).catch(() => null)
        if (st) out.files.push({ rel: childRel, size: st.size, mtimeMs: st.mtimeMs })
      }
    }
  }
  await visit(root, '', 0)
  return out
}

async function collectPlaylists(abs: string, rel: string, out: WalkEntry[]): Promise<void> {
  let dir
  try {
    dir = await opendir(abs)
  } catch {
    return
  }
  for await (const ent of dir) {
    if (!ent.isFile() || isIgnoredName(ent.name) || !/\.m3u8?$/i.test(ent.name)) continue
    const st = await stat(join(abs, ent.name)).catch(() => null)
    if (st) out.push({ rel: `${rel}/${ent.name}`, size: st.size, mtimeMs: st.mtimeMs })
  }
}

export interface ScanResult {
  added: number
  updated: number
  removed: number
  unchanged: number
  errors: Array<{ rel: string; error: string }>
  conflicts: WalkEntry[]
  playlists: WalkEntry[]
  touchedAlbums: number[]
  moved: Array<{ from: string; to: string }>
  durationMs: number
}

export async function pool<T>(items: T[], concurrency: number, fn: (item: T, i: number) => Promise<void>, signal?: AbortSignal): Promise<void> {
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      if (signal?.aborted) return
      const i = next++
      await fn(items[i], i)
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker))
}

export interface ScanOptions {
  root: string
  db: DB
  indexer: Indexer
  signal?: AbortSignal
  concurrency?: number
  /** Re-probe every file even when size+mtime are unchanged. */
  force?: boolean
  /** Restrict to these relative paths (watcher-driven incremental scans). */
  only?: string[]
  onProgress?: (done: number, total: number) => void
}

export async function scanLibrary(opts: ScanOptions): Promise<ScanResult> {
  const t0 = Date.now()
  const { root, db, indexer } = opts
  let walk: WalkResult
  if (opts.only) {
    const files: WalkEntry[] = []
    for (const rel of opts.only) {
      const st = await stat(join(root, rel)).catch(() => null)
      if (st?.isFile() && isAudioPath(rel)) files.push({ rel, size: st.size, mtimeMs: st.mtimeMs })
    }
    walk = { files, conflicts: [], playlists: [] }
  } else {
    walk = await walkLibrary(root, opts.signal)
  }

  const known = new Map<string, { size: number; mtime_ms: number }>()
  const rows = opts.only
    ? opts.only.map((rel) => db.prepare('SELECT rel_path, size, mtime_ms FROM tracks WHERE rel_path = ?').get(rel)).filter(Boolean)
    : db.prepare('SELECT rel_path, size, mtime_ms FROM tracks').all()
  for (const r of rows as Array<{ rel_path: string; size: number; mtime_ms: number }>) known.set(r.rel_path, r)

  const seen = new Set<string>()
  const todo: WalkEntry[] = []
  let unchanged = 0
  for (const f of walk.files) {
    seen.add(f.rel)
    const k = known.get(f.rel)
    if (!opts.force && k && k.size === f.size && k.mtime_ms === Math.round(f.mtimeMs)) unchanged++
    else todo.push(f)
  }

  const result: ScanResult = {
    added: 0,
    updated: 0,
    removed: 0,
    unchanged,
    errors: [],
    conflicts: walk.conflicts,
    playlists: walk.playlists,
    touchedAlbums: [],
    moved: [],
    durationMs: 0,
  }

  // Probe in parallel, write in batched transactions.
  const pending: Array<{ f: WalkEntry; probe: Awaited<ReturnType<typeof probeFile>> }> = []
  const pathExists = (rel: string) => seen.has(rel) || existsSync(join(root, rel))
  const flush = () => {
    if (!pending.length) return
    const batch = pending.splice(0)
    db.transaction(() => {
      for (const { f, probe } of batch) {
        const r = indexer.upsert(f.rel, f, probe, { pathExists })
        if (r.kind === 'insert') result.added++
        else result.updated++
        if (r.kind === 'move' && r.from) result.moved.push({ from: r.from, to: f.rel })
      }
    })()
  }
  let done = 0
  await pool(
    todo,
    opts.concurrency ?? 8,
    async (f) => {
      try {
        const probe = await probeFile(join(root, f.rel), { covers: true })
        pending.push({ f, probe })
        if (pending.length >= 100) flush()
      } catch (e) {
        result.errors.push({ rel: f.rel, error: (e as Error).message })
      }
      done++
      opts.onProgress?.(done, todo.length)
    },
    opts.signal,
  )
  flush()

  // Removals: rows whose file vanished (only within the scanned scope).
  const gone = [...known.keys()].filter((rel) => !seen.has(rel))
  if (gone.length) {
    db.transaction(() => {
      for (const rel of gone) {
        if (existsSync(join(root, rel))) continue
        if (indexer.removeByPath(rel)) result.removed++
      }
    })()
  }
  result.touchedAlbums = indexer.flushAlbums()
  result.durationMs = Date.now() - t0
  return result
}
