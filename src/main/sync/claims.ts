// Import claims in <library>/.valence/locks/. A device claims a release before importing it so a
// second desktop (seeing the claim via Syncthing) skips it. Syncthing is not instant, so claims are
// only a best effort; post-hoc dedupe by source id/MBID resolves the rare double import.

import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { valenceDir } from './device-log'

export interface Claim {
  deviceId: string
  keys: string[]
  ts: number
  ttlMs: number
}

const DEFAULT_TTL = 2 * 60 * 60 * 1000

function lockFile(libraryRoot: string, key: string): string {
  return join(valenceDir(libraryRoot), 'locks', createHash('sha1').update(key).digest('hex').slice(0, 24) + '.json')
}

function readClaim(file: string): Claim | null {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as Claim
  } catch {
    return null
  }
}

export class Claims {
  constructor(
    private libraryRoot: string,
    private deviceId: string,
    private now: () => number = Date.now,
  ) {}

  /** Live claim on any of `keys` held by another device, if any. */
  heldElsewhere(keys: string[]): Claim | null {
    for (const k of keys) {
      const c = readClaim(lockFile(this.libraryRoot, k))
      if (c && c.deviceId !== this.deviceId && this.now() - c.ts < c.ttlMs) return c
    }
    return null
  }

  claim(keys: string[], ttlMs = DEFAULT_TTL): boolean {
    if (this.heldElsewhere(keys)) return false
    mkdirSync(join(valenceDir(this.libraryRoot), 'locks'), { recursive: true })
    const c: Claim = { deviceId: this.deviceId, keys, ts: this.now(), ttlMs }
    for (const k of keys) writeFileSync(lockFile(this.libraryRoot, k), JSON.stringify(c))
    return true
  }

  release(keys: string[]): void {
    for (const k of keys) {
      const f = lockFile(this.libraryRoot, k)
      const c = readClaim(f)
      if (c?.deviceId === this.deviceId) {
        try {
          unlinkSync(f)
        } catch {
          /* already gone */
        }
      }
    }
  }

  /** Removes this device's expired claims and any expired claims older than 7 days. */
  sweep(): void {
    const dir = join(valenceDir(this.libraryRoot), 'locks')
    let files: string[] = []
    try {
      files = readdirSync(dir)
    } catch {
      return
    }
    for (const f of files) {
      const c = readClaim(join(dir, f))
      if (!c) continue
      const age = this.now() - c.ts
      if ((c.deviceId === this.deviceId && age > c.ttlMs) || age > 7 * 24 * 3600 * 1000) {
        try {
          unlinkSync(join(dir, f))
        } catch {
          /* ignore */
        }
      }
    }
  }
}
