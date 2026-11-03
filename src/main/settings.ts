// Settings: device-local values in <dataDir>/settings.json; library-wide values (path template,
// transcode profile, art size, metadata policy...) in <library>/.valence/settings.json with a
// per-key HLC so Syncthing conflict copies merge newest-wins per key.

import { existsSync, readFileSync, readdirSync, renameSync, unlinkSync, watch, writeFileSync, mkdirSync, type FSWatcher } from 'node:fs'
import { join } from 'node:path'
import type { SettingsStore } from './context'
import { HlcClock } from './sync/hlc'
import { valenceDir } from './sync/device-log'

const SHARED_PREFIXES = ['library.', 'transcode.', 'art.', 'genre.', 'metadata.', 'import.', 'discord.', 'lyrics.']

export function isSharedKey(key: string): boolean {
  return SHARED_PREFIXES.some((p) => key.startsWith(p))
}

type SharedDoc = Record<string, { v: unknown; hlc: string }>

export function mergeShared(a: SharedDoc, b: SharedDoc): SharedDoc {
  const out: SharedDoc = { ...a }
  for (const [k, e] of Object.entries(b)) if (!out[k] || e.hlc > out[k].hlc) out[k] = e
  return out
}

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T
  } catch {
    return fallback
  }
}

function writeAtomic(file: string, data: string): void {
  const tmp = `${file}.${process.pid}.valence-tmp`
  writeFileSync(tmp, data)
  renameSync(tmp, file)
}

export interface PersistentSettings extends SettingsStore {
  all(): Record<string, unknown>
  /** Re-reads the shared file (e.g. after Syncthing updated it); returns changed keys. */
  reloadShared(): string[]
  close(): void
}

export function createSettings(dataDir: string, libraryRoot: string, clock: HlcClock, defaults: Record<string, unknown> = {}): PersistentSettings {
  const localFile = join(dataDir, 'settings.json')
  const sharedDir = valenceDir(libraryRoot)
  const sharedFile = join(sharedDir, 'settings.json')
  let local = readJson<Record<string, unknown>>(localFile, {})
  let shared: SharedDoc = {}
  const listeners = new Set<(k: string, v: unknown) => void>()
  const emit = (k: string, v: unknown) => {
    for (const l of listeners) l(k, v)
  }

  const loadShared = (): SharedDoc => {
    let doc = readJson<SharedDoc>(sharedFile, {})
    // Merge Syncthing conflict copies, then drop them (their content is now in the main file).
    let merged = false
    try {
      for (const f of readdirSync(sharedDir)) {
        if (!/^settings\.sync-conflict-.*\.json$/.test(f)) continue
        doc = mergeShared(doc, readJson<SharedDoc>(join(sharedDir, f), {}))
        unlinkSync(join(sharedDir, f))
        merged = true
      }
    } catch {
      /* no dir yet */
    }
    if (merged) persistShared(doc)
    for (const e of Object.values(doc)) clock.observe(e.hlc)
    return doc
  }
  const persistShared = (doc: SharedDoc) => {
    mkdirSync(sharedDir, { recursive: true })
    writeAtomic(sharedFile, JSON.stringify(doc, null, 1))
  }
  shared = loadShared()

  let watcher: FSWatcher | null = null
  let reloadTimer: NodeJS.Timeout | null = null
  const store: PersistentSettings = {
    get<T>(key: string, fallback: T): T {
      if (isSharedKey(key)) {
        if (key in shared) return shared[key].v as T
      } else if (key in local) return local[key] as T
      return key in defaults ? (defaults[key] as T) : fallback
    },
    set(key, value) {
      if (isSharedKey(key)) {
        shared = loadShared()
        shared[key] = { v: value, hlc: clock.tick() }
        persistShared(shared)
      } else {
        local[key] = value
        mkdirSync(dataDir, { recursive: true })
        writeAtomic(localFile, JSON.stringify(local, null, 1))
      }
      emit(key, value)
    },
    onChange(cb) {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    all() {
      const out: Record<string, unknown> = { ...defaults, ...local }
      for (const [k, e] of Object.entries(shared)) out[k] = e.v
      return out
    },
    reloadShared() {
      const before = shared
      shared = loadShared()
      const changed = Object.keys({ ...before, ...shared }).filter((k) => before[k]?.hlc !== shared[k]?.hlc)
      for (const k of changed) emit(k, shared[k]?.v)
      return changed
    },
    close() {
      watcher?.close()
      if (reloadTimer) clearTimeout(reloadTimer)
    },
  }
  try {
    if (existsSync(sharedDir)) {
      watcher = watch(sharedDir, (_ev, name) => {
        if (!name || !String(name).startsWith('settings')) return
        if (reloadTimer) clearTimeout(reloadTimer)
        reloadTimer = setTimeout(() => store.reloadShared(), 500)
      })
    }
  } catch {
    /* watching is best effort */
  }
  local = { ...local }
  return store
}
