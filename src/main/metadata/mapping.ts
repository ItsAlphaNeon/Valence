// MusicBrainz release JSON → flat track list, TrackTags and ReleaseCandidate.

import type { TrackTags } from '@shared/types'
import { cleanText } from '@shared/sanitize'
import { pickGenre } from './genre'
import { VA_ID, creditIds, creditNames, creditSort, creditString, type MbRelease } from './musicbrainz'

export interface ReleaseCandidate {
  releaseId: string
  releaseGroupId?: string
  title: string
  artist: string
  date?: string
  country?: string
  trackCount: number
  format?: string
  score: number
  status?: string
  type?: string
}

export interface FlatTrack {
  id: string
  recordingId?: string
  title: string
  credit: string
  names: string[]
  ids: string[]
  sort: string
  lengthMs?: number
  isrcs: string[]
  disc: number
  position: number
  /** 1-based position across the whole release. */
  abs: number
  mediumCount: number
  format?: string
}

export function flattenRelease(r: MbRelease): FlatTrack[] {
  const out: FlatTrack[] = []
  let abs = 0
  for (const m of r.media ?? []) {
    for (const t of m.tracks ?? m.track ?? []) {
      abs++
      const ac = t['artist-credit'] ?? t.recording?.['artist-credit'] ?? r['artist-credit']
      out.push({
        id: t.id,
        recordingId: t.recording?.id,
        title: cleanText(t.title ?? t.recording?.title),
        credit: creditString(ac),
        names: creditNames(ac),
        ids: creditIds(ac),
        sort: creditSort(ac),
        lengthMs: t.length ?? t.recording?.length ?? undefined,
        isrcs: t.recording?.isrcs ?? [],
        disc: m.position ?? 1,
        position: t.position ?? (Number(t.number) || abs),
        abs,
        mediumCount: m['track-count'] ?? (m.tracks?.length ?? 0),
        format: m.format ?? undefined,
      })
    }
  }
  return out
}

export const releaseTrackCount = (r: MbRelease): number =>
  r['track-count'] ?? (r.media ?? []).reduce((n, m) => n + (m['track-count'] ?? m.tracks?.length ?? 0), 0)

/** Picard-style medium summary: "2×CD", "CD + DVD", "Digital Media". */
export function formatSummary(r: MbRelease): string | undefined {
  const runs: Array<[string, number]> = []
  for (const m of r.media ?? []) {
    const f = m.format || '(unknown)'
    const last = runs[runs.length - 1]
    if (last && last[0] === f) last[1]++
    else runs.push([f, 1])
  }
  return runs.length ? runs.map(([f, n]) => (n > 1 ? `${n}×${f}` : f)).join(' + ') : undefined
}

export function releaseTypeLabel(r: MbRelease): string | undefined {
  const rg = r['release-group']
  if (!rg?.['primary-type'] && !rg?.['secondary-types']?.length) return undefined
  return [rg['primary-type'], ...(rg['secondary-types'] ?? [])].filter(Boolean).join(' + ')
}

export function toCandidate(r: MbRelease, score: number): ReleaseCandidate {
  return {
    releaseId: r.id,
    releaseGroupId: r['release-group']?.id,
    title: r.title,
    artist: creditString(r['artist-credit']),
    date: r.date || undefined,
    country: r.country ?? undefined,
    trackCount: releaseTrackCount(r),
    format: formatSummary(r),
    score: Math.round(score * 1000) / 1000,
    status: r.status ?? undefined,
    type: releaseTypeLabel(r),
  }
}

const uniq = (xs: Array<string | null | undefined>) => [...new Set(xs.map((x) => cleanText(x)).filter(Boolean))]

export function albumTagsFromRelease(r: MbRelease, existingGenre?: string): TrackTags {
  const ac = r['artist-credit']
  const rg = r['release-group']
  const formats = uniq((r.media ?? []).map((m) => m.format))
  const labels = uniq((r['label-info'] ?? []).map((l) => l.label?.name))
  const catnos = uniq((r['label-info'] ?? []).map((l) => l['catalog-number']))
  const types = [rg?.['primary-type'], ...(rg?.['secondary-types'] ?? [])].filter(Boolean).map((t) => t!.toLowerCase())
  const t: TrackTags = {
    musicbrainz_albumid: r.id,
    musicbrainz_releasegroupid: rg?.id,
    musicbrainz_albumartistid: creditIds(ac),
    album: cleanText(r.title),
    albumartist: creditString(ac),
    albumartists: creditNames(ac),
    albumartistsort: creditSort(ac),
    date: r.date || undefined,
    originaldate: rg?.['first-release-date'] || undefined,
    releasetype: types.length ? types.join('; ') : undefined,
    releasestatus: r.status?.toLowerCase() || undefined,
    releasecountry: r.country || undefined,
    label: labels.length ? labels.join('; ') : undefined,
    catalognumber: catnos.length ? catnos.join('; ') : undefined,
    barcode: r.barcode || undefined,
    media: formats.length === 1 ? formats[0] : formats.length ? formats.join(' + ') : undefined,
    totaldiscs: r.media?.length || undefined,
    genre: pickGenre([...(rg?.genres ?? []), ...(r.genres ?? [])], existingGenre),
  }
  if (creditIds(ac).includes(VA_ID)) t.compilation = true
  for (const k of Object.keys(t) as Array<keyof TrackTags>) {
    const v = t[k]
    if (v === undefined || (Array.isArray(v) && !v.length)) delete t[k]
  }
  return t
}

export function trackTagsFromRelease(ft: FlatTrack, inputIsrc?: string, albumMedia?: string): TrackTags {
  const isrc = inputIsrc && ft.isrcs.includes(inputIsrc.toUpperCase()) ? inputIsrc.toUpperCase() : ft.isrcs[0]
  const t: TrackTags = {
    musicbrainz_recordingid: ft.recordingId,
    musicbrainz_trackid: ft.id,
    musicbrainz_artistid: ft.ids,
    title: ft.title,
    artist: ft.credit,
    artists: ft.names,
    artistsort: ft.sort,
    tracknumber: ft.position,
    totaltracks: ft.mediumCount,
    discnumber: ft.disc,
    isrc,
  }
  if (ft.format && albumMedia && ft.format !== albumMedia) t.media = ft.format
  for (const k of Object.keys(t) as Array<keyof TrackTags>) {
    const v = t[k]
    if (v === undefined || v === '' || (Array.isArray(v) && !v.length)) delete t[k]
  }
  return t
}

const CAA = 'https://coverartarchive.org'

export function coverArtUrls(r: MbRelease): string[] {
  const out: string[] = []
  if (r['cover-art-archive']?.front !== false) out.push(`${CAA}/release/${r.id}/front`)
  if (r['release-group']?.id) out.push(`${CAA}/release-group/${r['release-group'].id}/front`)
  return out
}
