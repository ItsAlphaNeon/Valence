// Tag + stream reader (music-metadata). Standard fields come from `common`; Valence/source custom
// fields are pulled from the native tag lists so they round-trip exactly as written.

import { parseFile, type IAudioMetadata } from 'music-metadata'

type INativeTags = IAudioMetadata['native']
import type { AudioFormat, TrackTags } from '@shared/types'
import { CUSTOM_FIELDS, RG_FIELDS, parseGain, popmToStars, stringToMulti } from '@shared/tag-schema'
import { cleanText } from '@shared/sanitize'

export interface ProbeResult {
  tags: TrackTags
  format: AudioFormat
  picture: { data: Buffer; mime: string } | null
  tagTypes: string[]
}

export const AUDIO_EXTENSIONS = new Set([
  'mp3', 'flac', 'm4a', 'mp4', 'aac', 'alac', 'ogg', 'oga', 'opus', 'wav', 'aif', 'aiff', 'aifc',
  'wma', 'ape', 'wv', 'tta', 'mpc', 'mp2', 'ac3', 'dsf', 'dff', 'webm', 'mka',
])

export function isAudioPath(path: string): boolean {
  const ext = path.toLowerCase().split('.').pop() ?? ''
  return AUDIO_EXTENSIONS.has(ext)
}

/** Short, stable codec identifier. */
export function codecId(codec: string | undefined, container: string | undefined): string {
  const c = (codec ?? '').toLowerCase()
  if (c.includes('layer 3') || c === 'mp3') return 'mp3'
  if (c.includes('layer 2')) return 'mp2'
  if (c.includes('flac')) return 'flac'
  if (c.includes('alac')) return 'alac'
  if (c.includes('aac') || c.includes('mp4a')) return 'aac'
  if (c.includes('opus')) return 'opus'
  if (c.includes('vorbis')) return 'vorbis'
  if (c.includes('pcm') || c.includes('lpcm')) return 'pcm'
  if (c.includes('wma') || c.includes('windows media')) return 'wma'
  if (c.includes('monkey') || c.includes('ape')) return 'ape'
  if (c.includes('wavpack')) return 'wavpack'
  if (c.includes('musepack')) return 'mpc'
  if (c.includes('dsd')) return 'dsd'
  if (c.includes('ac-3') || c.includes('ac3')) return 'ac3'
  return c || (container ?? 'unknown').toLowerCase()
}

const LOSSLESS_CODECS = new Set(['flac', 'alac', 'pcm', 'ape', 'wavpack', 'dsd', 'tta'])

function first<T>(v: T | T[] | undefined | null): T | undefined {
  if (v === undefined || v === null) return undefined
  return Array.isArray(v) ? v[0] : v
}

function nativeValue(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined
  if (typeof v === 'string') return v
  if (typeof v === 'number') return String(v)
  if (Array.isArray(v)) return v.map(nativeValue).filter(Boolean).join('; ') || undefined
  if (typeof v === 'object' && 'text' in (v as object)) return String((v as { text: unknown }).text)
  return undefined
}

/** Collects custom (TXXX / Vorbis / iTunes freeform) fields into an upper-cased map. */
function customMap(native: INativeTags): Map<string, string[]> {
  const out = new Map<string, string[]>()
  const push = (k: string, v: string | undefined) => {
    if (v === undefined || v === '') return
    const key = k.toUpperCase()
    out.set(key, [...(out.get(key) ?? []), v])
  }
  for (const [type, list] of Object.entries(native)) {
    for (const { id, value } of list as Array<{ id: string; value: unknown }>) {
      if (type.startsWith('ID3v2')) {
        if (id.startsWith('TXXX:')) push(id.slice(5), nativeValue(value))
        else if (id === 'POPM' && value && typeof value === 'object') {
          const p = value as { email?: string; rating?: number }
          push(`POPM:${p.email ?? ''}`, p.rating !== undefined ? String(p.rating) : undefined)
        } else if (id === 'USLT') push('RAWLYRICS', nativeValue(value))
        else if (id === 'TDOR' || id === 'TORY') push('ORIGINALDATE', nativeValue(value))
        else if (id === 'TYER' || id === 'TDRC') push('ID3DATE', nativeValue(value))
        else if (id === 'TDAT') push('ID3TDAT', nativeValue(value))
      } else if (type === 'vorbis') {
        push(id, nativeValue(value))
        if (/^(UNSYNCED)?LYRICS$/i.test(id)) push('RAWLYRICS', nativeValue(value))
      }
      else if (type === 'iTunes') {
        if (id.startsWith('----:')) push(id.split(':').slice(2).join(':'), nativeValue(value))
        else if (id === '©lyr') push('RAWLYRICS', nativeValue(value))
      }
    }
  }
  return out
}

function parseDate(meta: IAudioMetadata, custom: Map<string, string[]>): string | undefined {
  const c = meta.common
  // ID3v2.3: TYER (YYYY) + TDAT (DDMM)
  const tyer = custom.get('ID3DATE')?.[0]
  const tdat = custom.get('ID3TDAT')?.[0]
  if (tyer && /^\d{4}$/.test(tyer) && tdat && /^\d{4}$/.test(tdat)) return `${tyer}-${tdat.slice(2)}-${tdat.slice(0, 2)}`
  if (c.date) return c.date.slice(0, 10)
  if (c.year) return String(c.year)
  return undefined
}

function mapTags(meta: IAudioMetadata): TrackTags {
  const c = meta.common
  const custom = customMap(meta.native)
  const cv = (k: string) => custom.get(k.toUpperCase())?.[0]
  const t: TrackTags = {}
  const set = <K extends keyof TrackTags>(k: K, v: TrackTags[K] | undefined | null) => {
    if (v === undefined || v === null || v === '' || (typeof v === 'number' && !Number.isFinite(v))) return
    t[k] = typeof v === 'string' ? (cleanText(v) as TrackTags[K]) : v
  }
  set('title', c.title)
  set('artist', c.artist)
  const artists = stringToMulti(custom.get('ARTISTS') ?? c.artists)
  if (artists && (artists.length > 1 || artists[0] !== c.artist)) t.artists = artists
  set('album', c.album)
  set('albumartist', c.albumartist)
  set('artistsort', c.artistsort)
  set('albumartistsort', c.albumartistsort)
  set('titlesort', c.titlesort)
  set('albumsort', c.albumsort)
  set('tracknumber', c.track?.no ?? undefined)
  set('totaltracks', c.track?.of ?? undefined)
  set('discnumber', c.disk?.no ?? undefined)
  set('totaldiscs', c.disk?.of ?? undefined)
  set('date', parseDate(meta, custom))
  set('originaldate', c.originaldate ?? cv('ORIGINALDATE') ?? (c.originalyear ? String(c.originalyear) : undefined))
  set('genre', first(c.genre))
  if (c.compilation) t.compilation = true
  set('isrc', first(c.isrc))
  set('barcode', c.barcode ?? cv('BARCODE'))
  set('label', first(c.label))
  set('catalognumber', first(c.catalognumber) ?? cv('CATALOGNUMBER'))
  set('copyright', c.copyright)
  set('bpm', c.bpm)
  set('key', c.key)
  const comment = first(c.comment)
  set('comment', typeof comment === 'string' ? comment : comment?.text)
  set('media', c.media)
  set('musicbrainz_recordingid', c.musicbrainz_recordingid)
  set('musicbrainz_trackid', c.musicbrainz_trackid ?? cv('MusicBrainz Release Track Id') ?? cv('MUSICBRAINZ_RELEASETRACKID'))
  set('musicbrainz_albumid', c.musicbrainz_albumid)
  set('musicbrainz_releasegroupid', c.musicbrainz_releasegroupid)
  if (c.musicbrainz_artistid?.length) t.musicbrainz_artistid = stringToMulti(c.musicbrainz_artistid)
  if (c.musicbrainz_albumartistid?.length) t.musicbrainz_albumartistid = stringToMulti(c.musicbrainz_albumartistid)
  set('releasetype', first(c.releasetype))
  set('releasestatus', c.releasestatus)
  set('releasecountry', c.releasecountry)
  set('acoustid_id', c.acoustid_id)

  for (const [key, name] of RG_FIELDS) {
    const raw = cv(name)
    let v = parseGain(raw)
    if (v === undefined) {
      const ratio = c[key as 'replaygain_track_gain']
      if (ratio && typeof ratio === 'object') v = key.endsWith('peak') ? ratio.ratio : ratio.dB
    }
    if (v !== undefined && Number.isFinite(v)) (t as Record<string, unknown>)[key] = v
  }

  // Raw lyric text keeps LRC timestamps (music-metadata strips them from common.lyrics).
  const lyr = c.lyrics?.[0]
  const text = custom.get('RAWLYRICS')?.[0] ?? lyr?.text ?? (lyr?.syncText?.length ? lyr.syncText.map((l) => l.text).join('\n') : undefined)
  if (text?.trim()) t.lyrics = text.replace(/\r\n/g, '\n')

  // Rating: prefer our POPM owner, then any POPM, then RATING (0..100) fields.
  const popm = custom.get(`POPM:WINDOWS MEDIA PLAYER 9 SERIES`)?.[0] ?? [...custom.entries()].find(([k]) => k.startsWith('POPM:'))?.[1][0]
  if (popm !== undefined) {
    const stars = popmToStars(Number(popm))
    if (stars) t.rating = stars
  } else {
    const r = Number(cv('RATING'))
    if (r > 0) t.rating = r <= 5 ? Math.round(r) : Math.max(1, Math.min(5, Math.round(r / 20)))
  }
  const adv = cv('ITUNESADVISORY')
  if (adv === '1') t.explicit = true

  for (const [key, id3, vorbis, mp4] of CUSTOM_FIELDS) {
    if (t[key] !== undefined) continue
    const v = cv(id3) ?? cv(vorbis) ?? cv(mp4)
    if (v === undefined) continue
    if (key === 'musicbrainz_artistid' || key === 'musicbrainz_albumartistid' || key === 'artists') {
      ;(t as Record<string, unknown>)[key] = stringToMulti(v)
    } else (t as Record<string, unknown>)[key] = v
  }
  return t
}

function mapFormat(meta: IAudioMetadata): AudioFormat {
  const f = meta.format
  const codec = codecId(f.codec, f.container)
  const lossless = f.lossless ?? LOSSLESS_CODECS.has(codec)
  return {
    container: (f.container ?? '').toLowerCase(),
    codec,
    lossless: !!lossless || LOSSLESS_CODECS.has(codec),
    bitrate: Math.round(f.bitrate ?? 0),
    sampleRate: f.sampleRate ?? 0,
    bitDepth: f.bitsPerSample ?? 0,
    channels: f.numberOfChannels ?? 2,
    durationMs: Math.round((f.duration ?? 0) * 1000),
  }
}

export async function probeFile(path: string, opts: { covers?: boolean; duration?: boolean } = {}): Promise<ProbeResult> {
  const meta = await parseFile(path, { duration: opts.duration ?? false, skipCovers: !(opts.covers ?? true) })
  const pic = meta.common.picture?.find((p) => /front/i.test(p.type ?? '')) ?? meta.common.picture?.[0]
  return {
    tags: mapTags(meta),
    format: mapFormat(meta),
    picture: pic ? { data: Buffer.from(pic.data), mime: pic.format?.includes('/') ? pic.format : `image/${pic.format || 'jpeg'}` } : null,
    tagTypes: meta.format.tagTypes ?? [],
  }
}
