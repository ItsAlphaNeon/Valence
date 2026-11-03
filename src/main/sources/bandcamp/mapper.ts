// Bandcamp tralbum + downloaded files → SourceRelease / TrackTags.

import { basename, extname } from 'node:path'
import type { SourceRelease, SourceTrack } from '@main/import/source-types'
import type { ProbeResult } from '@main/tags/read'
import { encodeSourceQuality } from '@shared/quality'
import type { TrackTags } from '@shared/types'
import type { ProbedFile } from './downloader'
import type { BcDigitalItem, BcTralbum } from './parse'

/** f4.bcbits.com image: size 0 = original upload, 10 = 1200px, 2 = 350px. */
export const artUrl = (artId: number, size: number): string => `https://f4.bcbits.com/img/a${artId}_${size}.jpg`

export const releaseKey = (type: 'album' | 'track', id: number): string => `bc:${type}:${id}`

export function sourceQuality(p: ProbeResult): string {
  const f = p.format
  return encodeSourceQuality({ lossless: f.lossless, codec: f.codec, bitrate: f.bitrate, sampleRate: f.sampleRate, bitDepth: f.bitDepth })
}

/** Minimal tralbum from the download page, used when the album page could not be read. */
export function tralbumFromDigital(d: BcDigitalItem): BcTralbum {
  return {
    id: d.tralbumId ?? d.itemId,
    itemType: d.tralbumType,
    title: d.title || 'Untitled',
    artist: d.artist || 'Unknown Artist',
    artId: d.artId,
    url: d.pageUrl,
    releaseDate: d.releaseDate,
    preorder: d.preorder,
    tracks: [],
    tags: [],
  }
}

export function albumTagsFor(t: BcTralbum, itemUrl?: string | null): TrackTags {
  const isTrack = t.itemType === 'track'
  const tags: TrackTags = {
    album: isTrack ? (t.albumTitle ?? t.title) : t.title,
    albumartist: t.artist,
    source: 'bandcamp',
    bandcamp_item_id: String(t.id),
  }
  const url = itemUrl || t.url
  if (url) tags.bandcamp_url = url
  if (t.releaseDate) tags.date = t.releaseDate
  if (t.label) tags.label = t.label
  if (t.upc) tags.barcode = t.upc
  if (!isTrack && t.tracks.length) tags.totaltracks = t.tracks.length
  if (isTrack && !t.albumTitle) tags.totaltracks = 1
  if (isTrack && t.albumTitle && t.albumTrackCount) tags.totaltracks = t.albumTrackCount
  return tags
}

const FILE_TITLE_RE = /^(?:.+ - .+ - )?\d{1,3}[\s.\-_]+(.+)$/

export interface MapInput {
  tralbum: BcTralbum
  files: ProbedFile[]
  extras?: string[]
  itemUrl?: string | null
  /** Cover image extracted from the zip; used only when Bandcamp gave no art id. */
  coverFile?: string
  raw?: Record<string, unknown>
}

export function mapRelease(input: MapInput): SourceRelease {
  const { tralbum: t, files } = input
  const album = albumTagsFor(t, input.itemUrl)
  if (!album.totaltracks && files.length) album.totaltracks = files.length
  const isTrack = t.itemType === 'track'
  const tracks: SourceTrack[] = files.map(({ file, probe, track }) => {
    const own = probe.tags
    const stem = basename(file, extname(file))
    const tags: TrackTags = {
      ...album,
      title: track?.title ?? own.title ?? FILE_TITLE_RE.exec(stem)?.[1] ?? stem,
      artist: track?.artist || t.artist,
      source_quality: sourceQuality(probe),
    }
    const no = isTrack && !t.albumTitle ? 1 : (track?.trackNum ?? own.tracknumber)
    if (no) tags.tracknumber = no
    if (track) tags.bandcamp_track_id = String(track.trackId)
    else if (isTrack) tags.bandcamp_track_id = String(t.id)
    if (own.discnumber) tags.discnumber = own.discnumber
    return { file, tags, durationMs: probe.format.durationMs || track?.durationMs || undefined, raw: track }
  })
  tracks.sort((a, b) => (a.tags.tracknumber ?? 1e9) - (b.tags.tracknumber ?? 1e9) || a.file.localeCompare(b.file))
  return {
    source: 'bandcamp',
    releaseKeys: [releaseKey(t.itemType, t.id), ...(t.upc ? [`upc:${t.upc}`] : [])],
    albumTags: album,
    tracks,
    artwork: t.artId ? { url: artUrl(t.artId, 0), fallbackUrls: [artUrl(t.artId, 10)] } : input.coverFile ? { file: input.coverFile } : undefined,
    extras: input.extras?.length ? input.extras : undefined,
    raw: { ...input.raw, tags: t.tags, tralbum: { ...t, tracks: undefined } },
    title: `Bandcamp · ${t.artist} — ${album.album}`,
  }
}
