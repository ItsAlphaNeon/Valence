// TIDAL JSON → TrackTags / SourceRelease, plus the badge queries used for in-library checks.

import { isVariousArtists, joinCredit, VARIOUS_ARTISTS } from '@shared/artist-credit'
import { encodeSourceQuality } from '@shared/quality'
import { cleanText } from '@shared/sanitize'
import type { TrackTags } from '@shared/types'
import type { BadgeQueryAlbum, BadgeQueryTrack } from '../../context'
import type { SourceArtwork, SourceRelease, SourceTrack } from '../../import/source-types'
import { imageUrl } from './config'
import type { TidalAlbum, TidalArtistRef, TidalLyrics, TidalPlaybackInfo, TidalTrack } from './types'

/** "Title (Version)" unless the title already carries the version. */
export function fullTitle(title: string | null | undefined, version?: string | null): string {
  const t = cleanText(title)
  const v = cleanText(version)
  if (!v || t.toLowerCase().includes(v.toLowerCase())) return t
  return `${t} (${v})`
}

const uniq = (names: string[]) => [...new Set(names.map((n) => cleanText(n)).filter(Boolean))]

/** MAIN artist names; falls back to the singular `artist` when roles are missing. */
export function mainArtists(refs: TidalArtistRef[] | undefined, primary?: TidalArtistRef): string[] {
  const list = refs ?? []
  if (list.some((a) => a.type)) {
    const main = list.filter((a) => (a.type ?? '').toUpperCase() === 'MAIN').map((a) => a.name)
    if (main.length) return uniq(main)
  }
  if (primary?.name) return [cleanText(primary.name)]
  return uniq(list.slice(0, 1).map((a) => a.name))
}

export function featuredArtists(refs: TidalArtistRef[] | undefined, primary?: TidalArtistRef): string[] {
  const list = refs ?? []
  if (list.some((a) => a.type)) return uniq(list.filter((a) => (a.type ?? '').toUpperCase() === 'FEATURED').map((a) => a.name))
  const main = new Set(mainArtists(list, primary))
  return uniq(list.map((a) => a.name)).filter((n) => !main.has(n))
}

/** "A" + "MINOR" → "Am", "FSharp" + "MAJOR" → "F#". */
export function musicalKey(key?: string | null, scale?: string | null): string | undefined {
  const k = cleanText(key)
  if (!k || /^unknown$/i.test(k)) return undefined
  const m = /^([A-Ga-g])\s*(sharp|flat|#|b|♯|♭)?$/i.exec(k)
  if (!m) return undefined
  const acc = (m[2] ?? '').toLowerCase()
  const note = m[1].toUpperCase() + (acc === 'sharp' || acc === '#' || acc === '♯' ? '#' : acc === 'flat' || acc === 'b' || acc === '♭' ? 'b' : '')
  return /^minor$/i.test(cleanText(scale)) ? `${note}m` : note
}

export function artwork(cover: string | null | undefined): SourceArtwork | undefined {
  const origin = imageUrl(cover, 'origin')
  if (!origin) return undefined
  return { url: origin, fallbackUrls: [imageUrl(cover, 1280)!] }
}

export function isCompilation(album: TidalAlbum): boolean {
  const primary = album.artist?.name ?? mainArtists(album.artists)[0]
  return (album.type ?? '').toUpperCase() === 'COMPILATION' || isVariousArtists(primary)
}

const RELEASE_TYPES: Record<string, string> = { ALBUM: 'album', EP: 'ep', SINGLE: 'single', COMPILATION: 'compilation' }

export function mapAlbumTags(album: TidalAlbum, albumTracks: TidalTrack[] = []): TrackTags {
  const compilation = isCompilation(album)
  const artists = mainArtists(album.artists, album.artist)
  const va = compilation && (artists.length === 0 || artists.some(isVariousArtists))
  const albumartists = va ? [VARIOUS_ARTISTS] : artists
  const maxVolume = albumTracks.reduce((m, t) => Math.max(m, t.volumeNumber || 1), 0)
  const date = album.releaseDate || album.streamStartDate?.slice(0, 10) || undefined
  const tags: TrackTags = {
    album: fullTitle(album.title, album.version),
    albumartist: joinCredit(albumartists),
    albumartists,
    date: date || undefined,
    barcode: album.upc || undefined,
    copyright: cleanText(album.copyright) || undefined,
    compilation,
    totaldiscs: album.numberOfVolumes || maxVolume || undefined,
    releasetype: RELEASE_TYPES[(album.type ?? '').toUpperCase()],
    media: 'Digital Media',
    tidal_album_id: String(album.id),
    source: 'tidal',
  }
  return Object.fromEntries(Object.entries(tags).filter(([, v]) => v !== undefined && v !== '')) as TrackTags
}

export interface AudioFacts {
  lossless: boolean
  codec?: string
  bitDepth?: number
  sampleRate?: number
  bitrateKbps?: number
}

/** "lossless:16:44100" / "lossy:aac:320" from what TIDAL actually delivered. */
export function sourceQuality(info?: Pick<TidalPlaybackInfo, 'audioQuality' | 'bitDepth' | 'sampleRate'> | null, audio?: AudioFacts): string {
  const lossless = audio?.lossless ?? /LOSSLESS/i.test(info?.audioQuality ?? '')
  if (lossless) {
    return encodeSourceQuality({ lossless: true, bitDepth: audio?.bitDepth ?? info?.bitDepth ?? 16, sampleRate: audio?.sampleRate ?? info?.sampleRate ?? 44100 })
  }
  const kbps = audio?.bitrateKbps ?? ((info?.audioQuality ?? '').toUpperCase() === 'LOW' ? 96 : 320)
  return encodeSourceQuality({ lossless: false, codec: audio?.codec ?? 'aac', bitrate: kbps * 1000 })
}

export function lyricsText(l: TidalLyrics | null | undefined): string | undefined {
  return l?.subtitles?.trim() || l?.lyrics?.trim() || undefined
}

export interface TrackTagOptions {
  quality?: string
  lyrics?: TidalLyrics | null
}

/** Full tags for one track (album-level fields included, so the result stands alone). */
export function mapTrackTags(track: TidalTrack, album: TidalAlbum, albumTracks: TidalTrack[] = [], opts: TrackTagOptions = {}): TrackTags {
  const main = mainArtists(track.artists, track.artist)
  const feat = featuredArtists(track.artists, track.artist).filter((n) => !main.includes(n))
  const disc = track.volumeNumber || 1
  const onDisc = albumTracks.filter((t) => (t.volumeNumber || 1) === disc).length
  const singleDisc = (album.numberOfVolumes ?? 1) <= 1
  const bpm = Number(track.bpm)
  const tags: TrackTags = {
    ...mapAlbumTags(album, albumTracks),
    title: fullTitle(track.title, track.version),
    artist: joinCredit(main),
    artists: [...main, ...feat],
    tracknumber: track.trackNumber || undefined,
    discnumber: disc,
    totaltracks: onDisc || (singleDisc ? album.numberOfTracks : undefined) || undefined,
    isrc: track.isrc || undefined,
    copyright: cleanText(track.copyright) || cleanText(album.copyright) || undefined,
    bpm: bpm > 0 ? Math.round(bpm) : undefined,
    key: musicalKey(track.key, track.keyScale),
    explicit: typeof track.explicit === 'boolean' ? track.explicit : undefined,
    lyrics: lyricsText(opts.lyrics),
    tidal_track_id: String(track.id),
    source: 'tidal',
    source_quality: opts.quality,
  }
  return Object.fromEntries(Object.entries(tags).filter(([, v]) => v !== undefined && v !== '')) as TrackTags
}

export function releaseKeys(album: Pick<TidalAlbum, 'id' | 'upc'>, trackId?: string | number): string[] {
  const keys = [`tidal:album:${album.id}`]
  if (album.upc) keys.push(`upc:${album.upc}`)
  if (trackId != null) keys.push(`tidal:track:${trackId}`)
  return keys
}

export interface AcquiredTrack {
  track: TidalTrack
  file: string
  quality: string
  lyrics?: TidalLyrics | null
  playback?: Partial<TidalPlaybackInfo>
}

export interface SkippedTrack {
  id: string
  title: string
  reason: string
  message: string
}

export function mapRelease(args: {
  album: TidalAlbum
  albumTracks: TidalTrack[]
  acquired: AcquiredTrack[]
  skipped?: SkippedTrack[]
  /** Set for single-track jobs. */
  trackId?: string
}): SourceRelease {
  const { album, albumTracks, acquired } = args
  const albumTags = mapAlbumTags(album, albumTracks)
  const tracks: SourceTrack[] = acquired.map((a) => ({
    file: a.file,
    tags: mapTrackTags(a.track, album, albumTracks, { quality: a.quality, lyrics: a.lyrics }),
    durationMs: a.track.duration ? Math.round(a.track.duration * 1000) : undefined,
    raw: { track: a.track, playback: a.playback },
  }))
  const first = tracks[0]?.tags
  const title =
    args.trackId && first
      ? `TIDAL · ${first.artist} — ${first.title}`
      : `TIDAL · ${albumTags.albumartist ?? 'Unknown Artist'} — ${albumTags.album ?? 'Unknown Album'}`
  return {
    source: 'tidal',
    releaseKeys: releaseKeys(album, args.trackId),
    albumTags,
    tracks,
    artwork: artwork(album.cover),
    raw: { album, albumTracks, skipped: args.skipped ?? [] },
    title,
  }
}

export function toBadgeQueryTrack(t: TidalTrack, album?: Pick<TidalAlbum, 'title' | 'version' | 'artist' | 'artists'>): BadgeQueryTrack {
  const albumArtist = album ? joinCredit(mainArtists(album.artists, album.artist)) : undefined
  return {
    tidalTrackId: String(t.id),
    isrc: t.isrc || undefined,
    artist: joinCredit(mainArtists(t.artists, t.artist)) || undefined,
    albumArtist: albumArtist || undefined,
    title: fullTitle(t.title, t.version),
    album: album ? fullTitle(album.title, album.version) : t.album ? fullTitle(t.album.title, t.album.version) : undefined,
    durationMs: t.duration ? Math.round(t.duration * 1000) : undefined,
  }
}

export function toBadgeQueryAlbum(a: TidalAlbum, tracks?: TidalTrack[]): BadgeQueryAlbum {
  return {
    tidalAlbumId: String(a.id),
    upc: a.upc || undefined,
    albumArtist: mapAlbumTags(a).albumartist,
    title: fullTitle(a.title, a.version),
    trackCount: tracks?.length ?? a.numberOfTracks,
    tracks: tracks?.map((t) => toBadgeQueryTrack(t, a)),
  }
}
