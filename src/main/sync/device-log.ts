// Per-device append-only JSONL logs in <library>/.valence/devices/<deviceId>/. Each device only
// ever writes its own directory, so Syncthing never produces conflicts; every device reads all
// directories incrementally (byte cursors stored in the local DB).

import { appendFileSync, closeSync, existsSync, fstatSync, mkdirSync, openSync, readdirSync, readSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { DB } from '@main/db/db'
import { HlcClock } from './hlc'

export const VALENCE_DIR = '.valence'

export function valenceDir(libraryRoot: string): string {
  return join(libraryRoot, VALENCE_DIR)
}

export function deviceDir(libraryRoot: string, deviceId: string): string {
  return join(valenceDir(libraryRoot), 'devices', deviceId)
}

/** Creates .valence with a .nomedia marker (keeps Android media scanners out). */
export function ensureValenceDir(libraryRoot: string, deviceId: string, info: Record<string, unknown> = {}): void {
  const dir = deviceDir(libraryRoot, deviceId)
  mkdirSync(dir, { recursive: true })
  const nomedia = join(valenceDir(libraryRoot), '.nomedia')
  if (!existsSync(nomedia)) writeFileSync(nomedia, '')
  writeFileSync(join(dir, 'device.json'), JSON.stringify({ id: deviceId, platform: process.platform, lastSeen: new Date().toISOString(), ...info }, null, 1))
}

export interface LogEvent {
  hlc: string
  [k: string]: unknown
}

export class DeviceLog {
  constructor(
    private libraryRoot: string,
    private deviceId: string,
    private clock: HlcClock,
  ) {}

  /** Appends an event to this device's log `<name>.jsonl` (or `<name>-YYYY-MM.jsonl` when monthly). */
  append(name: string, event: Record<string, unknown>, opts: { monthly?: boolean; at?: number } = {}): LogEvent {
    const dir = deviceDir(this.libraryRoot, this.deviceId)
    mkdirSync(dir, { recursive: true })
    const file = opts.monthly ? `${name}-${new Date(opts.at ?? Date.now()).toISOString().slice(0, 7)}.jsonl` : `${name}.jsonl`
    const ev = { hlc: this.clock.tick(), ...event }
    appendFileSync(join(dir, file), JSON.stringify(ev) + '\n')
    return ev
  }

  /** Appends several events to `<name>.jsonl` in one write (each gets its own, increasing HLC). */
  appendMany(name: string, events: Array<Record<string, unknown>>): LogEvent[] {
    if (!events.length) return []
    const dir = deviceDir(this.libraryRoot, this.deviceId)
    mkdirSync(dir, { recursive: true })
    const out = events.map((e) => ({ hlc: this.clock.tick(), ...e }))
    appendFileSync(join(dir, `${name}.jsonl`), out.map((e) => JSON.stringify(e) + '\n').join(''))
    return out
  }
}

export interface ReadEvent extends LogEvent {
  deviceId: string
  file: string
}

/**
 * Reads new complete lines from every device's logs matching `prefix` since the stored cursors.
 * A trailing partial line (mid-sync) is left for the next read. A file that shrank is re-read.
 */
export function readNewEvents(db: DB, libraryRoot: string, prefix: string): ReadEvent[] {
  const root = join(valenceDir(libraryRoot), 'devices')
  if (!existsSync(root)) return []
  const getCur = db.prepare('SELECT offset, size, mtime_ms FROM log_cursors WHERE file = ?')
  const setCur = db.prepare(
    'INSERT INTO log_cursors(file, offset, size, mtime_ms) VALUES (?, ?, ?, ?) ON CONFLICT(file) DO UPDATE SET offset = excluded.offset, size = excluded.size, mtime_ms = excluded.mtime_ms',
  )
  const out: ReadEvent[] = []
  for (const deviceId of readdirSync(root)) {
    const dir = join(root, deviceId)
    let files: string[]
    try {
      files = readdirSync(dir).filter((f) => f.startsWith(prefix) && f.endsWith('.jsonl') && !f.includes('.sync-conflict-'))
    } catch {
      continue
    }
    for (const f of files.sort()) {
      const abs = join(dir, f)
      const key = `${deviceId}/${f}`
      const st = statSync(abs)
      const cur = getCur.get(key) as { offset: number; size: number; mtime_ms: number } | undefined
      let offset = cur && cur.offset <= st.size ? cur.offset : 0
      if (cur && cur.offset === st.size && cur.mtime_ms === Math.round(st.mtimeMs)) continue
      const fd = openSync(abs, 'r')
      try {
        const size = fstatSync(fd).size
        const buf = Buffer.alloc(size - offset)
        readSync(fd, buf, 0, buf.length, offset)
        const text = buf.toString('utf8')
        const lastNl = text.lastIndexOf('\n')
        if (lastNl < 0) continue
        for (const line of text.slice(0, lastNl).split('\n')) {
          if (!line.trim()) continue
          try {
            const ev = JSON.parse(line) as LogEvent
            if (ev && typeof ev.hlc === 'string') out.push({ ...ev, deviceId, file: f })
          } catch {
            /* skip corrupt line */
          }
        }
        offset += Buffer.byteLength(text.slice(0, lastNl + 1), 'utf8')
        setCur.run(key, offset, size, Math.round(st.mtimeMs))
      } finally {
        closeSync(fd)
      }
    }
  }
  return out.sort((a, b) => (a.hlc < b.hlc ? -1 : a.hlc > b.hlc ? 1 : 0))
}
