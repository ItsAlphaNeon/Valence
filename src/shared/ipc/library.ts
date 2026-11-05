// Library IPC contract (renderer <-> main).

import type { AlbumRow, ArtistRow, FavoriteCounts, FavoriteKind, GenreRow, LibraryCollection, LibraryStats, TrackQuery, TrackRow, TrackTags } from '../types'

export const LIB = {
  stats: 'library:stats',
  tracks: 'library:tracks',
  /** (TrackQuery) → number[] in query order (for "play all"). */
  trackIds: 'library:trackIds',
  track: 'library:track',
  tracksByIds: 'library:tracksByIds',
  albums: 'library:albums',
  album: 'library:album',
  artists: 'library:artists',
  genres: 'library:genres',
  /** (artHash) → { r, g, b, luminance } | null */
  artColor: 'library:artColor',
  search: 'library:search',
  rescan: 'library:rescan',
  setRating: 'library:setRating',
  getTags: 'library:getTags',
  editTags: 'library:editTags',
  setArtwork: 'library:setArtwork',
  reveal: 'library:reveal',
  recordPlay: 'library:recordPlay',
  playlists: 'library:playlists',
  playlistTracks: 'library:playlistTracks',
  createPlaylist: 'library:createPlaylist',
  addToPlaylist: 'library:addToPlaylist',
  setPlaylistItems: 'library:setPlaylistItems',
  renamePlaylist: 'library:renamePlaylist',
  deletePlaylist: 'library:deletePlaylist',
  saveSmartPlaylist: 'library:saveSmartPlaylist',
  playItems: 'library:playItems',
  /** (SetLikedRequest, liked: boolean) → void; then broadcasts `changed` with { favorites: true, tracks?, albums? }. */
  setLiked: 'library:setLiked',
  /** (collection?: LibraryCollection, default 'all') → FavoriteCounts */
  favoriteCounts: 'library:favoriteCounts',
  /** (AlbumQuery with offset/limit) → AlbumsPage */
  albumsPage: 'library:albumsPage',
  /** (StatsRange) → ListeningStats */
  listeningStats: 'library:listeningStats',
  history: 'library:history',
  ripGames: 'library:ripGames',
  /** (seedTrackIds: number[], excludeIds: number[], n: number) → number[] track ids (main library), for autoplay. */
  similar: 'library:similar',
  /** (albumId) → ArtOriginal | null: the archived cover-original if there is one, else the full-size embedded art. */
  artOriginal: 'library:artOriginal',
  /**
   * broadcast: library contents changed
   * ({ tracks?: number[]; albums?: number[]; full?: boolean; plays?: boolean; playlists?: boolean; favorites?: boolean })
   */
  changed: 'library:changed',
  /** broadcast: scan progress ({ done, total } | null when finished) */
  scanProgress: 'library:scanProgress',
} as const

export interface SearchResult {
  tracks: TrackRow[]
  albums: AlbumRow[]
  artists: ArtistRow[]
}

export interface AlbumDetail {
  album: AlbumRow
  tracks: TrackRow[]
}

export interface EditTagsRequest {
  ids: number[]
  /** Fields to set; a value of null clears the field. Only listed fields change. */
  patch: Partial<Record<keyof TrackTags, unknown>>
}

export interface EditTagsResult {
  updated: number
  moved: number
  errors: Array<{ id: number; error: string }>
}

/** Everything the player needs to play a library track. */
export interface LibraryPlayItem {
  /** `t<trackId>`: unique per library row. */
  id: string
  trackId: number
  path: string
  title: string
  artist: string
  album: string
  albumKey?: string
  trackNo?: number
  discNo?: number
  durationMs: number
  artUrl?: string
  valenceId?: string
  rg?: { trackGain?: number; trackPeak?: number; albumGain?: number; albumPeak?: number }
}

/** library:setLiked's first argument. Artists are named by album artist (matched case-insensitively). */
export type SetLikedRequest = { kind: 'track' | 'album'; ids: number[] } | { kind: 'artist'; names: string[] }

/** library:albums / library:albumsPage query. */
export interface AlbumQuery {
  albumArtist?: string
  genre?: string
  search?: string
  /** Default 'artist'; with `liked` and no sort, most recently liked first. */
  sort?: 'artist' | 'title' | 'year' | 'added' | 'likedAt'
  limit?: number
  offset?: number
  /** Default 'main' ('all' with `liked`). */
  collection?: LibraryCollection
  ripKinds?: string[]
  /** Only liked albums. */
  liked?: boolean
}

export interface AlbumsPage {
  rows: AlbumRow[]
  /** Albums matching the query, ignoring offset/limit. */
  total: number
}

/** '7d' / '30d' / '90d' are calendar days including today; 'year' is the last 365 days. */
export type StatsRange = '7d' | '30d' | '90d' | 'year' | 'all'

export interface ListeningStats {
  /** Plays (not skips) in range. */
  plays: number
  skips: number
  /** Time listened in range, skips included. */
  ms: number
  distinctTracks: number
  distinctArtists: number
  /** All collections (rips included); `hqRip` tells them apart. */
  topTracks: Array<TrackRow & { plays: number }>
  topAlbums: Array<AlbumRow & { plays: number }>
  /** By album artist (track artist on Various Artists compilations). */
  topArtists: Array<{ name: string; plays: number; ms: number; artHash: string | null }>
  /** Every local day from the range start (for 'year' / 'all': the first play, at most 400 days back) to today. */
  byDay: Array<{ day: string /* YYYY-MM-DD local */; plays: number; ms: number }>
  /** Plays per local hour 0..23. */
  byHour: number[]
  /** Plays per weekday, Monday = 0. */
  byWeekday: number[]
  /** Main-library tracks per format, most common first ('FLAC', 'FLAC 24/96', 'MP3 320', 'AAC 256'...). */
  formats: Array<{ label: string; tracks: number }>
  library: LibraryStats
  /** Earliest play in range (ever, for 'all'), or null. */
  firstPlay: number | null
}

export interface ArtOriginal {
  /** valence-art://original/<albumId>?v=<mtime> (archive) or valence-art://img/<hash>?s=0 (embedded, full size). */
  url: string
  source: 'archive' | 'embedded'
}

export type { AlbumRow, ArtistRow, FavoriteCounts, FavoriteKind, GenreRow, LibraryStats, TrackQuery, TrackRow }
