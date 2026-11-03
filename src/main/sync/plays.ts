// Play history: each device appends to its own monthly plays log; all devices' logs are
// materialized into the local `plays` table.

import type { DB } from '@main/db/db'
import { DeviceLog, readNewEvents } from './device-log'

export interface PlayEvent {
  /** VALENCE_ID, or "path:<relPath>" for files without one. */
  trackKey: string
  playedAt: number
  ms: number
  completed: boolean
  skipped: boolean
}

export class PlayLog {
  private insert

  constructor(
    private db: DB,
    private log: DeviceLog,
    private libraryRoot: string,
    private deviceId: string,
  ) {
    this.insert = db.prepare(
      'INSERT OR IGNORE INTO plays(device_id, hlc, track_key, played_at, ms, completed, skipped) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
  }

  record(p: PlayEvent): void {
    const ev = this.log.append('plays', { k: p.trackKey, at: p.playedAt, ms: Math.round(p.ms), c: p.completed ? 1 : 0, s: p.skipped ? 1 : 0 }, { monthly: true, at: p.playedAt })
    this.insert.run(this.deviceId, ev.hlc, p.trackKey, p.playedAt, Math.round(p.ms), p.completed ? 1 : 0, p.skipped ? 1 : 0)
  }

  /** Pulls new events from every device's logs. Returns the number of new rows. */
  ingest(): number {
    const events = readNewEvents(this.db, this.libraryRoot, 'plays')
    let n = 0
    this.db.transaction(() => {
      for (const e of events) {
        if (typeof e.k !== 'string') continue
        n += this.insert.run(e.deviceId, e.hlc, e.k, Number(e.at) || 0, Number(e.ms) || 0, e.c ? 1 : 0, e.s ? 1 : 0).changes
      }
    })()
    return n
  }
}
