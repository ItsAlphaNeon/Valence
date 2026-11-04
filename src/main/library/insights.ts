// Derived views over plays and favorites: listening stats and "similar tracks" for autoplay. Plays are keyed like tracks (valence id or 'path:<rel>') and joined back
// through the tracks_item_key index.

import type { DB } from '@main/db/db'
import type { ListeningStats, StatsRange } from '@shared/ipc/library'
import type { LibraryStats, TrackRow } from '@shared/types'
import { VARIOUS_ARTISTS, primaryArtist, splitCredit } from '@shared/artist-credit'
import { matchKey } from '@shared/sanitize'
import { artistFavoriteKey, trackKeySql } from '@main/sync/favorites'
import { albumsByIds, tracksByIds } from './queries'

const KEY = trackKeySql('t')
// Joins compare KEY with `+column`: a plain TEXT column would give the comparison TEXT affinity,
// which keeps SQLite from looking tracks up through the tracks_item_key expression index.

// ---- time helpers (local time) ----

export function startOfLocalDay(ms: number): number {
  const d = new Date(ms)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/** Adds calendar days in local time (midnight stays midnight across DST changes). */
export function addLocalDays(ms: number, days: number): number {
  const d = new Date(ms)
  d.setDate(d.getDate() + days)
  return d.getTime()
}

export function localDayKey(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** Small seeded PRNG (mulberry32). */
export function seededRandom(seed: string | number): () => number {
  let h = typeof seed === 'number' ? seed >>> 0 : 2166136261
  if (typeof seed === 'string') for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619) >>> 0
  return () => {
    h = (h + 0x6d2b79f5) >>> 0
    let t = h
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// ---- plays joined to tracks ----

interface PlayedTrack {
  key: string
  plays: number
  skips: number
  ms: number
  last: number | null
  id: number
  albumId: number | null
  albumArtist: string
  artist: string
  artHash: string | null
}

/** Plays since `since` aggregated per track still in the library (one row per play key). */
function playedTracks(db: DB, since: number, mainOnly: boolean): PlayedTrack[] {
  const rows = db
    .prepare(
      `WITH k AS (
         SELECT track_key, sum(skipped = 0) AS plays, sum(skipped) AS skips, coalesce(sum(ms), 0) AS ms,
           max(CASE WHEN skipped = 0 THEN played_at END) AS last
         FROM plays WHERE played_at >= ? GROUP BY track_key)
       SELECT k.track_key AS key, k.plays, k.skips, k.ms, k.last, t.id, t.album_id AS albumId, t.album_artist AS albumArtist,
         t.artist, t.art_hash AS artHash
       FROM k JOIN tracks t ON ${KEY} = +k.track_key${mainOnly ? " WHERE +t.hq_rip = ''" : ''}
       ORDER BY t.id`,
    )
    .all(since) as PlayedTrack[]
  const seen = new Set<string>()
  return rows.filter((r) => !seen.has(r.key) && !!seen.add(r.key))
}

const byPlays = (a: { plays: number; ms: number }, b: { plays: number; ms: number }) => b.plays - a.plays || b.ms - a.ms

function withPlays<T extends { id: number }>(rows: T[], plays: Map<number, number>): Array<T & { plays: number }> {
  return rows.map((r) => ({ ...r, plays: plays.get(r.id) ?? 0 }))
}

function topTracks(db: DB, played: PlayedTrack[], n: number): Array<TrackRow & { plays: number }> {
  const top = played.filter((p) => p.plays > 0).sort((a, b) => byPlays(a, b) || (b.last ?? 0) - (a.last ?? 0)).slice(0, n)
  return withPlays(tracksByIds(db, top.map((p) => p.id)), new Map(top.map((p) => [p.id, p.plays])))
}

function albumTotals(played: PlayedTrack[]): Map<number, { plays: number; ms: number; last: number }> {
  const out = new Map<number, { plays: number; ms: number; last: number }>()
  for (const p of played) {
    if (p.albumId == null) continue
    const a = out.get(p.albumId) ?? { plays: 0, ms: 0, last: 0 }
    a.plays += p.plays
    a.ms += p.ms
    a.last = Math.max(a.last, p.last ?? 0)
    out.set(p.albumId, a)
  }
  return out
}

interface ArtistTotal {
  name: string
  plays: number
  ms: number
  artHash: string | null
  best: number
}

/** Plays per artist: the album artist, or the track's primary artist on Various Artists compilations. */
function artistTotals(played: PlayedTrack[], opts: { skipVarious: boolean }): ArtistTotal[] {
  const out = new Map<string, ArtistTotal>()
  for (const p of played) {
    if (p.plays <= 0) continue
    const various = !p.albumArtist || p.albumArtist === VARIOUS_ARTISTS
    if (various && opts.skipVarious) continue
    const name = various ? primaryArtist(p.artist) || p.artist : p.albumArtist
    if (!name) continue
    const key = artistFavoriteKey(name)
    const a = out.get(key) ?? { name, plays: 0, ms: 0, artHash: null, best: -1 }
    a.plays += p.plays
    a.ms += p.ms
    if (p.plays > a.best && p.artHash) {
      a.best = p.plays
      a.artHash = p.artHash
    }
    out.set(key, a)
  }
  return [...out.values()].sort(byPlays)
}

// ---- Listening stats ----

const RANGE_DAYS: Record<Exclude<StatsRange, 'all'>, number> = { '7d': 7, '30d': 30, '90d': 90, year: 365 }
const MAX_DAYS = 400

export function statsRangeStart(range: StatsRange, now = Date.now()): number {
  if (range === 'all') return 0
  return addLocalDays(startOfLocalDay(now), -((RANGE_DAYS[range] ?? 30) - 1))
}

export function listeningStats(db: DB, range: StatsRange, library: LibraryStats, now = Date.now()): ListeningStats {
  if (!(range in RANGE_DAYS) && range !== 'all') range = '30d'
  const since = statsRangeStart(range, now)
  const today = startOfLocalDay(now)
  const tot = db
    .prepare(
      `SELECT coalesce(sum(skipped = 0), 0) AS plays, coalesce(sum(skipped), 0) AS skips, coalesce(sum(ms), 0) AS ms,
         count(DISTINCT CASE WHEN skipped = 0 THEN track_key END) AS tracks, min(played_at) AS first
       FROM plays WHERE played_at >= ?`,
    )
    .get(since) as { plays: number; skips: number; ms: number; tracks: number; first: number | null }

  // Days shown: the whole range, or for 'year'/'all' from the first play; at most MAX_DAYS.
  let from = since
  if (range === 'all' || range === 'year') from = tot.first != null ? Math.max(since, startOfLocalDay(tot.first)) : today
  from = Math.max(from, addLocalDays(today, -(MAX_DAYS - 1)))
  const byDay: ListeningStats['byDay'] = []
  const dayIndex = new Map<string, number>()
  for (let d = from, i = 0; d <= today && i < MAX_DAYS; d = addLocalDays(d, 1), i++) {
    const day = localDayKey(d)
    dayIndex.set(day, byDay.length)
    byDay.push({ day, plays: 0, ms: 0 })
  }

  const byHour = new Array<number>(24).fill(0)
  const byWeekday = new Array<number>(7).fill(0)
  // Local day/hour per 15-minute slot (time zones are offset by multiples of 15 minutes).
  const slots = new Map<number, { day: string; hour: number; wd: number }>()
  const rows = db.prepare('SELECT played_at, ms, skipped FROM plays WHERE played_at >= ?').raw().all(since) as Array<[number, number, number]>
  for (const [at, ms, skipped] of rows) {
    const slot = Math.floor(at / 900_000)
    let s = slots.get(slot)
    if (!s) {
      const d = new Date(at)
      s = { day: localDayKey(at), hour: d.getHours(), wd: (d.getDay() + 6) % 7 }
      slots.set(slot, s)
    }
    const i = dayIndex.get(s.day)
    if (i !== undefined) {
      byDay[i].ms += ms || 0
      if (!skipped) byDay[i].plays++
    }
    if (!skipped) {
      byHour[s.hour]++
      byWeekday[s.wd]++
    }
  }

  const played = playedTracks(db, since, false)
  const albumPlays = [...albumTotals(played)].filter(([, a]) => a.plays > 0).sort((a, b) => byPlays(a[1], b[1]))
  const topAlbumIds = albumPlays.slice(0, 20)
  const artists = artistTotals(played, { skipVarious: false })

  return {
    plays: tot.plays,
    skips: tot.skips,
    ms: tot.ms,
    distinctTracks: tot.tracks,
    distinctArtists: artists.length,
    topTracks: topTracks(db, played, 25),
    topAlbums: withPlays(albumsByIds(db, topAlbumIds.map(([id]) => id)), new Map(topAlbumIds.map(([id, a]) => [id, a.plays]))),
    topArtists: artists.slice(0, 20).map((a) => ({ name: a.name, plays: a.plays, ms: a.ms, artHash: a.artHash })),
    byDay,
    byHour,
    byWeekday,
    formats: libraryFormats(db),
    library,
    firstPlay: tot.first ?? null,
  }
}

const CODEC_NAMES: Record<string, string> = {
  mp3: 'MP3',
  mp2: 'MP2',
  aac: 'AAC',
  alac: 'ALAC',
  flac: 'FLAC',
  opus: 'Opus',
  vorbis: 'Vorbis',
  pcm: 'PCM',
  wma: 'WMA',
  ape: 'APE',
  wavpack: 'WavPack',
  mpc: 'Musepack',
  dsd: 'DSD',
  ac3: 'AC-3',
}
const BITRATES = [32, 48, 64, 96, 128, 160, 192, 224, 256, 320]

/** Display label for a format: 'FLAC', 'FLAC 24/96', 'MP3 320', 'AAC 256'. */
export function formatLabel(f: { codec: string | null; lossless: boolean; bitDepth: number; sampleRate: number; bitrate: number }): string {
  const codec = (f.codec ?? '').toLowerCase()
  const name = CODEC_NAMES[codec] ?? (codec ? codec.toUpperCase() : 'Unknown')
  if (f.lossless) {
    if (f.bitDepth > 16 || f.sampleRate > 48000) {
      const khz = f.sampleRate ? String(Math.round(f.sampleRate / 100) / 10) : '?'
      return `${name} ${f.bitDepth || 24}/${khz}`
    }
    return name
  }
  const kbps = Math.round(f.bitrate / 1000)
  if (!kbps) return name
  const bucket = kbps > 340 ? Math.round(kbps / 10) * 10 : BITRATES.reduce((best, b) => (Math.abs(b - kbps) < Math.abs(best - kbps) ? b : best))
  return `${name} ${bucket}`
}

export function libraryFormats(db: DB): Array<{ label: string; tracks: number }> {
  const rows = db
    .prepare(
      `SELECT codec, lossless, bit_depth AS bitDepth, sample_rate AS sampleRate, (bitrate / 8000) * 8000 AS bitrate, count(*) AS n
       FROM tracks WHERE +hq_rip = '' GROUP BY codec, lossless, bit_depth, sample_rate, bitrate / 8000`,
    )
    .all() as Array<{ codec: string | null; lossless: number; bitDepth: number; sampleRate: number; bitrate: number; n: number }>
  const out = new Map<string, number>()
  for (const r of rows) {
    const label = formatLabel({ ...r, lossless: !!r.lossless })
    out.set(label, (out.get(label) ?? 0) + r.n)
  }
  return [...out].map(([label, tracks]) => ({ label, tracks })).sort((a, b) => b.tracks - a.tracks || a.label.localeCompare(b.label))
}

// ---- Similar tracks (autoplay) ----

interface Candidate {
  id: number
  albumId: number | null
  albumArtist: string
  artist: string
  title: string
  genre: string | null
  year: number | null
  rating: number
  key: string
  liked: number
  score: number
  spread: string
  dupe: string
}

function genreTokens(g: string | null | undefined): string[] {
  if (!g) return []
  return [...new Set(g.split(/\s*[;,/]\s*/).map((x) => x.trim().toLowerCase()).filter(Boolean))]
}

function artistTokens(albumArtist: string, artist: string): string[] {
  const out = new Set<string>()
  if (albumArtist && albumArtist !== VARIOUS_ARTISTS) out.add(artistFavoriteKey(albumArtist))
  for (const a of splitCredit(artist)) out.add(artistFavoriteKey(a))
  if (artist) out.add(artistFavoriteKey(artist))
  return [...out].filter(Boolean)
}

/**
 * Up to `n` main-library track ids that fit after the seed tracks: same artists and genres
 * first, liked / well-rated / often-played tracks boosted, recently played and often-skipped
 * ones held back, some randomness, and artists spread out (no artist twice within three picks
 * when anything else fits). Never returns seeds or `excludeIds`.
 */
export function similarTracks(db: DB, seedIds: number[], excludeIds: number[], n: number, opts: { random?: () => number; now?: number } = {}): number[] {
  const count = Math.max(0, Math.min(200, Math.floor(Number(n) || 0)))
  if (!count) return []
  const rand = opts.random ?? Math.random
  const now = opts.now ?? Date.now()
  const excluded = new Set<number>([...(excludeIds ?? []), ...(seedIds ?? [])].map(Number))

  const seeds = (seedIds?.length
    ? db
        .prepare(`SELECT id, album_id AS albumId, album_artist AS albumArtist, artist, title, genre, year FROM tracks WHERE id IN (SELECT value FROM json_each(?))`)
        .all(JSON.stringify(seedIds.slice(-50)))
    : []) as Array<{ id: number; albumId: number | null; albumArtist: string; artist: string; title: string; genre: string | null; year: number | null }>

  const artistW = new Map<string, number>()
  const genreW = new Map<string, number>()
  const rawArtists = new Set<string>()
  const rawGenres = new Set<string>()
  const seedSongs = new Set<string>()
  let yearSum = 0
  let yearN = 0
  for (const s of seeds) {
    for (const a of artistTokens(s.albumArtist, s.artist)) artistW.set(a, (artistW.get(a) ?? 0) + 1 / seeds.length)
    for (const g of genreTokens(s.genre)) genreW.set(g, (genreW.get(g) ?? 0) + 1 / seeds.length)
    if (s.albumArtist && s.albumArtist !== VARIOUS_ARTISTS) rawArtists.add(s.albumArtist)
    if (s.artist) {
      rawArtists.add(s.artist)
      for (const a of splitCredit(s.artist)) rawArtists.add(a)
    }
    if (s.genre) {
      rawGenres.add(s.genre)
      for (const g of s.genre.split(/\s*[;,/]\s*/)) if (g.trim()) rawGenres.add(g.trim())
    }
    if (s.year) {
      yearSum += s.year
      yearN++
    }
    seedSongs.add(`${matchKey(primaryArtist(s.artist))}|${matchKey(s.title)}`)
  }

  // Candidate ids: same artists, same genres, liked tracks, and a random sample of everything.
  // (`+hq_rip` keeps SQLite from choosing the nearly useless hq_rip index over the artist/genre ones.)
  const ids = new Set<number>()
  const addIds = (rows: unknown[]) => {
    for (const r of rows as Array<{ id: number }>) if (!excluded.has(r.id)) ids.add(r.id)
  }
  if (rawArtists.size) {
    const names = JSON.stringify([...rawArtists])
    addIds(
      db
        .prepare(
          // A UNION, not OR, so each side uses its own index.
          `SELECT id FROM tracks WHERE +hq_rip = '' AND id IN (
             SELECT id FROM tracks WHERE album_artist COLLATE NOCASE IN (SELECT value FROM json_each(?))
             UNION SELECT id FROM tracks WHERE artist COLLATE NOCASE IN (SELECT value FROM json_each(?)))
           ORDER BY random() LIMIT 1200`,
        )
        .all(names, names),
    )
  }
  if (rawGenres.size) {
    addIds(db.prepare(`SELECT id FROM tracks WHERE +hq_rip = '' AND genre COLLATE NOCASE IN (SELECT value FROM json_each(?)) ORDER BY random() LIMIT 1500`).all(JSON.stringify([...rawGenres])))
  }
  addIds(
    db
      .prepare(
        `SELECT t.id FROM favorites f JOIN tracks t ON ${KEY} = +f.item_key
         WHERE f.kind = 't' AND f.liked = 1 AND +t.hq_rip = '' ORDER BY random() LIMIT 300`,
      )
      .all(),
  )
  const span = db.prepare('SELECT (SELECT min(id) FROM tracks) AS lo, (SELECT max(id) FROM tracks) AS hi').get() as { lo: number | null; hi: number | null }
  if (span.lo != null && span.hi != null) {
    const sample = new Set<number>()
    const want = Math.max(300, count * 8)
    for (let i = 0; i < want * 2 && sample.size < want; i++) sample.add(span.lo + Math.floor(rand() * (span.hi - span.lo + 1)))
    addIds(db.prepare(`SELECT id FROM tracks WHERE id IN (SELECT value FROM json_each(?)) AND +hq_rip = ''`).all(JSON.stringify([...sample])))
  }
  if (!ids.size) return []

  const list = JSON.stringify([...ids])
  const cands = db
    .prepare(
      `SELECT t.id, t.album_id AS albumId, t.album_artist AS albumArtist, t.artist, t.title, t.genre, t.year, t.rating, ${KEY} AS key,
         coalesce((SELECT f.liked FROM favorites f WHERE f.kind = 't' AND f.item_key = ${KEY}), 0) AS liked
       FROM tracks t WHERE t.id IN (SELECT value FROM json_each(?))`,
    )
    .all(list) as Candidate[]
  const stats = new Map(
    (
      db
        .prepare(
          `SELECT track_key AS key, sum(skipped = 0) AS plays, sum(skipped) AS skips, max(CASE WHEN skipped = 0 THEN played_at END) AS last
           FROM plays WHERE track_key IN (SELECT value FROM json_each(?)) GROUP BY track_key`,
        )
        .all(JSON.stringify(cands.map((c) => c.key))) as Array<{ key: string; plays: number; skips: number; last: number | null }>
    ).map((r) => [r.key, r]),
  )

  const yearAvg = yearN ? yearSum / yearN : null
  for (const c of cands) {
    let s = 0
    let aw = 0
    for (const a of artistTokens(c.albumArtist, c.artist)) aw = Math.max(aw, artistW.get(a) ?? 0)
    s += 3 * aw
    let gw = 0
    for (const g of genreTokens(c.genre)) gw = Math.max(gw, genreW.get(g) ?? 0)
    s += 2 * gw
    if (yearAvg != null && c.year) s += 0.6 * Math.max(0, 1 - Math.abs(c.year - yearAvg) / 15)
    if (c.liked) s += 1.2
    if (c.rating) s += 0.25 * (c.rating - 2.5)
    const st = stats.get(c.key)
    if (st) {
      s += Math.min(1.5, 0.35 * Math.log2(1 + st.plays))
      s -= Math.min(2, 0.4 * Math.log2(1 + st.skips))
      if (st.last && now - st.last < 6 * 3600_000) s -= 2
    }
    s += rand() * 1.6
    c.score = s
    const various = !c.albumArtist || c.albumArtist === VARIOUS_ARTISTS
    c.spread = artistFavoriteKey(various ? primaryArtist(c.artist) || c.artist : c.albumArtist)
    c.dupe = `${matchKey(primaryArtist(c.artist))}|${matchKey(c.title)}`
  }
  cands.sort((a, b) => b.score - a.score)

  // Greedy pick with artist spreading. Penalties only lower scores, so the scan can stop as soon
  // as the remaining (sorted) base scores can't beat the best adjusted score.
  const picked: number[] = []
  const recent: string[] = []
  const perArtist = new Map<string, number>()
  const songs = new Set(seedSongs)
  const pool = cands.filter((c) => !songs.has(c.dupe))
  while (picked.length < count && pool.length) {
    let bi = -1
    let bs = -Infinity
    for (let i = 0; i < pool.length; i++) {
      const c = pool[i]
      if (c.score <= bs) break
      let s = c.score - 1.25 * (perArtist.get(c.spread) ?? 0)
      if (recent.includes(c.spread)) s -= 6
      if (s > bs) {
        bs = s
        bi = i
      }
    }
    const [c] = pool.splice(Math.max(0, bi), 1)
    if (songs.has(c.dupe)) continue
    songs.add(c.dupe)
    picked.push(c.id)
    perArtist.set(c.spread, (perArtist.get(c.spread) ?? 0) + 1)
    recent.push(c.spread)
    if (recent.length > 2) recent.shift()
  }
  return picked
}
