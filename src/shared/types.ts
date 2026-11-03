// Types shared between main, preload and renderer.

export type SourceKind = 'tidal' | 'bandcamp' | 'import'

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
  tidal_track_id?: string
  tidal_album_id?: string
  bandcamp_item_id?: string
  bandcamp_url?: string
  source?: SourceKind
  /** Quality of the original source, e.g. "lossless:16:44100" or "lossy:mp3:320" (used for upgrade decisions) */
  source_quality?: string
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
}

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
}

export interface ArtistRow {
  name: string
  albumCount: number
  trackCount: number
  artHash: string | null
}

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
}

export interface LibraryStats {
  tracks: number
  albums: number
  artists: number
  durationMs: number
  bytes: number
  libraryRoot: string
  scanning: boolean
}

export type InLibraryStatus = 'in-library' | 'partial' | 'missing'

export interface InLibraryBadge {
  status: InLibraryStatus
  have: number
  total: number
}
