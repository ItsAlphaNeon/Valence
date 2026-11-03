// Release identification: MBIDs → barcode → ISRC intersection → AcoustID → text search, then score.

import type { SourceKind, TrackTags } from '@shared/types'
import type { Logger } from '../context'
import type { AcoustidMatch, Fingerprint } from './acoustid'
import { cleanTitle } from './heuristics'
import { albumTagsFromRelease, coverArtUrls, releaseTrackCount, toCandidate, trackTagsFromRelease, type ReleaseCandidate } from './mapping'
import { VA_ID, creditIds, creditNames, creditString, type MbClient, type MbRecording, type MbRelease } from './musicbrainz'
import { buildQuery, classify, preScore, releasePref, scoreRelease, trackSim, type Query, type Scored } from './scoring'
import { albumSim, artistSim, durSim, stripEdition, stripFeat, titleSim } from './util'

export interface IdentifyTrackInput {
  index: number
  tags: TrackTags
  durationMs: number
  relPath?: string
  /** Absolute path, used for fpcalc when AcoustID is enabled. */
  file?: string
  /** Precomputed Chromaprint fingerprint (skips fpcalc). */
  fingerprint?: Fingerprint
}

export interface IdentifyInput { source: SourceKind; albumTags: TrackTags; tracks: IdentifyTrackInput[] }

export interface IdentifyResult {
  status: 'auto' | 'review' | 'unmatched'
  score: number
  release?: ReleaseCandidate
  candidates: ReleaseCandidate[]
  albumTags: TrackTags
  trackTags: Array<TrackTags | null>
  coverArtUrls: string[]
}

export interface IdentifyDeps {
  mb: MbClient
  /** Null when AcoustID is disabled (no API key). */
  acoustid: ((fp: Fingerprint, signal?: AbortSignal) => Promise<AcoustidMatch[]>) | null
  fingerprint: (file: string) => Promise<Fingerprint | null>
  log?: Logger
}

export const MAX_FULL_FETCH = 8
const SINGLE_ACOUSTID_ACCEPT = 0.85

async function safe<T>(deps: IdentifyDeps, what: string, fn: () => Promise<T>, fallback: T, signal?: AbortSignal): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    if (signal?.aborted) throw err
    deps.log?.warn(`metadata: ${what} failed`, String(err))
    return fallback
  }
}

/** trackTags[i] ↔ the input track with index i when indices are 0..n-1, else input order. */
function slotOf(input: IdentifyInput): (k: number) => number {
  const n = input.tracks.length
  const idx = input.tracks.map((t) => t.index)
  const ok = new Set(idx).size === n && idx.every((i) => Number.isInteger(i) && i >= 0 && i < n)
  return ok ? (k) => idx[k] : (k) => k
}

export function unmatched(input: IdentifyInput, candidates: ReleaseCandidate[] = []): IdentifyResult {
  return { status: 'unmatched', score: candidates[0]?.score ?? 0, candidates, albumTags: {}, trackTags: input.tracks.map(() => null), coverArtUrls: [] }
}

export function buildResult(status: IdentifyResult['status'], s: Scored, q: Query, input: IdentifyInput, candidates: ReleaseCandidate[], score = s.S): IdentifyResult {
  if (status === 'unmatched') return unmatched(input, candidates)
  const albumTags = albumTagsFromRelease(s.release, q.genre)
  const slot = slotOf(input)
  const trackTags: Array<TrackTags | null> = input.tracks.map(() => null)
  q.tracks.forEach((t, k) => {
    const a = s.assignment[k]
    if (a) trackTags[slot(k)] = trackTagsFromRelease(s.flat[a.j], t.tags.isrc, albumTags.media)
  })
  const release = toCandidate(s.release, score)
  const cands = [release, ...candidates.filter((c) => c.releaseId !== release.releaseId)].slice(0, 5)
  return { status, score: Math.round(score * 1000) / 1000, release, candidates: cands, albumTags, trackTags, coverArtUrls: coverArtUrls(s.release) }
}

// ---------- album flow ----------

class Pool {
  readonly scored = new Map<string, Scored>()
  readonly tried = new Set<string>()
  constructor(private deps: IdentifyDeps, private q: Query, private signal?: AbortSignal) {}
  get full() { return this.tried.size >= MAX_FULL_FETCH }
  async add(id: string): Promise<Scored | undefined> {
    if (this.tried.has(id) || this.full) return this.scored.get(id)
    this.tried.add(id)
    const r = await safe(this.deps, `release ${id}`, () => this.deps.mb.release(id, this.signal), null, this.signal)
    if (!r?.media) return undefined
    const s = scoreRelease(this.q, r)
    this.scored.set(id, s)
    return s
  }
  ranked(): Scored[] {
    return [...this.scored.values()].sort((a, b) => b.S - a.S || releasePref(b.release, this.q) - releasePref(a.release, this.q))
  }
  confident(min = 0.9): boolean {
    const b = this.ranked()[0]
    return !!b && b.S >= min && classify(b) === 'auto'
  }
}

function finishAlbum(pool: Pool, q: Query, input: IdentifyInput): IdentifyResult {
  const all = pool.ranked()
  const best = all[0]
  const cands = all.slice(0, 5).map((s) => toCandidate(s.release, s.S))
  if (!best) return unmatched(input)
  return buildResult(classify(best), best, q, input, cands)
}

const searchArtist = (q: Query) => q.albumartist ?? q.tracks.map((t) => t.tags.artist).find(Boolean)

async function textCandidates(deps: IdentifyDeps, q: Query, signal?: AbortSignal): Promise<MbRelease[]> {
  if (!q.album) return []
  const artist = searchArtist(q)
  const run = (album: string, a?: string, tracks?: number) =>
    safe(deps, 'release search', () => deps.mb.searchReleases(album, a, 15, signal, tracks), [] as MbRelease[], signal)
  let rs = await run(q.album, artist)
  const top = () => Math.max(0, ...rs.map((r) => r.score ?? 0))
  const stripped = stripEdition(q.album)
  if (top() < 90 && stripped && stripped !== q.album) rs = [...rs, ...(await run(stripped, artist))]
  if (!rs.length && artist) rs = await run(q.album)
  // Popular albums have dozens of editions; the plain search may never surface the one with this track count.
  const n = Math.max(q.tracks.length, q.totaltracks ?? 0)
  if (n > 1 && rs.length && !rs.some((r) => releaseTrackCount(r) === n)) rs = [...rs, ...(await run(stripped || q.album, artist, n))]
  return rs
}

async function idHits(deps: IdentifyDeps, q: Query, input: IdentifyInput, signal?: AbortSignal): Promise<Map<string, { r: MbRelease; hint: number }>> {
  const out = new Map<string, { r: MbRelease; hint: number }>()
  const tally = (lists: MbRelease[][]) => {
    const counts = new Map<string, { r: MbRelease; n: number }>()
    for (const list of lists) {
      const seen = new Set<string>()
      for (const r of list) {
        if (seen.has(r.id)) continue
        seen.add(r.id)
        const e = counts.get(r.id)
        if (e) e.n++
        else counts.set(r.id, { r, n: 1 })
      }
    }
    for (const [id, { r, n }] of counts) {
      const hint = n / lists.length
      const prev = out.get(id)
      if (!prev || prev.hint < hint) out.set(id, { r: prev?.r ?? r, hint })
    }
  }
  // ISRC intersection across up to 3 tracks.
  const isrcs = [...new Set(q.tracks.map((t) => t.tags.isrc?.toUpperCase()).filter(Boolean) as string[])].slice(0, 3)
  if (isrcs.length) {
    const lists: MbRelease[][] = []
    for (const isrc of isrcs) {
      const recs = await safe(deps, `isrc ${isrc}`, () => deps.mb.recordingsByIsrc(isrc, signal), [] as MbRecording[], signal)
      lists.push(recs.flatMap((r) => r.releases ?? []))
    }
    tally(lists)
  }
  // AcoustID (only with a key).
  if (deps.acoustid) {
    const lists: MbRelease[][] = []
    const withFp = input.tracks.map((t, i) => ({ t, i })).filter(({ t }) => t.fingerprint || t.file)
    for (const { t, i } of withFp.slice(0, 3)) {
      const fp = t.fingerprint ?? (t.file ? await deps.fingerprint(t.file) : null)
      if (!fp) continue
      const matches = await safe(deps, 'acoustid', () => deps.acoustid!(fp, signal), [] as AcoustidMatch[], signal)
      lists.push(matches.flatMap((m) => m.releases))
      // fingerprint evidence counts like a recording id when scoring releases
      q.tracks[i].acoustid = matches.map((m) => m.recordingId)
    }
    if (lists.length) tally(lists)
  }
  return out
}

async function identifyAlbum(deps: IdentifyDeps, q: Query, input: IdentifyInput, signal?: AbortSignal): Promise<IdentifyResult> {
  const pool = new Pool(deps, q, signal)
  for (const id of q.mbAlbumIds.slice(0, 2)) await pool.add(id)
  if (pool.confident()) return finishAlbum(pool, q, input)

  if (q.barcode) {
    const rs = await safe(deps, 'barcode search', () => deps.mb.releasesByBarcode(q.barcode!, signal), [] as MbRelease[], signal)
    for (const r of rs.sort((a, b) => preScore(q, b, 1) - preScore(q, a, 1)).slice(0, 3)) await pool.add(r.id)
    if (pool.confident()) return finishAlbum(pool, q, input)
  }

  const summaries = await idHits(deps, q, input, signal)
  if (!pool.confident(0.95)) {
    for (const r of await textCandidates(deps, q, signal)) if (!summaries.has(r.id)) summaries.set(r.id, { r, hint: 0 })
  }
  const ranked = [...summaries.values()].map((e) => ({ id: e.r.id, p: preScore(q, e.r, e.hint) })).sort((a, b) => b.p - a.p)
  for (const { id } of ranked) {
    if (pool.full) break
    await pool.add(id)
    if (pool.confident(0.97)) break
  }
  return finishAlbum(pool, q, input)
}

// ---------- singleton flow ----------

interface RecCand { rec: MbRecording; conf: number; accepted: boolean; origin: 'mbid' | 'isrc' | 'acoustid' | 'text' }

const SECONDARY_DEMOTE = ['live', 'remix', 'demo', 'mixtape/street', 'interview', 'audiobook', 'spokenword']

/** Lower is better: tag album → official Album → Single/EP → other → compilation (only when tags say so). */
export function singletonTier(r: MbRelease, q: Query, rec: { id: string; origin?: string }): number {
  const rg = r['release-group']
  const primary = (rg?.['primary-type'] ?? '').toLowerCase()
  const sec = (rg?.['secondary-types'] ?? []).map((s) => s.toLowerCase())
  const status = (r.status ?? '').toLowerCase()
  const comp = sec.includes('compilation') || sec.includes('dj-mix') || creditIds(r['artist-credit']).includes(VA_ID)
  if (q.album && albumSim(q.album, r.title, r.disambiguation) >= 0.9 && status !== 'bootleg') {
    if (q.source === 'import' || rec.origin === 'isrc' || positionMatches(r, q, rec.id)) return 0
  }
  if (status && status !== 'official') return status === 'promotion' ? 6 : 8
  if (comp) return q.compilation ? 3 : 7
  if (sec.some((s) => SECONDARY_DEMOTE.includes(s))) return 5
  if (primary === 'album') return 1
  if (primary === 'single' || primary === 'ep') return 2
  return 4
}

/** Search summaries list only the matched track; full releases are checked by recording id. */
function positionMatches(r: MbRelease, q: Query, recId: string): boolean {
  const tn = q.tracks[0]?.tags.tracknumber
  if (!tn) return true
  return (r.media ?? []).some((m) =>
    (m.track ?? m.tracks ?? []).some((t) => (!t.recording || t.recording.id === recId) && (Number(t.number) === tn || t.position === tn)),
  )
}

function rankSingleton(cands: RecCand[], q: Query): Array<{ rec: RecCand; r: MbRelease; tier: number; score: number }> {
  const pairs: Array<{ rec: RecCand; r: MbRelease; tier: number; score: number }> = []
  const seen = new Set<string>()
  for (const c of [...cands].sort((a, b) => b.conf - a.conf)) {
    for (const r of c.rec.releases ?? []) {
      if (seen.has(r.id)) continue
      seen.add(r.id)
      const tier = singletonTier(r, q, { id: c.rec.id, origin: c.origin })
      pairs.push({ rec: c, r, tier, score: c.conf * (1 - 0.04 * tier) })
    }
  }
  return pairs.sort((a, b) => a.tier - b.tier || (a.r.date || '9999').localeCompare(b.r.date || '9999') || releasePref(b.r, q) - releasePref(a.r, q) || b.rec.conf - a.rec.conf)
}

async function recordingCandidates(deps: IdentifyDeps, q: Query, input: IdentifyInput, signal?: AbortSignal): Promise<RecCand[]> {
  const t = q.tracks[0]
  const tags = t.tags
  const title = tags.title ? cleanTitle(tags.title).title : undefined
  const out: RecCand[] = []
  const has = () => out.some((c) => c.accepted)
  if (tags.musicbrainz_recordingid) {
    const rec = await safe(deps, 'recording lookup', () => deps.mb.recording(tags.musicbrainz_recordingid!, signal), null, signal)
    if (rec) out.push({ rec, conf: 1, accepted: true, origin: 'mbid' })
  }
  if (!has() && tags.isrc) {
    const recs = await safe(deps, 'isrc search', () => deps.mb.recordingsByIsrc(tags.isrc!, signal), [] as MbRecording[], signal)
    for (const rec of recs) {
      const ok = !title || titleSim(title, rec.title) >= 0.7
      out.push({ rec, conf: ok ? 0.95 : 0.6, accepted: ok, origin: 'isrc' })
    }
  }
  if (!has() && deps.acoustid) {
    const it = input.tracks[0]
    const fp = it.fingerprint ?? (it.file ? await deps.fingerprint(it.file) : null)
    if (fp) {
      const matches = await safe(deps, 'acoustid', () => deps.acoustid!(fp, signal), [] as AcoustidMatch[], signal)
      for (const m of matches.slice(0, 3)) {
        const accepted = m.score >= SINGLE_ACOUSTID_ACCEPT
        let rec: MbRecording = { id: m.recordingId, title: m.title ?? '', length: m.durationSec ? m.durationSec * 1000 : undefined, releases: m.releases }
        if (accepted && !m.releases.some((r) => r['release-group']?.['primary-type'])) {
          rec = (await safe(deps, 'recording lookup', () => deps.mb.recording(m.recordingId, signal), null, signal)) ?? rec
        }
        out.push({ rec, conf: m.score, accepted, origin: 'acoustid' })
      }
    }
  }
  if (!has() && title) {
    const query = stripFeat(title) || title
    const recs = await safe(deps, 'recording search', () => deps.mb.searchRecordings(query, tags.artist, 15, signal), [] as MbRecording[], signal)
    for (const rec of recs) {
      const ts = titleSim(title, rec.title)
      const as = tags.artist ? artistSim(tags.artist, creditString(rec['artist-credit']), tags.artists, creditNames(rec['artist-credit'])) : 0
      const delta = t.durationMs && rec.length ? Math.abs(t.durationMs - rec.length) : Infinity
      const sc = rec.score ?? 0
      const conf = 0.4 * (sc / 100) + 0.3 * ts + 0.15 * durSim(t.durationMs, rec.length) + 0.15 * as
      const accepted = sc >= 95 && delta <= 3000 && as >= 0.8 && ts >= 0.85
      if (accepted || (sc >= 70 && ts >= 0.75 && delta <= 7000)) out.push({ rec, conf, accepted, origin: 'text' })
    }
  }
  return out
}

async function identifySingle(deps: IdentifyDeps, q: Query, input: IdentifyInput, signal?: AbortSignal): Promise<IdentifyResult> {
  // Release-level ids first: a source single/EP with a barcode maps by ISRC or position.
  const pool = new Pool(deps, q, signal)
  for (const id of q.mbAlbumIds.slice(0, 1)) await pool.add(id)
  if (q.barcode && !pool.confident(0.85)) {
    const rs = await safe(deps, 'barcode search', () => deps.mb.releasesByBarcode(q.barcode!, signal), [] as MbRelease[], signal)
    for (const r of rs.slice(0, 2)) await pool.add(r.id)
  }
  const direct = pool.ranked().find((s) => (s.assignment[0]?.sim ?? 0) >= 0.75)
  if (direct) return buildResult('auto', direct, q, input, [])

  const recs = await recordingCandidates(deps, q, input, signal)
  const accepted = recs.filter((c) => c.accepted)
  const ranked = rankSingleton(accepted.length ? accepted : recs, q)
  const cands = ranked.slice(0, 5).map((p) => toCandidate(p.r, p.score))
  for (const p of ranked.slice(0, 2)) {
    const full = await safe(deps, `release ${p.r.id}`, () => deps.mb.release(p.r.id, signal), null, signal)
    if (!full?.media) continue
    const s = scoreRelease(q, full)
    const j = s.flat.findIndex((f) => f.recordingId === p.rec.rec.id)
    if (j < 0) continue
    s.assignment[0] = { j, sim: Math.max(trackSim(q.tracks[0], s.flat[j]), p.rec.accepted ? p.rec.conf : 0) }
    return buildResult(accepted.length ? 'auto' : 'review', s, q, input, cands, p.rec.conf)
  }
  return unmatched(input, cands)
}

// ---------- entry points ----------

export async function identifyRelease(deps: IdentifyDeps, input: IdentifyInput, signal?: AbortSignal): Promise<IdentifyResult> {
  if (!input.tracks.length) return unmatched(input)
  const q = buildQuery(input)
  return input.tracks.length === 1 ? identifySingle(deps, q, input, signal) : identifyAlbum(deps, q, input, signal)
}

export async function applyRelease(deps: IdentifyDeps, releaseId: string, input: IdentifyInput): Promise<IdentifyResult> {
  const q = buildQuery(input)
  const r = await deps.mb.release(releaseId)
  if (!r?.media) return unmatched(input)
  const s = scoreRelease(q, r)
  return buildResult('auto', s, q, input, [])
}
