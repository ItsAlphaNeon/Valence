// Library IPC contract (renderer <-> main).

import type { AlbumRow, ArtistRow, GenreRow, LibraryStats, TrackQuery, TrackRow, TrackTags } from '../types'

export const LIB = {
  stats: 'library:stats',
  tracks: 'library:tracks',
  track: 'library:track',
  tracksByIds: 'library:tracksByIds',
  albums: 'library:albums',
  album: 'library:album',
  artists: 'library:artists',
  genres: 'library:genres',
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
  /** broadcast: library contents changed ({ tracks?: number[]; albums?: number[]; full?: boolean }) */
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

export type { AlbumRow, ArtistRow, GenreRow, LibraryStats, TrackQuery, TrackRow }
