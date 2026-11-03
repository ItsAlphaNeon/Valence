// Per-machine Inbox (~/Valence Inbox, never synced). Anything dropped in is imported once it has
// stopped changing; afterwards the originals move to Inbox/Imported/ (same relative layout).

import { existsSync, mkdirSync, watch, type FSWatcher } from 'node:fs'
import { readdir, rmdir, stat } from 'node:fs/promises'
import { dirname, join, relative, sep } from 'node:path'
import type { ImportQueue, Logger } from '@main/context'
import { placeFile } from '@main/library/organizer'
import { enqueueLoose, looseKey, planLooseImport, type LoosePayload } from './loose'

export const IMPORTED_DIR = 'Imported'
const README = 'Drop music here to add it to Valence. Imported originals move to the Imported folder.\n'

export class Inbox {
  private watcher: FSWatcher | null = null
  private timer: NodeJS.Timeout | null = null
  private poll: NodeJS.Timeout | null = null
  private busy = false
  private again = false

  constructor(
    private dir: string,
    private queue: ImportQueue,
    private log: Logger,
    private settleMs = 4000,
    /** Skips clusters that already have a job (e.g. failed ones waiting for Retry). */
    private seen: (key: string) => boolean = () => false,
  ) {}

  start(): void {
    if (this.poll) return
    mkdirSync(join(this.dir, IMPORTED_DIR), { recursive: true })
    const readme = join(this.dir, 'README.txt')
    if (!existsSync(readme)) void import('node:fs/promises').then((f) => f.writeFile(readme, README)).catch(() => {})
    try {
      this.watcher = watch(this.dir, { recursive: true }, (_ev, name) => {
        if (!name || this.isImported(join(this.dir, String(name)))) return
        this.poke()
      })
    } catch (e) {
      this.log.warn('inbox: watch failed; falling back to polling', (e as Error).message)
    }
    // Initial sweep + slow safety poll (network drives, missed events).
    this.poke()
    this.poll = setInterval(() => this.poke(), 5 * 60_000)
    this.poll.unref()
  }

  stop(): void {
    this.watcher?.close()
    this.watcher = null
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    if (this.poll) clearInterval(this.poll)
    this.poll = null
  }

  private isImported(abs: string): boolean {
    const rel = relative(this.dir, abs)
    return rel === IMPORTED_DIR || rel.startsWith(IMPORTED_DIR + sep) || rel === 'README.txt'
  }

  private poke(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => void this.sweep(), this.settleMs)
  }

  /** Imports every top-level entry whose files have stopped changing. */
  async sweep(): Promise<string[]> {
    if (this.busy) {
      this.again = true
      return []
    }
    this.busy = true
    const ids: string[] = []
    try {
      const entries = (await readdir(this.dir)).filter((n) => n !== IMPORTED_DIR && n !== 'README.txt' && !n.startsWith('.'))
      if (!entries.length) return ids
      const abs = entries.map((n) => join(this.dir, n))
      if (!(await this.stable(abs))) {
        this.poke()
        return ids
      }
      const payloads = (await planLooseImport(abs, { inbox: true, skip: (p) => this.isImported(p) })).filter((p) => !this.seen(looseKey(p.files)))
      ids.push(...enqueueLoose(this.queue, payloads))
      if (ids.length) this.log.info(`inbox: queued ${ids.length} import job(s)`)
    } catch (e) {
      this.log.warn('inbox: sweep failed', (e as Error).message)
    } finally {
      this.busy = false
      if (this.again) {
        this.again = false
        this.poke()
      }
    }
    return ids
  }

  /** True when sizes/mtimes are unchanged over a short interval (copies finished). */
  private async stable(paths: string[]): Promise<boolean> {
    const snap = async () => {
      const out: string[] = []
      const visit = async (p: string) => {
        try {
          const st = await stat(p)
          if (st.isDirectory()) for (const n of await readdir(p)) await visit(join(p, n))
          else out.push(`${p}:${st.size}:${st.mtimeMs}`)
        } catch {
          out.push(`${p}:gone`)
        }
      }
      for (const p of paths) await visit(p)
      return out.sort().join('|')
    }
    const a = await snap()
    await new Promise((r) => setTimeout(r, Math.min(3000, this.settleMs)))
    return a === (await snap())
  }

  /** Moves a finished job's originals (and sidecars in the same folders) to Inbox/Imported. */
  async archiveOriginals(payload: LoosePayload): Promise<void> {
    if (!payload.inbox) return
    const files = [...payload.files, ...(payload.artwork ? [payload.artwork] : []), ...(payload.extras ?? [])]
    const dirs = new Set<string>()
    for (const f of files) {
      if (!existsSync(f)) continue
      const rel = relative(this.dir, f)
      if (rel.startsWith('..')) continue
      try {
        let n = 1
        const target = rel.split(sep).join('/')
        await placeFile(f, join(this.dir, IMPORTED_DIR), target, {
          move: true,
          rechoose: async () => target.replace(/(\.[^./]+)?$/, (ext) => ` (${++n})${ext}`),
        })
        dirs.add(dirname(f))
      } catch (e) {
        this.log.warn(`inbox: could not move ${rel}`, (e as Error).message)
      }
    }
    // Remove folders left empty (except the Inbox itself).
    for (const d of [...dirs].sort((a, b) => b.length - a.length)) {
      let cur = d
      while (cur.length > this.dir.length && !this.isImported(cur)) {
        try {
          const rest = (await readdir(cur)).filter((n) => !/^(desktop\.ini|thumbs\.db|\.ds_store)$/i.test(n))
          if (rest.length) break
          await rmdir(cur).catch(async () => {
            const { rm } = await import('node:fs/promises')
            await rm(cur, { recursive: true, force: true })
          })
        } catch {
          break
        }
        cur = dirname(cur)
      }
    }
  }
}
