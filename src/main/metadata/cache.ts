import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { sha1 } from './util'

export interface HttpCache {
  get(key: string): string | null
  set(key: string, body: string, ttlSec: number): void
}

interface Entry { key: string; body: string; exp: number }

export function memoryCache(): HttpCache {
  const map = new Map<string, Entry>()
  return {
    get(key) {
      const e = map.get(key)
      if (!e) return null
      if (e.exp < Date.now()) { map.delete(key); return null }
      return e.body
    },
    set(key, body, ttlSec) {
      map.set(key, { key, body, exp: Date.now() + ttlSec * 1000 })
    },
  }
}

/** One JSON file per entry, named sha1(key).json, holding { key, body, exp }. */
export function fileCache(dir: string): HttpCache {
  let made = false
  const file = (key: string) => join(dir, `${sha1(key)}.json`)
  return {
    get(key) {
      try {
        const e = JSON.parse(readFileSync(file(key), 'utf8')) as Entry
        if (e.key !== key || e.exp < Date.now()) return null
        return e.body
      } catch {
        return null
      }
    },
    set(key, body, ttlSec) {
      try {
        if (!made) { mkdirSync(dir, { recursive: true }); made = true }
        const e: Entry = { key, body, exp: Date.now() + ttlSec * 1000 }
        writeFileSync(file(key), JSON.stringify(e))
      } catch {
        // cache is best-effort
      }
    },
  }
}
