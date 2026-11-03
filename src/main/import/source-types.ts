// Contract between source adapters (TIDAL, Bandcamp, loose files) and the import pipeline.
// A source "acquires" a release into a staging directory and hands the pipeline a SourceRelease
// whose tracks point at local files. Source metadata is authoritative for identity fields.

import type { SourceKind, TrackTags } from '@shared/types'

/** Standard fetch signature. In Electron this is `session.fetch`; tests inject fakes. */
export type Transport = (url: string, init?: RequestInit) => Promise<Response>

export interface SourceArtwork {
  /** Local file already downloaded into staging (preferred). */
  file?: string
  /** Remote URL the pipeline may fetch if `file` is absent. */
  url?: string
  /** Fallback URLs tried in order if `url` fails. */
  fallbackUrls?: string[]
}

export interface SourceTrack {
  /** Absolute path of the acquired audio file in staging. */
  file: string
  /** Source-provided tags (title, artist(s), track/disc numbers, ISRC, ids, lyrics…). */
  tags: TrackTags
  durationMs?: number
  /** Raw source JSON for this track (stored in the archive's source.json). */
  raw?: unknown
}

export interface SourceRelease {
  source: SourceKind
  /** Keys identifying this release for claims/dedupe, e.g. "tidal:album:123", "upc:0123…", "bc:album:999". */
  releaseKeys: string[]
  /** Tags common to every track (album, albumartist, date, label, barcode, copyright, genre…). */
  albumTags: TrackTags
  tracks: SourceTrack[]
  artwork?: SourceArtwork
  /** Non-audio files (PDF booklets, images) to keep in the archive's extras/ folder. */
  extras?: string[]
  /** Raw source JSON for the release. */
  raw?: unknown
  /** Human-readable label for the import report, e.g. "TIDAL · Artist — Album". */
  title: string
}

export interface AcquireProgress {
  phase: 'resolving' | 'downloading' | 'waiting' | 'processing' | 'done' | 'error'
  /** 0..1 */
  fraction?: number
  message?: string
  trackIndex?: number
  trackCount?: number
}

export type ProgressFn = (p: AcquireProgress) => void

/** Error classes sources use so the queue can decide what to do. */
export class SourceError extends Error {
  constructor(
    message: string,
    public readonly kind:
      | 'auth' // needs (re)login
      | 'unavailable' // item not streamable/downloadable; skip it
      | 'drm' // protected stream; refused, never circumvented
      | 'rate-limit' // back off and retry later
      | 'abuse' // provider signalled abuse/suspension: stop the whole queue
      | 'network'
      | 'parse'
      | 'cancelled'
      | 'archive-offline', // lossless masters have nowhere to go yet; wait for the archive drive
    public readonly retryAfterMs?: number,
  ) {
    super(message)
    this.name = 'SourceError'
  }
}
