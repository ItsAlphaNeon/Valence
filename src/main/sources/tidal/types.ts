// Shapes of the TIDAL v1/v2 JSON this module reads (only the fields we use; all others pass through raw).

export interface TidalArtistRef {
  id: number
  name: string
  /** MAIN | FEATURED (absent on some endpoints) */
  type?: string
  picture?: string | null
}

export interface TidalMediaMetadata {
  tags?: string[]
}

export interface TidalAlbum {
  id: number
  title: string
  version?: string | null
  cover?: string | null
  videoCover?: string | null
  releaseDate?: string | null
  streamStartDate?: string | null
  numberOfTracks?: number
  numberOfVolumes?: number
  numberOfVideos?: number
  duration?: number
  upc?: string | null
  copyright?: string | null
  explicit?: boolean
  /** ALBUM | EP | SINGLE | COMPILATION */
  type?: string
  audioQuality?: string
  mediaMetadata?: TidalMediaMetadata
  artist?: TidalArtistRef
  artists?: TidalArtistRef[]
  streamReady?: boolean
  allowStreaming?: boolean
  url?: string
}

export interface TidalTrack {
  id: number
  title: string
  version?: string | null
  duration: number
  trackNumber: number
  volumeNumber: number
  isrc?: string | null
  explicit?: boolean
  copyright?: string | null
  bpm?: number | null
  /** e.g. "A", "FSharp" */
  key?: string | null
  /** MAJOR | MINOR */
  keyScale?: string | null
  audioQuality?: string
  mediaMetadata?: TidalMediaMetadata
  artist?: TidalArtistRef
  artists?: TidalArtistRef[]
  album?: { id: number; title: string; cover?: string | null; version?: string | null; releaseDate?: string | null }
  streamReady?: boolean
  allowStreaming?: boolean
  replayGain?: number
  peak?: number
  url?: string
}

export interface TidalArtist {
  id: number
  name: string
  picture?: string | null
  popularity?: number
  url?: string
}

export interface TidalPlaylist {
  uuid: string
  title: string
  description?: string | null
  numberOfTracks?: number
  duration?: number
  image?: string | null
  squareImage?: string | null
  creator?: { id?: number; name?: string | null } | null
  type?: string
  lastUpdated?: string
  created?: string
  url?: string
}

export interface TidalPage<T> {
  limit: number
  offset: number
  totalNumberOfItems: number
  items: T[]
}

export interface TidalFavorite<T> {
  created: string
  item: T
}

export interface TidalLyrics {
  trackId?: number
  lyricsProvider?: string
  lyrics?: string | null
  /** LRC */
  subtitles?: string | null
  isRightToLeft?: boolean
}

export interface TidalPlaybackInfo {
  trackId: number
  assetPresentation?: string
  audioMode?: string
  /** LOW | HIGH | LOSSLESS | HI_RES_LOSSLESS */
  audioQuality?: string
  manifestMimeType: string
  manifestHash?: string
  /** base64 */
  manifest: string
  bitDepth?: number
  sampleRate?: number
  albumReplayGain?: number
  albumPeakAmplitude?: number
  trackReplayGain?: number
  trackPeakAmplitude?: number
}

export interface TidalSearchResponse {
  artists?: TidalPage<TidalArtist>
  albums?: TidalPage<TidalAlbum>
  tracks?: TidalPage<TidalTrack>
  playlists?: TidalPage<TidalPlaylist>
  topHit?: { type: string; value: { id?: number; uuid?: string } } | null
}

/** v2 my-collection/playlists/folders response. */
export interface TidalFolderPage {
  items?: Array<{ trn?: string; itemType?: string; addedAt?: string; name?: string; data?: TidalPlaylist }>
  totalNumberOfItems?: number
  cursor?: string | null
}

export interface TidalSession {
  sessionId?: string
  userId: number | string
  countryCode: string
}
