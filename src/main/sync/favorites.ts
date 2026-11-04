// Favorites ("liked" tracks, albums and artists). Each device appends toggles to its own
// .valence/devices/<id>/favorites.jsonl as { hlc, kind: 't'|'a'|'r', k: <key>, on: 1|0, at? };
// every device's log is materialized into the local `favorites` table, last-writer-wins per
// (kind, key) by HLC (encoded so plain string comparison orders it). Unliked rows stay.
//
// Keys: track = coalesce(valence_id, 'path:' || rel_path) (same as plays), album = albums.album_key,
// artist = artistFavoriteKey(album artist name).

import type { DB } from '@main/db/db'
import type { FavoriteKind } from '@shared/types'
import { DeviceLog, readNewEvents } from './device-log'
import { decodeHlc, type HlcClock } from './hlc'

export type FavoriteCode = 't' | 'a' | 'r'

export const FAVORITE_CODE: Record<FavoriteKind, FavoriteCode> = { track: 't', album: 'a', artist: 'r' }

export const FAVORITES_LOG = 'favorites'

export function artistFavoriteKey(name: string): string {
  return name.trim().toLowerCase().normalize('NFC')
}

/** SQL for a track's favorites/plays key on a tracks alias (matches the tracks_item_key index). */
export function trackKeySql(alias = 't'): string {
  return `coalesce(${alias}.valence_id, 'path:' || ${alias}.rel_path)`
}

function isCode(v: unknown): v is FavoriteCode {
  return v === 't' || v === 'a' || v === 'r'
}

export class FavoritesLog {
  private upsert
  private getRow

  constructor(
    private db: DB,
    private log: DeviceLog,
    private clock: HlcClock,
    private libraryRoot: string,
  ) {
    this.upsert = db.prepare(
      `INSERT INTO favorites(kind, item_key, liked, hlc, at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(kind, item_key) DO UPDATE SET liked = excluded.liked, hlc = excluded.hlc, at = excluded.at
       WHERE excluded.hlc > favorites.hlc`,
    )
    this.getRow = db.prepare('SELECT liked, hlc, at FROM favorites WHERE kind = ? AND item_key = ?')
    // A new toggle must sort after everything already seen, even if this machine's clock went back.
    const max = db.prepare('SELECT max(hlc) AS h FROM favorites').get() as { h: string | null }
    if (max.h) clock.observe(max.h)
  }

  private apply(e: { hlc: string; kind: FavoriteCode; k: string; on: unknown; at?: unknown }): number {
    const at = typeof e.at === 'number' && Number.isFinite(e.at) ? e.at : (decodeHlc(e.hlc)?.ms ?? Date.now())
    return this.upsert.run(e.kind, e.k, e.on ? 1 : 0, e.hlc, Math.round(at)).changes
  }

  get(kind: FavoriteCode, key: string): { liked: boolean; hlc: string; at: number } | null {
    const r = this.getRow.get(kind, key) as { liked: number; hlc: string; at: number } | undefined
    return r ? { liked: !!r.liked, hlc: r.hlc, at: r.at } : null
  }

  /**
   * Likes or unlikes items: one log event per item whose state changes (re-liking keeps the
   * original time). `at` overrides the liked time (used when a like follows an item to a new key).
   * Returns how many items changed.
   */
  set(kind: FavoriteCode, keys: string[], liked: boolean, at?: number): number {
    const todo = [...new Set(keys.filter((k) => typeof k === 'string' && k.length > 0))].filter((k) => (this.get(kind, k)?.liked ?? false) !== liked)
    if (!todo.length) return 0
    const events = this.log.appendMany(
      FAVORITES_LOG,
      todo.map((k) => ({ kind, k, on: liked ? 1 : 0, ...(at !== undefined ? { at } : {}) })),
    )
    let n = 0
    this.db.transaction(() => {
      for (const e of events) n += this.apply(e as never)
    })()
    return n
  }

  /** Pulls new events from every device's favorites log. Returns the number of rows that changed. */
  ingest(): number {
    const events = readNewEvents(this.db, this.libraryRoot, FAVORITES_LOG)
    let n = 0
    let last: string | null = null
    this.db.transaction(() => {
      for (const e of events) {
        if (!isCode(e.kind) || typeof e.k !== 'string' || !e.k) continue
        n += this.apply(e as never)
        if (!last || e.hlc > last) last = e.hlc
      }
    })()
    if (last) this.clock.observe(last)
    return n
  }

  /** Moves a like to an item's new key (a path-keyed track was renamed, an album moved folder). */
  moveKey(kind: FavoriteCode, from: string, to: string): boolean {
    if (!from || !to || from === to) return false
    const row = this.get(kind, from)
    if (!row?.liked) return false
    const target = this.get(kind, to)
    this.set(kind, [to], true, target?.liked ? target.at : row.at)
    this.set(kind, [from], false)
    return true
  }

  likedKeys(kind: FavoriteCode): Set<string> {
    const rows = this.db.prepare('SELECT item_key FROM favorites WHERE kind = ? AND liked = 1').all(kind) as Array<{ item_key: string }>
    return new Set(rows.map((r) => r.item_key))
  }
}
