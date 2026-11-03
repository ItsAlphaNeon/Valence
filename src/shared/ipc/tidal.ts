// Renderer-facing TIDAL IPC contract. Invoke with window.valence.invoke(TIDAL_IPC.x, ...args).

import type { InLibraryBadge } from '../types'

export const TIDAL_IPC = {
  /** () → TidalStatus */
  status: 'tidal:status',
  /** () → TidalStatus (opens the login window) */
  login: 'tidal:login',
  /** () → TidalStatus */
  logout: 'tidal:logout',
  /** (kind: TidalFavoriteKind, offset = 0, limit = 50) → TidalPageResult<…> */
  favorites: 'tidal:favorites',
  /** (query: string, types?: TidalSearchType[]) → TidalSearchResult */
  search: 'tidal:search',
  /** (id: string) → TidalAlbumDetail */
  album: 'tidal:album',
  /** (id: string) → TidalArtistDetail */
  artist: 'tidal:artist',
  /** (uuid: string) → TidalPlaylistDetail */
  playlist: 'tidal:playlist',
  /** (id: string) → TidalTrackSummary (for pasted track links) */
  track: 'tidal:track',
  /** (url: string) → TidalLink | null */
  resolveLink: 'tidal:resolveLink',
  /** (req: TidalDownloadRequest) → TidalDownloadResult */
  download: 'tidal:download',
  /** (uuid: string) → TidalPlaylistDownloadResult */
  downloadPlaylist: 'tidal:downloadPlaylist',
  /** main → renderer event: (status: TidalStatus) */
  statusChanged: 'tidal:statusChanged',
} as const

export type TidalChannel = (typeof TIDAL_IPC)[keyof typeof TIDAL_IPC]

export interface TidalStatus {
  loggedIn: boolean
  userId: string | null
  countryCode: string | null
}

export type TidalQueueState = 'queued' | 'running'
export type TidalFavoriteKind = 'albums' | 'tracks' | 'artists' | 'playlists'
export type TidalSearchType = 'ARTISTS' | 'ALBUMS' | 'TRACKS' | 'PLAYLISTS'
export type TidalLinkKind = 'album' | 'track' | 'playlist' | 'artist' | 'mix' | 'video'

export interface TidalLink {
  kind: TidalLinkKind
  id: string
}

export interface TidalArtistRefSummary {
  id: string
  name: string
}

export interface TidalAlbumSummary {
  id: string
  title: string
  /** Display credit of the main artist(s). */
  artist: string
  artists: TidalArtistRefSummary[]
  /** 640px cover URL */
  cover: string | null
  releaseDate: string | null
  year: number | null
  numberOfTracks: number
  numberOfVolumes: number
  durationSec: number
  /** ALBUM | EP | SINGLE | COMPILATION */
  type: string
  explicit: boolean
  /** TIDAL audioQuality, e.g. LOSSLESS / HI_RES_LOSSLESS */
  quality: string | null
  mediaTags: string[]
  upc: string | null
  url: string
  badge: InLibraryBadge
  queue?: TidalQueueState
}

export interface TidalTrackSummary {
  id: string
  /** Title including version */
  title: string
  artist: string
  artists: TidalArtistRefSummary[]
  album: { id: string; title: string; cover: string | null } | null
  trackNumber: number
  volumeNumber: number
  durationSec: number
  explicit: boolean
  isrc: string | null
  quality: string | null
  streamable: boolean
  url: string
  inLibrary: boolean
  queue?: TidalQueueState
}

export interface TidalArtistSummary {
  id: string
  name: string
  picture: string | null
  url: string
  /** Some of this artist's songs are in the library. */
  inLibrary: boolean
  /** How many (album artist or track artist match). */
  libraryTracks?: number
}

export interface TidalPlaylistSummary {
  uuid: string
  title: string
  description: string | null
  numberOfTracks: number
  durationSec: number
  image: string | null
  creator: string | null
  url: string
  /** null in list views (tracks not loaded); set in TidalPlaylistDetail. */
  badge: InLibraryBadge | null
  queue?: TidalQueueState
}

export interface TidalPageResult<T> {
  items: T[]
  offset: number
  limit: number
  total: number
}

export interface TidalSearchResult {
  artists: TidalArtistSummary[]
  albums: TidalAlbumSummary[]
  tracks: TidalTrackSummary[]
  playlists: TidalPlaylistSummary[]
  topHit: TidalLink | null
}

export interface TidalAlbumDetail {
  album: TidalAlbumSummary
  tracks: TidalTrackSummary[]
}

export interface TidalArtistDetail {
  artist: TidalArtistSummary
  albums: TidalAlbumSummary[]
  epsAndSingles: TidalAlbumSummary[]
  compilations: TidalAlbumSummary[]
}

export interface TidalPlaylistDetail {
  playlist: TidalPlaylistSummary
  tracks: TidalTrackSummary[]
}

export interface TidalDownloadRequest {
  kind: 'album' | 'track'
  id: string
  onlyMissing?: boolean
}

export interface TidalDownloadResult {
  jobId: string
  title: string
  releaseKeys: string[]
}

export interface TidalPlaylistDownloadResult {
  queued: number
  alreadyInLibrary: number
  alreadyQueued: number
  unavailable: number
  jobIds: string[]
}
