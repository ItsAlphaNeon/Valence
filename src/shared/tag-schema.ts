// Picard-compatible tag naming. See https://picard-docs.musicbrainz.org/en/appendices/tag_mapping.html

import type { TrackTags } from './types'

/** POPM owner used by Windows Explorer / WMP / MusicBee and read by most Android players. */
export const POPM_EMAIL = 'Windows Media Player 9 Series'

const STAR_TO_POPM = [0, 1, 64, 128, 196, 255]

export function starsToPopm(stars: number): number {
  return STAR_TO_POPM[Math.max(0, Math.min(5, Math.round(stars)))]
}

export function popmToStars(v: number): number {
  if (!v) return 0
  if (v < 32) return 1
  if (v < 96) return 2
  if (v < 160) return 3
  if (v < 224) return 4
  return 5
}

export function formatGain(db: number): string {
  return `${db >= 0 ? '+' : ''}${db.toFixed(2)} dB`
}

export function formatPeak(p: number): string {
  return p.toFixed(6)
}

export function parseGain(s: string | undefined | null): number | undefined {
  if (!s) return undefined
  const n = parseFloat(String(s).replace(',', '.'))
  return Number.isFinite(n) ? n : undefined
}

const LRC_LINE = /^\s*\[\d{1,3}:\d{2}(?:[.:]\d{1,3})?\]/m

export function isSyncedLyrics(text: string | undefined | null): boolean {
  return !!text && LRC_LINE.test(text)
}

/** Separator for multi-valued text in single-value containers (ID3v2.3 TXXX, display strings). */
export const MULTI_SEP = '; '

/** Custom fields: [TrackTags key, ID3 TXXX description, Vorbis key, MP4 freeform name]. */
export const CUSTOM_FIELDS: Array<[keyof TrackTags, string, string, string]> = [
  ['artists', 'ARTISTS', 'ARTISTS', 'ARTISTS'],
  ['catalognumber', 'CATALOGNUMBER', 'CATALOGNUMBER', 'CATALOGNUMBER'],
  ['barcode', 'BARCODE', 'BARCODE', 'BARCODE'],
  ['musicbrainz_trackid', 'MusicBrainz Release Track Id', 'MUSICBRAINZ_RELEASETRACKID', 'MusicBrainz Release Track Id'],
  ['musicbrainz_albumid', 'MusicBrainz Album Id', 'MUSICBRAINZ_ALBUMID', 'MusicBrainz Album Id'],
  ['musicbrainz_releasegroupid', 'MusicBrainz Release Group Id', 'MUSICBRAINZ_RELEASEGROUPID', 'MusicBrainz Release Group Id'],
  ['musicbrainz_artistid', 'MusicBrainz Artist Id', 'MUSICBRAINZ_ARTISTID', 'MusicBrainz Artist Id'],
  ['musicbrainz_albumartistid', 'MusicBrainz Album Artist Id', 'MUSICBRAINZ_ALBUMARTISTID', 'MusicBrainz Album Artist Id'],
  ['releasetype', 'MusicBrainz Album Type', 'RELEASETYPE', 'MusicBrainz Album Type'],
  ['releasestatus', 'MusicBrainz Album Status', 'RELEASESTATUS', 'MusicBrainz Album Status'],
  ['releasecountry', 'MusicBrainz Album Release Country', 'RELEASECOUNTRY', 'MusicBrainz Album Release Country'],
  ['acoustid_id', 'Acoustid Id', 'ACOUSTID_ID', 'Acoustid Id'],
  ['originaldate', 'ORIGINALDATE', 'ORIGINALDATE', 'ORIGINALDATE'],
  ['valence_id', 'VALENCE_ID', 'VALENCE_ID', 'VALENCE_ID'],
  ['tidal_track_id', 'TIDAL_TRACK_ID', 'TIDAL_TRACK_ID', 'TIDAL_TRACK_ID'],
  ['tidal_album_id', 'TIDAL_ALBUM_ID', 'TIDAL_ALBUM_ID', 'TIDAL_ALBUM_ID'],
  ['bandcamp_item_id', 'BANDCAMP_ITEM_ID', 'BANDCAMP_ITEM_ID', 'BANDCAMP_ITEM_ID'],
  ['bandcamp_url', 'BANDCAMP_URL', 'BANDCAMP_URL', 'BANDCAMP_URL'],
  ['source', 'VALENCE_SOURCE', 'VALENCE_SOURCE', 'VALENCE_SOURCE'],
  ['source_quality', 'VALENCE_SOURCE_QUALITY', 'VALENCE_SOURCE_QUALITY', 'VALENCE_SOURCE_QUALITY'],
]

/** ReplayGain uses Picard/foobar naming everywhere (TXXX in ID3, Vorbis keys, MP4 freeform). */
export const RG_FIELDS: Array<[keyof TrackTags, string]> = [
  ['replaygain_track_gain', 'REPLAYGAIN_TRACK_GAIN'],
  ['replaygain_track_peak', 'REPLAYGAIN_TRACK_PEAK'],
  ['replaygain_album_gain', 'REPLAYGAIN_ALBUM_GAIN'],
  ['replaygain_album_peak', 'REPLAYGAIN_ALBUM_PEAK'],
]

export function multiToString(v: string[] | undefined): string | undefined {
  return v && v.length ? v.join(MULTI_SEP) : undefined
}

export function stringToMulti(v: string | string[] | undefined | null): string[] | undefined {
  if (v == null) return undefined
  const arr = (Array.isArray(v) ? v : [v]).flatMap((s) => String(s).split(/\s*;\s*|\s*\/\s*(?=[0-9a-f]{8}-)/i))
  const out = arr.map((s) => s.trim()).filter(Boolean)
  return out.length ? out : undefined
}
