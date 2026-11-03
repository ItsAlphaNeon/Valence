// Release / track scoring (Picard-like weighted similarity) and AUTO/REVIEW/UNMATCHED thresholds.

import type { SourceKind, TrackTags } from '@shared/types'
import { isVariousArtists } from '@shared/artist-credit'
import { matchKey } from '@shared/sanitize'
import { cleanTitle } from './heuristics'
import { flattenRelease, releaseTrackCount, type FlatTrack } from './mapping'
import { VA_ID, creditIds, creditNames, creditString, type MbRelease } from './musicbrainz'
import { albumSim, artistSim, assign, durSim, mostCommon, normBarcode, titleSim, yearOf } from './util'

export interface QueryTrack {
  index: number
  tags: TrackTags
  durationMs: number
  /** Recording ids AcoustID matched for this file. */
  acoustid?: string[]
}

export interface Query {
  source: SourceKind
  /** Effective per-track tags (album tags underneath track tags). */
  tracks: QueryTrack[]
  album?: string
  albumartist?: string
  year?: number
  barcode?: string
  catno?: string
  mbAlbumIds: string[]
  media?: string
  country?: string
  compilation: boolean
  genre?: string
  totaltracks?: number
  totaldiscs?: number
}

export function buildQuery(input: { source: SourceKind; albumTags: TrackTags; tracks: Array<{ index: number; tags: TrackTags; durationMs: number }> }): Query {
  const a = input.albumTags ?? {}
  const tracks = input.tracks.map((t) => ({ index: t.index, durationMs: t.durationMs, tags: { ...stripUndef(a), ...stripUndef(t.tags) } }))
  const common = <K extends keyof TrackTags>(k: K) => (a[k] as TrackTags[K]) ?? mostCommon(tracks.map((t) => t.tags[k]), (v) => matchKey(String(v)) || String(v))
  const albumartist = common('albumartist') ?? common('artist')
  const ids = [a.musicbrainz_albumid, ...tracks.map((t) => t.tags.musicbrainz_albumid)].filter(Boolean) as string[]
  return {
    source: input.source,
    tracks,
    album: common('album'),
    albumartist,
    year: yearOf(common('date')) ?? yearOf(common('originaldate')),
    barcode: common('barcode'),
    catno: common('catalognumber'),
    mbAlbumIds: [...new Set(ids)],
    media: common('media'),
    country: common('releasecountry'),
    compilation: !!common('compilation') || isVariousArtists(albumartist),
    genre: common('genre'),
    totaltracks: common('totaltracks'),
    totaldiscs: common('totaldiscs'),
  }
}

function stripUndef(t: TrackTags | undefined): TrackTags {
  const out: TrackTags = {}
  for (const [k, v] of Object.entries(t ?? {})) if (v !== undefined && v !== null && v !== '') (out as Record<string, unknown>)[k] = v
  return out
}

// ---------- track similarity ----------

export function posSim(tags: TrackTags, ft: FlatTrack): number {
  const tn = tags.tracknumber
  if (!tn) return 0.5
  const dn = tags.discnumber
  if (tn === ft.position) return dn === undefined ? (ft.disc === 1 ? 1 : 0.7) : dn === ft.disc ? 1 : 0.3
  if (tn === ft.abs) return 0.8
  return 0
}

export function idMatch(tags: TrackTags, ft: FlatTrack): boolean {
  if (tags.musicbrainz_recordingid && tags.musicbrainz_recordingid === ft.recordingId) return true
  if (tags.musicbrainz_trackid && tags.musicbrainz_trackid === ft.id) return true
  return !!tags.isrc && ft.isrcs.includes(tags.isrc.toUpperCase())
}

/** 0.45·title + 0.25·duration + 0.15·artist + 0.15·position; ≥ 0.95 on ISRC / recording id match. */
export function trackSim(t: QueryTrack, ft: FlatTrack): number {
  const title = t.tags.title ? titleSim(cleanTitle(t.tags.title).title, ft.title) : 0
  const dur = durSim(t.durationMs, ft.lengthMs)
  const art = t.tags.artist ? artistSim(t.tags.artist, ft.credit, t.tags.artists, ft.names) : 0.5
  const s = 0.45 * title + 0.25 * dur + 0.15 * art + 0.15 * posSim(t.tags, ft)
  return idMatch(t.tags, ft) || (!!ft.recordingId && !!t.acoustid?.includes(ft.recordingId)) ? Math.max(s, 0.95) : s
}

// ---------- release score ----------

export interface Assigned { j: number; sim: number }

export interface Scored {
  release: MbRelease
  flat: FlatTrack[]
  S: number
  sTracks: number
  parts: { tracks: number; album: number; albumartist: number; count: number; year: number; ids: number; pref: number }
  /** Per query track (same order as Query.tracks): matched flat track or null. */
  assignment: Array<Assigned | null>
  goodFrac: number
  maxDeltaMs: number
}

export const ASSIGN_FLOOR = 0.5

export function statusPref(status: string | null | undefined): number {
  const s = (status ?? '').toLowerCase()
  return s === 'official' ? 1 : s === 'promotion' ? 0.6 : s === 'bootleg' ? 0.2 : s ? 0.3 : 0.5
}

export function formatPref(formats: Array<string | null | undefined>, wanted?: string): number {
  const fs = formats.filter(Boolean) as string[]
  if (!fs.length) return 0.5
  if (wanted && fs.some((f) => matchKey(f).includes(matchKey(wanted)))) return 1
  const one = (f: string) => (/digital/i.test(f) ? 1 : /\bcd\b|cd-?r|hdcd|sacd|shm/i.test(f) ? 0.8 : /vinyl|"/i.test(f) ? 0.5 : /cassette/i.test(f) ? 0.3 : 0.4)
  // a media tag that disagrees is evidence against this edition
  return Math.min(...fs.map(one)) * (wanted ? 0.5 : 1)
}

export function countryPref(country: string | null | undefined, wanted?: string): number {
  if (!country) return 0.5
  if (wanted && country === wanted) return 1
  return (country === 'XW' ? 1 : country === 'US' ? 0.9 : 0.6) * (wanted ? 0.5 : 1)
}

/** Official > Promo > Bootleg; Digital Media > CD > Vinyl; XW/US preferred. */
export function releasePref(r: MbRelease, q?: Pick<Query, 'media' | 'country'>): number {
  return 0.5 * statusPref(r.status) + 0.3 * formatPref((r.media ?? []).map((m) => m.format), q?.media) + 0.2 * countryPref(r.country, q?.country)
}

export function albumArtistSim(q: Query, r: MbRelease): number {
  const ac = r['artist-credit']
  const relVA = creditIds(ac).includes(VA_ID)
  if (!q.albumartist) return 0.5
  if (isVariousArtists(q.albumartist)) return relVA ? 1 : 0.3
  if (relVA) return q.compilation ? 0.8 : 0.3
  return artistSim(q.albumartist, creditString(ac), undefined, creditNames(ac))
}

export function countScore(q: Query, total: number, media?: MbRelease['media']): number {
  const n = q.tracks.length
  if (n === total || (q.totaltracks && q.totaltracks === total)) return 1
  if (q.totaltracks && media?.length && media.length === (q.totaldiscs ?? 1) && media[0]['track-count'] === q.totaltracks) return 1
  return total > n ? 0.7 : 0.3
}

export function yearScore(q: Query, r: MbRelease): number {
  const ry = yearOf(r.date)
  if (!q.year || !ry) return 0.5
  if (q.year === ry) return 1
  if (q.year === yearOf(r['release-group']?.['first-release-date'])) return 0.8
  return Math.abs(q.year - ry) === 1 ? 0.5 : 0
}

function idsScore(q: Query, r: MbRelease, flat: FlatTrack[]): number {
  const parts: number[] = []
  if (q.mbAlbumIds.length) parts.push(q.mbAlbumIds.includes(r.id) ? 1 : 0)
  if (q.barcode && r.barcode) parts.push(normBarcode(q.barcode) === normBarcode(r.barcode) ? 1 : 0)
  if (q.catno) {
    const cats = (r['label-info'] ?? []).map((l) => matchKey(l['catalog-number'])).filter(Boolean)
    if (cats.length) parts.push(cats.includes(matchKey(q.catno)) ? 1 : 0)
  }
  const relIsrcs = new Set(flat.flatMap((f) => f.isrcs))
  const isrcs = q.tracks.map((t) => t.tags.isrc?.toUpperCase()).filter(Boolean) as string[]
  if (isrcs.length && relIsrcs.size) parts.push(isrcs.filter((i) => relIsrcs.has(i)).length / isrcs.length)
  const relRecs = new Set(flat.map((f) => f.recordingId))
  const recs = q.tracks.map((t) => t.tags.musicbrainz_recordingid).filter(Boolean) as string[]
  if (recs.length) parts.push(recs.filter((x) => relRecs.has(x)).length / recs.length)
  const fps = q.tracks.filter((t) => t.acoustid?.length)
  if (fps.length) parts.push(fps.filter((t) => t.acoustid!.some((x) => relRecs.has(x))).length / fps.length)
  return parts.length ? Math.max(...parts) : 0.5
}

/** S = 0.30·tracks + 0.20·album + 0.15·albumartist + 0.10·count + 0.05·year + 0.10·ids + 0.10·pref */
export const WEIGHTS = { tracks: 0.3, album: 0.2, albumartist: 0.15, count: 0.1, year: 0.05, ids: 0.1, pref: 0.1 }

export function scoreRelease(q: Query, r: MbRelease): Scored {
  const flat = flattenRelease(r)
  const sim = q.tracks.map((t) => flat.map((ft) => trackSim(t, ft)))
  const cols = assign(sim)
  const assignment = cols.map((j, i) => (j >= 0 && sim[i][j] >= ASSIGN_FLOOR ? { j, sim: sim[i][j] } : null))
  const n = Math.max(1, q.tracks.length)
  const sTracks = assignment.reduce((s, a) => s + (a?.sim ?? 0), 0) / n
  let good = 0
  let maxDeltaMs = 0
  assignment.forEach((a, i) => {
    if (!a) return
    if (a.sim >= 0.6) good++
    const len = flat[a.j].lengthMs
    const d = q.tracks[i].durationMs
    if (len && d) maxDeltaMs = Math.max(maxDeltaMs, Math.abs(len - d))
  })
  const parts = {
    tracks: sTracks,
    album: q.album ? albumSim(q.album, r.title, r.disambiguation) : 0.5,
    albumartist: albumArtistSim(q, r),
    count: countScore(q, flat.length || releaseTrackCount(r), r.media),
    year: yearScore(q, r),
    ids: idsScore(q, r, flat),
    pref: releasePref(r, q),
  }
  // Tags without any album / album artist text (fingerprint- or id-only candidates) drop those weights instead of scoring them 0.5.
  let num = 0
  let den = 0
  for (const k of Object.keys(WEIGHTS) as Array<keyof typeof WEIGHTS>) {
    if ((k === 'album' && !q.album) || (k === 'albumartist' && !q.albumartist)) continue
    num += WEIGHTS[k] * parts[k]
    den += WEIGHTS[k]
  }
  const S = num / den
  return { release: r, flat, S, sTracks, parts, assignment, goodFrac: good / n, maxDeltaMs }
}

export const THRESHOLDS = { auto: 0.82, review: 0.6, autoTracks: 0.75, goodFrac: 0.8, goodSim: 0.6, maxDeltaMs: 7000 }

export function classify(s: Pick<Scored, 'S' | 'sTracks' | 'goodFrac' | 'maxDeltaMs'>): 'auto' | 'review' | 'unmatched' {
  const T = THRESHOLDS
  if (s.S >= T.auto && s.sTracks >= T.autoTracks && s.goodFrac >= T.goodFrac && s.maxDeltaMs <= T.maxDeltaMs) return 'auto'
  return s.S >= T.review ? 'review' : 'unmatched'
}

/** Cheap ranking of a search/ISRC summary (no track list) before fetching it in full. */
export function preScore(q: Query, r: MbRelease, hint = 0): number {
  const total = releaseTrackCount(r)
  return (
    0.15 * ((r.score ?? 100) / 100) +
    0.25 * (q.album ? albumSim(q.album, r.title, r.disambiguation) : 0.5) +
    0.15 * albumArtistSim(q, r) +
    0.2 * (total ? countScore(q, total, r.media) : 0.5) +
    0.05 * yearScore(q, r) +
    0.1 * releasePref(r, q) +
    0.1 * (q.barcode && r.barcode && normBarcode(q.barcode) === normBarcode(r.barcode) ? 1 : 0) +
    0.3 * hint
  )
}
