// Builds the AppContext. Library/imports start as placeholders and are swapped for the real
// services once the library core initialises (see app.ts).

import { app, safeStorage } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AppContext, ImportQueue, LibraryLookup, SecretStore, SettingsStore, ValenceEnv } from './context'
import { broadcast } from './ipc'

export function createSecretStore(dataDir: string): SecretStore {
  const file = join(dataDir, 'secrets.json')
  let cache: Record<string, string> = {}
  try {
    cache = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    cache = {}
  }
  const persist = () => writeFileSync(file, JSON.stringify(cache, null, 1))
  const enc = (v: string) => (safeStorage.isEncryptionAvailable() ? 'e:' + safeStorage.encryptString(v).toString('base64') : 'p:' + v)
  const dec = (v: string) => (v.startsWith('e:') ? safeStorage.decryptString(Buffer.from(v.slice(2), 'base64')) : v.slice(2))
  return {
    get(key) {
      const v = cache[key]
      if (!v) return null
      try {
        return dec(v)
      } catch {
        return null
      }
    },
    set(key, value) {
      if (value === null) delete cache[key]
      else cache[key] = enc(value)
      persist()
    },
  }
}

export function createMemorySettings(initial: Record<string, unknown> = {}): SettingsStore {
  const values = new Map(Object.entries(initial))
  const listeners = new Set<(k: string, v: unknown) => void>()
  return {
    get: <T>(key: string, fallback: T) => (values.has(key) ? (values.get(key) as T) : fallback),
    set(key, value) {
      values.set(key, value)
      for (const l of listeners) l(key, value)
    },
    onChange(cb) {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
  }
}

export const placeholderLibrary: LibraryLookup = {
  matchTracks: (t) => t.map(() => false),
  albumBadge: (a) => ({ status: 'missing', have: 0, total: a.trackCount ?? a.tracks?.length ?? 0 }),
  albumBadges: (as) => as.map((a) => ({ status: 'missing', have: 0, total: a.trackCount ?? a.tracks?.length ?? 0 })),
}

export const placeholderImports: ImportQueue = {
  registerAcquirer: () => {},
  enqueue: () => {
    throw new Error('Import queue not ready')
  },
  activeKeys: () => new Map(),
  pauseSource: () => {},
  resumeSource: () => {},
  resumeAfterLogin: () => {},
}

export function ensureDirs(env: ValenceEnv): void {
  for (const d of [env.dataDir, env.stagingDir, env.archivePendingDir, env.artCacheDir]) mkdirSync(d, { recursive: true })
  if (!existsSync(env.libraryRoot)) mkdirSync(env.libraryRoot, { recursive: true })
}

export function createContext(env: ValenceEnv, settings: SettingsStore): AppContext {
  const log = {
    info: (m: string, x?: unknown) => console.log(`[valence] ${m}`, x ?? ''),
    warn: (m: string, x?: unknown) => console.warn(`[valence] ${m}`, x ?? ''),
    error: (m: string, x?: unknown) => console.error(`[valence] ${m}`, x ?? ''),
  }
  return {
    env,
    settings,
    secrets: createSecretStore(env.dataDir),
    library: placeholderLibrary,
    imports: placeholderImports,
    playlists: { mirror: () => {} },
    broadcast,
    log,
  }
}

export { app }
