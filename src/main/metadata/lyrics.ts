// LRCLIB lyrics lookup: exact /api/get first, then /api/search by closest duration (±2 s).

import { fetchJson, DAY, type HttpDeps } from './http'
import type { RateLimiter } from './limiter'

export const LRCLIB_ROOT = 'https://lrclib.net/api/'

export interface LrclibRecord {
  id?: number
  trackName?: string
  artistName?: string
  albumName?: string
  duration?: number
  instrumental?: boolean
  plainLyrics?: string | null
  syncedLyrics?: string | null
}

export interface LyricsResult { synced?: string; plain?: string }

export function lyricsFromRecord(r: LrclibRecord | null | undefined): LyricsResult | null {
  if (!r) return null
  const synced = r.syncedLyrics?.trim() ? r.syncedLyrics.replace(/\r\n/g, '\n') : undefined
  const plain = r.plainLyrics?.trim() ? r.plainLyrics.replace(/\r\n/g, '\n') : undefined
  return synced || plain ? { ...(synced ? { synced } : {}), ...(plain ? { plain } : {}) } : null
}

/** Closest-duration search hit within ±2 s; synced lyrics break ties. */
export function pickSearchResult(results: LrclibRecord[], durationSec: number): LrclibRecord | null {
  let best: LrclibRecord | null = null
  let bestKey = Infinity
  for (const r of results) {
    if (typeof r.duration !== 'number' || !lyricsFromRecord(r)) continue
    const d = Math.abs(r.duration - durationSec)
    if (d > 2) continue
    const key = d - (r.syncedLyrics ? 0.01 : 0)
    if (key < bestKey) { best = r; bestKey = key }
  }
  return best
}

export async function fetchLyrics(
  deps: HttpDeps & { limiter: RateLimiter; userAgent: string },
  q: { artist: string; title: string; album?: string; durationMs: number },
): Promise<LyricsResult | null> {
  const dur = Math.round(q.durationMs / 1000)
  const p = new URLSearchParams({ artist_name: q.artist, track_name: q.title })
  if (q.album) p.set('album_name', q.album)
  p.set('duration', String(dur))
  const o = { limiter: deps.limiter, headers: { 'User-Agent': deps.userAgent, Accept: 'application/json' }, ttlSec: 30 * DAY, notFoundTtlSec: 3 * DAY }
  const hit = await fetchJson<LrclibRecord>(deps, `${LRCLIB_ROOT}get?${p}`, o).catch(() => null)
  const direct = lyricsFromRecord(hit)
  if (direct) return direct
  if (hit?.instrumental) return null
  const s = new URLSearchParams({ track_name: q.title, artist_name: q.artist })
  const list = await fetchJson<LrclibRecord[]>(deps, `${LRCLIB_ROOT}search?${s}`, o)
  return lyricsFromRecord(pickSearchResult(Array.isArray(list) ? list : [], dur))
}
