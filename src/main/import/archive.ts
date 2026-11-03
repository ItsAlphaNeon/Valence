// Unsynced lossless archive at a user-chosen folder (e.g. on a data HDD). When it is not chosen
// yet or the drive is offline, files wait in <dataDir>/archive-pending/ (same relative layout) and
// are flushed automatically once the archive is reachable.

import { existsSync, mkdirSync } from 'node:fs'
import { opendir, stat, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ValenceEnv, Logger } from '@main/context'
import { placeFile, pruneEmptyDirs, toAbs } from '@main/library/organizer'
import { foldKey } from '@shared/sanitize'

export interface ArchiveStatus {
  dir: string | null
  online: boolean
  pendingFiles: number
  pendingBytes: number
}

async function walk(dir: string, rel = ''): Promise<Array<{ rel: string; size: number }>> {
  const out: Array<{ rel: string; size: number }> = []
  let d
  try {
    d = await opendir(dir)
  } catch {
    return out
  }
  for await (const e of d) {
    const r = rel ? `${rel}/${e.name}` : e.name
    if (e.isDirectory()) out.push(...(await walk(join(dir, e.name), r)))
    else if (e.isFile() && !e.name.endsWith('.valence-tmp')) out.push({ rel: r, size: (await stat(join(dir, e.name))).size })
  }
  return out
}

function withSuffix(rel: string, n: number): string {
  const slash = rel.lastIndexOf('/')
  const dot = rel.lastIndexOf('.')
  if (dot <= slash) return `${rel} (${n})`
  return `${rel.slice(0, dot)} (${n})${rel.slice(dot)}`
}

export class Archive {
  private timer: NodeJS.Timeout | null = null
  private flushing: Promise<number> | null = null

  constructor(
    private env: ValenceEnv,
    private log: Logger,
    private onStatus: (s: ArchiveStatus) => void = () => {},
  ) {
    mkdirSync(env.archivePendingDir, { recursive: true })
  }

  online(): boolean {
    const dir = this.env.archiveDir
    if (!dir) return false
    try {
      if (!existsSync(dir)) {
        // Create the folder only if its parent (the drive / chosen location) is there.
        const parent = join(dir, '..')
        if (!existsSync(parent)) return false
        mkdirSync(dir, { recursive: true })
      }
      return true
    } catch {
      return false
    }
  }

  async status(): Promise<ArchiveStatus> {
    const pending = await walk(this.env.archivePendingDir)
    return { dir: this.env.archiveDir, online: this.online(), pendingFiles: pending.length, pendingBytes: pending.reduce((s, f) => s + f.size, 0) }
  }

  /** Stores `src` (moved) at `rel` in the archive, or in pending when offline. Never overwrites. */
  async put(src: string, rel: string): Promise<{ where: 'archive' | 'pending'; rel: string }> {
    const online = this.online()
    const root = online ? this.env.archiveDir! : this.env.archivePendingDir
    let n = 1
    const r = await placeFile(src, root, rel, { move: true, rechoose: async () => withSuffix(rel, ++n) })
    return { where: online ? 'archive' : 'pending', rel: r.relPath }
  }

  async putBuffer(data: Buffer, rel: string, stagingDir: string): Promise<{ where: 'archive' | 'pending'; rel: string } | null> {
    // Identical-named extras (cover-original.jpg) for the same album are not duplicated.
    const online = this.online()
    const root = online ? this.env.archiveDir! : this.env.archivePendingDir
    if (existsSync(toAbs(root, rel))) {
      const st = await stat(toAbs(root, rel))
      if (st.size === data.length) return null
    }
    mkdirSync(stagingDir, { recursive: true })
    const tmp = join(stagingDir, `buf-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    await writeFile(tmp, data)
    return this.put(tmp, rel)
  }

  /** Moves pending files into the archive when it is reachable. Returns files moved. */
  flush(): Promise<number> {
    if (this.flushing) return this.flushing
    this.flushing = (async () => {
      if (!this.online()) return 0
      const pending = await walk(this.env.archivePendingDir)
      let moved = 0
      for (const f of pending) {
        const src = toAbs(this.env.archivePendingDir, f.rel)
        const dst = toAbs(this.env.archiveDir!, f.rel)
        try {
          if (existsSync(dst) && (await stat(dst)).size === f.size && /cover-original\./i.test(f.rel)) {
            await unlink(src)
          } else {
            let n = 1
            await placeFile(src, this.env.archiveDir!, f.rel, { move: true, rechoose: async () => withSuffix(f.rel, ++n) })
          }
          moved++
          const slash = f.rel.lastIndexOf('/')
          if (slash > 0) await pruneEmptyDirs(this.env.archivePendingDir, f.rel.slice(0, slash))
        } catch (e) {
          this.log.warn(`archive: could not move ${f.rel}`, (e as Error).message)
          if (!this.online()) break
        }
      }
      if (moved) {
        this.log.info(`archive: flushed ${moved} pending files`)
        this.onStatus(await this.status())
      }
      return moved
    })().finally(() => (this.flushing = null))
    return this.flushing
  }

  start(intervalMs = 60_000): void {
    void this.flush()
    this.timer = setInterval(() => void this.flush(), intervalMs)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
  }

  /** Path of a file in the archive (or pending), if present. */
  locate(rel: string): string | null {
    for (const root of [this.env.archiveDir, this.env.archivePendingDir]) {
      if (!root) continue
      const p = toAbs(root, rel)
      if (existsSync(p)) return p
    }
    return null
  }
}

export function sameRel(a: string, b: string): boolean {
  return foldKey(a) === foldKey(b)
}
