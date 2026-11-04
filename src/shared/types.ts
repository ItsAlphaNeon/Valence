// Types shared between main, preload and renderer.

export type SourceKind = 'tidal' | 'bandcamp' | 'import' | 'hqrip' | 'youtube'

/** SiIvaGunner "High Quality Rip" collections; any value marks a track as a rip (kept out of the main library). */
export type RipCollection = 'SiIvaGunner' | 'SGFR' | 'YouTube'

/** Genre every rip carries so other players (phones) can separate rips too. */
export const RIP_GENRE = 'High Quality Rip'

/**
 * Canonical track metadata. Field names follow MusicBrainz Picard's internal tag names so the
 * mapping to ID3v2 / Vorbis / MP4 stays Picard-compatible (see tag-schema.ts).
 */
export interface TrackTags {
  title?: string
  artist?: string
  artists?: string[]
  album?: string
  albumartist?: string
  albumartists?: string[]
  artistsort?: string
  albumartistsort?: string
  titlesort?: string
  albumsort?: string
  tracknumber?: number
  totaltracks?: number
  discnumber?: number
  totaldiscs?: number
  /** ISO date or partial (YYYY, YYYY-MM, YYYY-MM-DD) */
  date?: string
  originaldate?: string
  genre?: string
  compilation?: boolean
  isrc?: string
  barcode?: string
  label?: string
  catalognumber?: string
  copyright?: string
  bpm?: number
  key?: string
  comment?: string
  media?: string
  explicit?: boolean
  musicbrainz_recordingid?: string
  musicbrainz_trackid?: string
  musicbrainz_albumid?: string
  musicbrainz_releasegroupid?: string
  musicbrainz_artistid?: string[]
  musicbrainz_albumartistid?: string[]
  releasetype?: string
  releasestatus?: string
  releasecountry?: string
  acoustid_id?: string
  replaygain_track_gain?: number
  replaygain_track_peak?: number
  replaygain_album_gain?: number
  replaygain_album_peak?: number
  /** LRC text when synced, plain text otherwise */
  lyrics?: string
  /** 0..5 stars, 0 = unrated */
  rating?: number
  valence_id?: string
  /** Random id of the device that imported (owns) this file; only that device reorganizes it. */
  valence_owner?: string
  tidal_track_id?: string
  tidal_album_id?: string
  /** Bandcamp tralbum id of the release (album id, or track id for a standalone track purchase) */
  bandcamp_item_id?: string
  bandcamp_track_id?: string
  bandcamp_url?: string
  source?: SourceKind
  /** Quality of the original source, e.g. "lossless:16:44100" or "lossy:mp3:320" (used for upgrade decisions) */
  source_quality?: string
  composer?: string
  /** Rip collection; set = the track lives in the SiIvaGunner section, not the main library. */
  hq_rip?: string
  youtube_video_id?: string
  /** ISO time the video went up (premiere time when it had one); orders season albums. */
  youtube_uploaded?: string
  gdrive_file_id?: string
  /** Catalog release a rip came from, e.g. "hqr:<flac folder id>" or "sgfr:0016". */
  hqr_release?: string
  /** Game a rip is from, and its platform (from the video description). */
  rip_game?: string
  rip_platform?: string
}

export interface AudioFormat {
  container: string
  codec: string
  lossless: boolean
  bitrate: number // bits per second
  sampleRate: number
  bitDepth: number
  channels: number
  durationMs: number
}

export interface TrackRow {
  id: number
  valenceId: string | null
  relPath: string
  title: string
  artist: string
  album: string
  albumArtist: string
  trackNo: number | null
  trackTotal: number | null
  discNo: number | null
  discTotal: number | null
  year: number | null
  date: string | null
  genre: string | null
  durationMs: number
  codec: string
  bitrate: number
  sampleRate: number
  lossless: boolean
  rating: number
  albumId: number | null
  artHash: string | null
  addedAt: number
  lyricsKind: 'none' | 'plain' | 'synced'
  playCount: number
  lastPlayed: number | null
  isrc: string | null
  tidalTrackId: string | null
  bandcampItemId: string | null
  source: string | null
  rgTrackGain: number | null
  rgTrackPeak: number | null
  rgAlbumGain: number | null
  rgAlbumPeak: number | null
  compilation: boolean
  /** Rip collection ('' for normal music). */
  hqRip: string
  composer: string | null
  ripGame: string | null
  youtubeVideoId: string | null
  /** In the user's favorites (synced across devices). */
  liked: boolean
  /** When it was liked (ms), null when not liked. */
  likedAt: number | null
}

/** Which half of the library a query covers: normal music, SiIvaGunner rips, or both. */
export type LibraryCollection = 'main' | 'rips' | 'all'

export interface AlbumRow {
  id: number
  title: string
  albumArtist: string
  year: number | null
  trackCount: number
  trackTotal: number | null
  durationMs: number
  artHash: string | null
  relDir: string
  genre: string | null
  addedAt: number
  compilation: boolean
  hqRip: string
  liked: boolean
}

export interface ArtistRow {
  name: string
  albumCount: number
  trackCount: number
  artHash: string | null
  liked: boolean
}

/** What can be liked. Artists are keyed by album artist name (case-insensitive). */
export type FavoriteKind = 'track' | 'album' | 'artist'

export interface FavoriteCounts {
  tracks: number
  albums: number
  artists: number
}

/** Height (px, at zoom 1) of the renderer's top bar; the native window controls overlay matches it. */
export const TOPBAR_HEIGHT = 64

export interface GenreRow {
  name: string
  trackCount: number
  albumCount: number
}

export type SortDir = 'asc' | 'desc'

export interface TrackQuery {
  search?: string
  albumId?: number
  albumArtist?: string
  artist?: string
  genre?: string
  playlistId?: string
  sort?: { key: keyof TrackRow; dir: SortDir }
  limit?: number
  offset?: number
  recentlyAdded?: boolean
  /** Default 'main'; album and playlist lookups default to 'all' (a rip album must still open). */
  collection?: LibraryCollection
  /** With collection 'rips': only these rip collections (e.g. ['YouTube'] for season albums). */
  ripKinds?: string[]
  /**
   * Only liked tracks (collection defaults to 'all', like album/playlist lookups). Without an
   * explicit sort, most recently liked first.
   */
  liked?: boolean
}

export interface LibraryStats {
  /** Counts cover the main library only. */
  tracks: number
  albums: number
  artists: number
  durationMs: number
  bytes: number
  ripTracks: number
  ripAlbums: number
  libraryRoot: string
  scanning: boolean
}

export type InLibraryStatus = 'in-library' | 'partial' | 'missing'

export interface InLibraryBadge {
  status: InLibraryStatus
  have: number
  total: number
}
