// Pure helpers shared by the TIDAL and Bandcamp views: error-kind parsing, import-job key matching,
// TIDAL routes and quality labels. No React, no window access (unit-tested in tests/unit).

import type { JobInfo } from '@shared/ipc/import'
import type { TidalLink } from '@shared/ipc/tidal'

// ---- Errors ----

export type SourceErrorKind = 'auth' | 'unavailable' | 'drm' | 'rate-limit' | 'abuse' | 'network' | 'parse' | 'cancelled'

const KINDS: readonly SourceErrorKind[] = ['auth', 'unavailable', 'drm', 'rate-limit', 'abuse', 'network', 'parse', 'cancelled']

export interface ParsedSourceError {
  kind: SourceErrorKind | null
  /** Message without the Electron "Error invoking remote method" wrapper and the "[kind]" prefix. */
  message: string
}

/**
 * Errors from main arrive as `Error invoking remote method 'ch': Error: [kind] message` (TIDAL tags the
 * SourceError kind in front) or plain `…: SourceError: message` (Bandcamp). Untagged messages fall back
 * to keyword heuristics so auth / rate-limit still read well.
 */
export function parseSourceError(e: unknown): ParsedSourceError {
  const raw = typeof e === 'string' ? e : ((e as { message?: unknown } | null)?.message as string | undefined) ?? String(e)
  let msg = String(raw)
    .replace(/^Error invoking remote method '[^']+':\s*/, '')
    .replace(/^\w*Error:\s*/, '')
    .trim()
  const m = /^\[([a-z-]+)\]\s*/i.exec(msg)
  let kind: SourceErrorKind | null = null
  if (m && (KINDS as readonly string[]).includes(m[1].toLowerCase())) {
    kind = m[1].toLowerCase() as SourceErrorKind
    msg = msg.slice(m[0].length).trim()
  } else if (/not logged in|log ?in again|session expired|logged out\?|login required/i.test(msg)) kind = 'auth'
  else if (/rate.?limit|too many requests|HTTP 429/i.test(msg)) kind = 'rate-limit'
  else if (/ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|ERR_INTERNET|ERR_NAME_NOT_RESOLVED|fetch failed|request failed/i.test(msg)) kind = 'network'
  return { kind, message: msg || 'Something went wrong' }
}

export interface ErrorCopy {
  kind: SourceErrorKind | null
  title: string
  detail: string
}

/** User-facing copy for an error from a source (`source` is the display name, e.g. "TIDAL"). */
export function describeSourceError(source: string, e: unknown): ErrorCopy {
  const { kind, message } = parseSourceError(e)
  switch (kind) {
    case 'auth':
      return { kind, title: `Log in to ${source} again`, detail: `Your ${source} session has expired or was signed out. ${message}`.trim() }
    case 'abuse':
      return { kind, title: `${source} paused downloads (possible account flag)`, detail: `Resume from Import once you've checked your account. ${message}`.trim() }
    case 'rate-limit':
      return { kind, title: `${source} is rate limiting requests`, detail: 'Wait a minute and try again.' }
    case 'network':
      return { kind, title: `Couldn't reach ${source}`, detail: `Check your connection and try again. ${message}`.trim() }
    case 'unavailable':
      return { kind, title: 'Not available', detail: message }
    case 'drm':
      return { kind, title: 'Protected stream', detail: `${source} only offers a protected stream for this item; Valence never handles those.` }
    case 'cancelled':
      return { kind, title: 'Cancelled', detail: message }
    default:
      return { kind, title: 'Something went wrong', detail: message }
  }
}

// ---- Import jobs / release keys ----

export type QueueState = 'queued' | 'running'

/** Release key → its active (queued/running) import job. A running job wins over a queued one. */
export function activeJobsByKey(jobs: readonly JobInfo[]): Map<string, JobInfo> {
  const out = new Map<string, JobInfo>()
  for (const j of jobs) {
    if (j.status !== 'queued' && j.status !== 'running') continue
    for (const k of j.releaseKeys ?? []) {
      const cur = out.get(k)
      if (!cur || (cur.status !== 'running' && j.status === 'running')) out.set(k, j)
    }
  }
  return out
}

/** The active job for the first matching key (running preferred), if any. */
export function jobForKeys(active: ReadonlyMap<string, JobInfo>, keys: readonly string[]): JobInfo | undefined {
  let found: JobInfo | undefined
  for (const k of keys) {
    const j = active.get(k)
    if (!j) continue
    if (j.status === 'running') return j
    found ??= j
  }
  return found
}

export const tidalAlbumKeys = (a: { id: string; upc?: string | null }): string[] => [`tidal:album:${a.id}`, ...(a.upc ? [`upc:${a.upc}`] : [])]

/** A track counts as queued when its own job or a job for its whole album is active. */
export const tidalTrackKeys = (t: { id: string; album?: { id: string } | null }): string[] => [`tidal:track:${t.id}`, ...(t.album ? [`tidal:album:${t.album.id}`] : [])]

/** Pseudo key for a whole-playlist download (tracked client-side through the returned job ids). */
export const tidalPlaylistKey = (uuid: string): string => `tidal:playlist:${uuid}`

export const bandcampKeys = (i: { tralbumType: 'album' | 'track'; tralbumId: number }): string[] => [`bc:${i.tralbumType}:${i.tralbumId}`]

export interface PendingDownload {
  keys: string[]
  jobIds: string[]
  /** ms epoch the download was requested. */
  at: number
}

/** How long a requested download counts as queued before its job shows up in the job list. */
export const PENDING_GRACE_MS = 15_000

/**
 * Queue state for a client-side pending download: the state of its jobs once they are known, or
 * 'queued' during the grace period while the job broadcast is in flight.
 */
export function pendingState(p: PendingDownload, jobs: readonly JobInfo[], now: number): QueueState | null {
  let seen = false
  let state: QueueState | null = null
  for (const id of p.jobIds) {
    const j = jobs.find((x) => x.id === id)
    if (!j) continue
    seen = true
    if (j.status === 'running') return 'running'
    if (j.status === 'queued') state = 'queued'
  }
  if (state) return state
  if (!seen && now - p.at < PENDING_GRACE_MS) return 'queued'
  return null
}

// ---- TIDAL routes ----

export type TidalFavTab = 'albums' | 'tracks' | 'playlists' | 'artists'
export type TidalRoute =
  | { page: 'favorites'; tab: TidalFavTab }
  | { page: 'search'; query: string }
  | { page: 'album'; id: string }
  | { page: 'artist'; id: string }
  | { page: 'playlist'; id: string }

export const FAV_TABS: readonly TidalFavTab[] = ['albums', 'tracks', 'playlists', 'artists']

/** `{ view: 'tidal', tab, id }` → page. Unknown tabs or a detail tab without id fall back to favorite albums. */
export function parseTidalRoute(tab?: string, id?: string): TidalRoute {
  const t = (tab ?? '').toLowerCase()
  if ((FAV_TABS as readonly string[]).includes(t)) return { page: 'favorites', tab: t as TidalFavTab }
  if (t === 'search') return { page: 'search', query: (id ?? '').trim() }
  if ((t === 'album' || t === 'artist' || t === 'playlist') && id) return { page: t, id }
  return { page: 'favorites', tab: 'albums' }
}

/** Route args for a resolved link; tracks have no page of their own (null). */
export function routeForLink(link: TidalLink): { tab: string; id: string } | null {
  if (link.kind === 'album' || link.kind === 'artist' || link.kind === 'playlist') return { tab: link.kind, id: link.id }
  return null
}

export const looksLikeTidalLink = (s: string): boolean => /(^|\/\/|\.)tidal\.com\//i.test(s.trim()) || /^tidal:\/\//i.test(s.trim())

// ---- Labels ----

export interface QualityChip {
  label: string
  title: string
  kind: 'ok' | 'warn' | 'accent' | ''
}

/** Valence downloads LOSSLESS (16-bit/44.1 kHz FLAC) whatever higher tier TIDAL offers. */
export function tidalQualityChip(quality: string | null | undefined, mediaTags: readonly string[] = []): QualityChip | null {
  const q = (quality ?? '').toUpperCase()
  const hires = q === 'HI_RES_LOSSLESS' || q === 'HI_RES' || mediaTags.includes('HIRES_LOSSLESS')
  if (hires) return { label: 'Lossless', kind: 'accent', title: 'TIDAL offers Hi-Res for this release; Valence downloads 16-bit/44.1 kHz FLAC' }
  if (q === 'LOSSLESS' || mediaTags.includes('LOSSLESS')) return { label: 'Lossless', kind: 'accent', title: 'Downloads as 16-bit/44.1 kHz FLAC' }
  if (q === 'HIGH') return { label: 'AAC 320', kind: 'warn', title: 'TIDAL only offers a lossy AAC stream for this release' }
  if (q === 'LOW') return { label: 'AAC 96', kind: 'warn', title: 'TIDAL only offers a low-quality AAC stream for this release' }
  return null
}

/** TIDAL album `type` → display label. */
export function tidalReleaseType(type: string | null | undefined, tracks?: number): string {
  switch ((type ?? '').toUpperCase()) {
    case 'EP':
      return 'EP'
    case 'SINGLE':
      return 'Single'
    case 'COMPILATION':
      return 'Compilation'
    case 'ALBUM':
      return 'Album'
    default:
      // Type missing: guess from the track count.
      return tracks != null && tracks > 0 && tracks <= 3 ? 'Single' : 'Album'
  }
}

/** "Queued 3 tracks · 9 already in library · 1 unavailable" */
export function playlistResultText(r: { queued: number; alreadyInLibrary: number; alreadyQueued: number; unavailable: number }): string {
  const n = (x: number, one: string, many = `${one}s`) => `${x} ${x === 1 ? one : many}`
  const parts = [r.queued ? `Queued ${n(r.queued, 'track')}` : 'Nothing new to download']
  if (r.alreadyInLibrary) parts.push(`${r.alreadyInLibrary} already in library`)
  if (r.alreadyQueued) parts.push(`${r.alreadyQueued} already queued`)
  if (r.unavailable) parts.push(`${r.unavailable} unavailable`)
  return parts.join(' · ')
}
