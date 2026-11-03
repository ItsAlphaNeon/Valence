// Renderer-facing contract for SiIvaGunner rips: the highquality.rip / SGFR album catalog (Google
// Drive downloads) and the YouTube playlist that fills the season albums.

import type { InLibraryBadge } from '../types'

export const HQRIP_IPC = {
  /** (refresh?: boolean) → HqrCatalog */
  catalog: 'hqrip:catalog',
  /** (releaseId: string) → HqrDownloadResult */
  download: 'hqrip:download',
  /** (collection: 'SiIvaGunner' | 'SGFR') → HqrDownloadAllResult */
  downloadAllMissing: 'hqrip:downloadAllMissing',
  /** main → renderer: catalog details (track counts, covers) or badges changed */
  catalogUpdated: 'hqrip:catalogUpdated',
  /** () → YoutubeStatus */
  youtubeStatus: 'hqrip:youtubeStatus',
  /** () → YoutubeStatus (runs a playlist sync now) */
  youtubeSync: 'hqrip:youtubeSync',
  /** main → renderer: (status: YoutubeStatus) */
  youtubeChanged: 'hqrip:youtubeChanged',
  /** () → SeasonInfo[] */
  seasons: 'hqrip:seasons',
  /** (seasons: SeasonDef[]) → SeasonInfo[] (re-files tracks whose season changed) */
  setSeasons: 'hqrip:setSeasons',
  /** (key: string, data: Uint8Array | null, mime?: string) → SeasonInfo[] (null restores the placeholder) */
  setSeasonCover: 'hqrip:setSeasonCover',
} as const

export type HqrCollection = 'SiIvaGunner' | 'SGFR'
export type HqrSgfrType = 'Album' | 'Single' | 'Soundtrack'

export interface HqrRelease {
  /** Stable id: "hqr:<Drive folder id>" or "sgfr:<SGFR id>", also the HQR_RELEASE tag of its tracks. */
  id: string
  collection: HqrCollection
  title: string
  /** "SGFR-0016" */
  catalogNumber?: string
  sgfrType?: HqrSgfrType
  /** Drive folder ids per format offered. */
  folders: { flac?: string; mp3?: string; ogg?: string }
  /** Cover image URL when known (SGFR artwork, or a Drive thumbnail after the folder was listed). */
  cover: string | null
  bandcampUrl?: string
  /** Audio files in the folder Valence downloads; known once listed. */
  trackCount: number | null
  /** Which format a download uses. */
  format: 'flac' | 'ogg' | 'mp3' | null
  badge: InLibraryBadge
  queue?: 'queued' | 'running'
}

export interface HqrCatalog {
  releases: HqrRelease[]
  fetchedAt: number
  /** Set when a refresh failed and the cached catalog is shown. */
  error?: string
}

export interface HqrDownloadResult {
  jobId: string
  releaseKeys: string[]
  title: string
}

export interface HqrDownloadAllResult {
  queued: number
  jobIds: string[]
  alreadyInLibrary: number
  alreadyQueued: number
}

// ---- YouTube playlist → season albums ----

export type YoutubeEntryState = 'in-library' | 'queued' | 'running' | 'missing' | 'not-siivagunner' | 'unavailable'

export interface YoutubeEntry {
  id: string
  title: string
  durationSec: number | null
  channel: string | null
  state: YoutubeEntryState
}

export interface YoutubeStatus {
  playlistUrl: string | null
  autoSync: boolean
  syncing: boolean
  /** ms epoch of the last finished sync */
  lastSync: number | null
  playlistTitle: string | null
  entries: YoutubeEntry[]
  /** "Queued 3 rips · 120 already in library · 2 skipped (other channels)" */
  summary: string | null
  error: string | null
  ytDlpVersion: string | null
}

export interface SeasonDef {
  /** Stable key, e.g. "s7", used for the cover file. */
  key: string
  name: string
  /** YYYY-MM-DD (UTC): a video belongs to the latest season starting on or before its upload date. */
  start: string
}

export interface SeasonInfo extends SeasonDef {
  album: string
  tracks: number
  /** Data URL of the cover used for new tracks (placeholder until you set one). */
  cover: string
  customCover: boolean
}
