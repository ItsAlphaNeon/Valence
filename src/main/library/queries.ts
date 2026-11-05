// Read-side queries backing the library views.

import type { AlbumRow, ArtistRow, FavoriteCounts, GenreRow, HistoryEntry, RipGameRow, LibraryCollection, LibraryStats, TrackQuery, TrackRow } from '@shared/types'
import type { AlbumQuery, AlbumsPage, SearchResult } from '@shared/ipc/library'
import type { DB } from '@main/db/db'
import { artistFavoriteKey, trackKeySql } from '@main/sync/favorites'

/**
 * SQL condition for one half of the library on a table alias with an hq_rip column (tracks or
 * albums), or null for both. `kinds` narrows rips to some collections (SiIvaGunner, SGFR, YouTube).
 */
export function collectionWhere(alias: string, c: LibraryCollection, kinds?: readonly string[], params?: unknown[]): string | null {
  if (c === 'all') return null
  if (c === 'main') return `${alias}.hq_rip = ''`
  if (kinds?.length && params) {
    params.push(JSON.stringify(kinds))
    return `${alias}.hq_rip IN (SELECT value FROM json_each(?))`
  }
  return `${alias}.hq_rip <> ''`
}

const TRACK_SELECT = `
  SELECT t.*, coalesce(ps.play_count, 0) AS play_count, ps.last_played AS last_played,
    coalesce(fv.liked, 0) AS liked, CASE WHEN fv.liked = 1 THEN fv.at END AS liked_at
  FROM tracks t
  LEFT JOIN play_stats ps ON ps.track_key = coalesce(t.valence_id, 'path:' || t.rel_path)
  LEFT JOIN favorites fv ON fv.kind = 't' AND fv.item_key = coalesce(t.valence_id, 'path:' || t.rel_path)`

/** Condition: the track on alias `t` is liked (`+item_key` has no affinity, so the tracks_item_key index applies). */
export const TRACK_LIKED_SQL = `${trackKeySql('t')} IN (SELECT +item_key FROM favorites WHERE kind = 't' AND liked = 1)`
/** Condition: the album on alias `a` is liked. */
export const ALBUM_LIKED_SQL = `a.album_key IN (SELECT item_key FROM favorites WHERE kind = 'a' AND liked = 1)`

export function toTrackRow(r: Record<string, any>): TrackRow {
  return {
    id: r.id,
    valenceId: r.valence_id,
    relPath: r.rel_path,
    title: r.title,
    artist: r.artist,
    album: r.album,
    albumArtist: r.album_artist,
    trackNo: r.track_no,
    trackTotal: r.track_total,
    discNo: r.disc_no,
    discTotal: r.disc_total,
    year: r.year,
    date: r.date,
    genre: r.genre,
    durationMs: r.duration_ms,
    codec: r.codec ?? '',
    bitrate: r.bitrate,
    sampleRate: r.sample_rate,
    lossless: !!r.lossless,
    rating: r.rating,
    albumId: r.album_id,
    artHash: r.art_hash,
    addedAt: r.added_at,
    lyricsKind: r.lyrics_kind,
    playCount: r.play_count ?? 0,
    lastPlayed: r.last_played ?? null,
    isrc: r.isrc,
    tidalTrackId: r.tidal_track_id,
    bandcampItemId: r.bandcamp_item_id,
    source: r.source,
    rgTrackGain: r.rg_track_gain,
    rgTrackPeak: r.rg_track_peak,
    rgAlbumGain: r.rg_album_gain,
    rgAlbumPeak: r.rg_album_peak,
    compilation: !!r.compilation,
    hqRip: r.hq_rip ?? '',
    composer: r.composer ?? null,
    ripGame: r.rip_game ?? null,
    youtubeVideoId: r.youtube_video_id ?? null,
    liked: !!r.liked,
    likedAt: r.liked_at ?? null,
  }
}

const SORT_COLUMNS: Partial<Record<keyof TrackRow, string>> = {
  title: 'coalesce(t.title_sort, t.title) COLLATE NOCASE',
  artist: 'coalesce(t.artist_sort, t.artist) COLLATE NOCASE',
  album: 'coalesce(t.album_sort, t.album) COLLATE NOCASE',
  albumArtist: 'coalesce(t.album_artist_sort, t.album_artist) COLLATE NOCASE',
  year: 't.year',
  genre: 't.genre COLLATE NOCASE',
  durationMs: 't.duration_ms',
  rating: 't.rating',
  addedAt: 't.added_at',
  playCount: 'play_count',
  lastPlayed: 'last_played',
  bitrate: 't.bitrate',
  trackNo: 't.track_no',
  codec: 't.codec',
  ripGame: 't.rip_game COLLATE NOCASE',
  composer: 't.composer COLLATE NOCASE',
  likedAt: 'liked_at',
}

const ALBUM_ORDER = 'coalesce(t.album_artist_sort, t.album_artist) COLLATE NOCASE, t.year, t.album COLLATE NOCASE, coalesce(t.disc_no, 1), coalesce(t.track_no, 9999), t.title COLLATE NOCASE'

/** Turns free text into an FTS5 prefix query ("daft pun" -> "daft"* "pun"*). */
export function ftsQuery(text: string): string | null {
  const terms = text
    .normalize('NFKC')
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .slice(0, 8)
  if (!terms.length) return null
  return terms.map((t) => `"${t.replace(/"/g, '')}"*`).join(' ')
}

export function queryTracks(db: DB, q: TrackQuery = {}): { rows: TrackRow[]; total: number } {
  const where: string[] = []
  const params: unknown[] = []
  const coll = collectionWhere('t', q.collection ?? (q.albumId !== undefined || q.playlistId || q.liked || q.ripGame ? 'all' : 'main'), q.ripKinds, params)
  if (coll) where.push(coll)
  if (q.search) {
    const fts = ftsQuery(q.search)
    if (fts) {
      where.push('t.id IN (SELECT rowid FROM tracks_fts WHERE tracks_fts MATCH ?)')
      params.push(fts)
    }
  }
  if (q.albumId !== undefined) {
    where.push('t.album_id = ?')
    params.push(q.albumId)
  }
  if (q.albumArtist) {
    where.push('t.album_artist = ? COLLATE NOCASE')
    params.push(q.albumArtist)
  }
  if (q.artist) {
    where.push('(t.artist = ? COLLATE NOCASE OR t.album_artist = ? COLLATE NOCASE OR t.artists_json LIKE ?)')
    params.push(q.artist, q.artist, `%${JSON.stringify(q.artist).slice(1, -1)}%`)
  }
  if (q.genre) {
    where.push('t.genre = ? COLLATE NOCASE')
    params.push(q.genre)
  }
  if (q.ripGame) {
    where.push(`t.hq_rip <> '' AND t.rip_game = ? COLLATE NOCASE`)
    params.push(q.ripGame)
  }
  if (q.playlistId) {
    where.push('t.rel_path IN (SELECT rel_path FROM playlist_items WHERE playlist_id = ?)')
    params.push(q.playlistId)
  }
  if (q.recentlyAdded) {
    where.push('t.added_at > ?')
    params.push(Date.now() - 30 * 24 * 3600 * 1000)
  }
  if (q.liked) where.push(TRACK_LIKED_SQL)
  if (q.played === 'most') where.push('coalesce(ps.play_count, 0) > 0')
  if (q.played === 'recent') where.push('ps.last_played IS NOT NULL')
  if (q.played === 'never') where.push('coalesce(ps.play_count, 0) = 0')
  const w = where.length ? `WHERE ${where.join(' AND ')}` : ''
  let order = ALBUM_ORDER
  if (q.playlistId) order = `(SELECT min(pos) FROM playlist_items pi WHERE pi.playlist_id = '${q.playlistId.replace(/'/g, "''")}' AND pi.rel_path = t.rel_path)`
  if (q.recentlyAdded) order = 't.added_at DESC, ' + ALBUM_ORDER
  if (q.liked) order = 'liked_at DESC, ' + ALBUM_ORDER
  if (q.ripGame) order = 't.youtube_uploaded IS NULL, t.youtube_uploaded, coalesce(t.title_sort, t.title) COLLATE NOCASE'
  if (q.played === 'most') order = 'play_count DESC, last_played DESC'
  if (q.played === 'recent') order = 'last_played DESC'
  if (q.played === 'never') order = SORT_COLUMNS.title!
  if (q.sort && SORT_COLUMNS[q.sort.key]) order = `${SORT_COLUMNS[q.sort.key]} ${q.sort.dir === 'desc' ? 'DESC' : 'ASC'}, ${ALBUM_ORDER}`
  // The played filters read play_stats, so the count needs the same join.
  const from = q.played ? `tracks t LEFT JOIN play_stats ps ON ps.track_key = ${trackKeySql('t')}` : 'tracks t'
  let total = (db.prepare(`SELECT count(*) n FROM ${from} ${w}`).get(...params) as { n: number }).n
  let limit = q.limit ?? 100000
  const offset = q.offset ?? 0
  // Recently and most played are top-100 lists (the phone's too).
  if (q.played === 'most' || q.played === 'recent') {
    total = Math.min(total, PLAYED_TOP)
    limit = Math.max(0, Math.min(limit, total - offset))
  }
  const rows = db.prepare(`${TRACK_SELECT} ${w} ORDER BY ${order} LIMIT ? OFFSET ?`).all(...params, limit, offset)
  return { rows: (rows as Record<string, any>[]).map(toTrackRow), total }
}

/** Recently and most played list the top 100 songs, as on the phone. */
const PLAYED_TOP = 100

/**
 * The listening history: every play from every device (skips left out), newest first, with the
 * song it was. Plays of songs no longer in the library are dropped.
 */
export function listeningHistory(db: DB, limit = 300): HistoryEntry[] {
  const rows = db
    .prepare(
      `SELECT p.track_key, p.played_at, p.device_id FROM plays p
       WHERE p.skipped = 0 AND p.track_key IN (SELECT ${trackKeySql('t')} FROM tracks t)
       ORDER BY p.played_at DESC LIMIT ?`,
    )
    .all(limit) as Array<{ track_key: string; played_at: number; device_id: string }>
  if (!rows.length) return []
  const keys = [...new Set(rows.map((r) => r.track_key))]
  const tracks = db
    .prepare(`${TRACK_SELECT} WHERE ${trackKeySql('t')} IN (SELECT value FROM json_each(?))`)
    .all(JSON.stringify(keys)) as Record<string, any>[]
  const byKey = new Map(tracks.map((r) => [(r.valence_id as string | null) ?? `path:${r.rel_path as string}`, toTrackRow(r)]))
  const out: HistoryEntry[] = []
  for (const r of rows) {
    const track = byKey.get(r.track_key)
    if (track) out.push({ track, playedAt: r.played_at, deviceId: r.device_id })
  }
  return out
}

/** Games that have rips, with how many and a cover (SiivaGunner → Games, as on the phone). */
export function ripGames(db: DB): RipGameRow[] {
  const rows = db
    .prepare(
      `SELECT t.rip_game AS name, count(*) AS n, max(t.art_hash) AS art
       FROM tracks t WHERE t.hq_rip <> '' AND t.rip_game IS NOT NULL AND t.rip_game <> ''
       GROUP BY t.rip_game COLLATE NOCASE ORDER BY t.rip_game COLLATE NOCASE`,
    )
    .all() as Array<{ name: string; n: number; art: string | null }>
  return rows.map((r) => ({ name: r.name, trackCount: r.n, artHash: r.art }))
}

/** Lower case without accents, so "pokemon" finds "Pokémon". */
const fold = (s: string) => s.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
const words = (s: string) => fold(s).split(/[^\p{L}\p{N}]+/u).filter(Boolean)

/** Games whose name has a word starting with each search word (as FTS matches), most rips first. */
export function searchRipGames(db: DB, text: string, limit = 12): RipGameRow[] {
  const terms = words(text).slice(0, 8)
  if (!terms.length) return []
  return ripGames(db)
    .filter((g) => {
      const name = words(g.name)
      return terms.every((t) => name.some((w) => w.startsWith(t)))
    })
    .sort((a, b) => b.trackCount - a.trackCount)
    .slice(0, limit)
}

/**
 * The search box, for one half of the library (or both): songs (the first 50, and how many in
 * all), albums, artists and, for rips, games. A rip album (a season or volume) only matches on its
 * own title, since nearly any search would otherwise turn up every season.
 */
export function searchLibrary(db: DB, text: string, collection: LibraryCollection = 'main'): SearchResult {
  const { rows: tracks, total: trackTotal } = queryTracks(db, { search: text, limit: 50, collection })
  let albums: AlbumRow[]
  if (collection === 'rips') {
    const fts = ftsQuery(text)
    albums = fts
      ? (db
          .prepare(
            `${ALBUM_SELECT} WHERE a.hq_rip <> '' AND a.id IN (SELECT album_id FROM tracks WHERE id IN (SELECT rowid FROM tracks_fts WHERE tracks_fts MATCH ?))
             GROUP BY a.id ORDER BY a.year, a.title COLLATE NOCASE, a.id LIMIT 24`,
          )
          .all(`{album album_artist} : (${fts})`) as Record<string, any>[]).map(toAlbumRow)
      : []
  } else albums = queryAlbums(db, { search: text, limit: 24, collection })
  return {
    tracks,
    trackTotal,
    albums,
    // Every rip is by SiIvaGunner, so rips list games instead of artists.
    artists: collection === 'rips' ? [] : queryArtists(db, { search: text, collection }).slice(0, 12),
    games: collection === 'main' ? [] : searchRipGames(db, text),
  }
}

export function trackById(db: DB, id: number): TrackRow | null {
  const r = db.prepare(`${TRACK_SELECT} WHERE t.id = ?`).get(id) as Record<string, any> | undefined
  return r ? toTrackRow(r) : null
}

export function tracksByIds(db: DB, ids: number[]): TrackRow[] {
  if (!ids.length) return []
  const rows = db.prepare(`${TRACK_SELECT} WHERE t.id IN (SELECT value FROM json_each(?))`).all(JSON.stringify(ids)) as Record<string, any>[]
  const byId = new Map(rows.map((r) => [r.id as number, toTrackRow(r)]))
  return ids.map((id) => byId.get(id)).filter((r): r is TrackRow => !!r)
}

function toAlbumRow(r: Record<string, any>): AlbumRow {
  return {
    id: r.id,
    title: r.title,
    albumArtist: r.album_artist,
    year: r.year,
    trackCount: r.track_count,
    trackTotal: r.track_total,
    durationMs: r.duration_ms ?? 0,
    artHash: r.art_hash,
    relDir: r.rel_dir,
    genre: r.genre,
    addedAt: r.added_at,
    compilation: !!r.compilation,
    hqRip: r.hq_rip ?? '',
    liked: !!r.liked,
  }
}

const ALBUM_SELECT = `
  SELECT a.*, count(t.id) AS track_count, sum(t.duration_ms) AS duration_ms,
    (SELECT f.liked FROM favorites f WHERE f.kind = 'a' AND f.item_key = a.album_key) AS liked,
    (SELECT f.at FROM favorites f WHERE f.kind = 'a' AND f.item_key = a.album_key AND f.liked = 1) AS liked_at
  FROM albums a JOIN tracks t ON t.album_id = a.id`

function albumWhere(q: AlbumQuery): { w: string; params: unknown[]; order: string } {
  const where: string[] = []
  const params: unknown[] = []
  const coll = collectionWhere('a', q.collection ?? (q.liked ? 'all' : 'main'), q.ripKinds, params)
  if (coll) where.push(coll)
  if (q.albumArtist) {
    where.push('a.album_artist = ? COLLATE NOCASE')
    params.push(q.albumArtist)
  }
  if (q.genre) {
    where.push('a.genre = ? COLLATE NOCASE')
    params.push(q.genre)
  }
  if (q.search) {
    const fts = ftsQuery(q.search)
    if (fts) {
      where.push('a.id IN (SELECT album_id FROM tracks WHERE id IN (SELECT rowid FROM tracks_fts WHERE tracks_fts MATCH ?))')
      params.push(fts)
    }
  }
  if (q.liked) where.push(ALBUM_LIKED_SQL)
  const sort = q.sort ?? (q.liked ? 'likedAt' : 'artist')
  const order =
    sort === 'title'
      ? 'a.title COLLATE NOCASE'
      : sort === 'year'
        ? 'a.year DESC, a.album_artist COLLATE NOCASE'
        : sort === 'added'
          ? 'a.added_at DESC'
          : sort === 'likedAt'
            ? 'liked_at DESC, a.album_artist COLLATE NOCASE, a.year, a.title COLLATE NOCASE'
            : 'a.album_artist COLLATE NOCASE, a.year, a.title COLLATE NOCASE'
  // The id tiebreak keeps pages stable.
  return { w: where.length ? `WHERE ${where.join(' AND ')}` : '', params, order: `${order}, a.id` }
}

export function queryAlbums(db: DB, q: AlbumQuery = {}): AlbumRow[] {
  const { w, params, order } = albumWhere(q)
  const rows = db
    .prepare(`${ALBUM_SELECT} ${w} GROUP BY a.id ORDER BY ${order} LIMIT ? OFFSET ?`)
    .all(...params, q.limit ?? 100000, Math.max(0, q.offset ?? 0))
  return (rows as Record<string, any>[]).map(toAlbumRow)
}

/** One page of albums plus the total matching the query (for chunked loading; default limit 200). */
export function queryAlbumsPage(db: DB, q: AlbumQuery = {}): AlbumsPage {
  const { w, params } = albumWhere(q)
  const total = (
    db.prepare(`SELECT count(*) AS n FROM albums a ${w ? `${w} AND` : 'WHERE'} EXISTS (SELECT 1 FROM tracks t WHERE t.album_id = a.id)`).get(...params) as { n: number }
  ).n
  return { rows: queryAlbums(db, { ...q, limit: q.limit ?? 200 }), total }
}

export function albumById(db: DB, id: number): AlbumRow | null {
  const r = db.prepare(`${ALBUM_SELECT} WHERE a.id = ? GROUP BY a.id`).get(id) as Record<string, any> | undefined
  return r ? toAlbumRow(r) : null
}

/** Albums in the order given (unknown ids are skipped). */
export function albumsByIds(db: DB, ids: number[]): AlbumRow[] {
  if (!ids.length) return []
  const rows = db.prepare(`${ALBUM_SELECT} WHERE a.id IN (SELECT value FROM json_each(?)) GROUP BY a.id`).all(JSON.stringify(ids)) as Record<string, any>[]
  const byId = new Map(rows.map((r) => [r.id as number, toAlbumRow(r)]))
  return ids.map((id) => byId.get(id)).filter((r): r is AlbumRow => !!r)
}

export function likedArtistKeys(db: DB): Set<string> {
  const rows = db.prepare("SELECT item_key FROM favorites WHERE kind = 'r' AND liked = 1").all() as Array<{ item_key: string }>
  return new Set(rows.map((r) => r.item_key))
}

export function queryArtists(
  db: DB,
  q: { search?: string; collection?: LibraryCollection; liked?: boolean; names?: string[] } = {},
): ArtistRow[] {
  const params: unknown[] = []
  const where: string[] = []
  // Liked artists default to every collection (like liked tracks and albums).
  const collection = q.collection ?? (q.liked ? 'all' : 'main')
  const coll = collectionWhere('t', collection)
  const artColl = collectionWhere('a', collection)
  if (coll) where.push(coll)
  if (q.search) {
    where.push('album_artist LIKE ?')
    params.push(`%${q.search}%`)
  }
  if (q.names) {
    where.push('t.album_artist COLLATE NOCASE IN (SELECT value FROM json_each(?))')
    params.push(JSON.stringify(q.names))
  }
  const w = where.length ? `WHERE ${where.join(' AND ')}` : ''
  const rows = db
    .prepare(
      `SELECT album_artist AS name, count(DISTINCT album_id) AS album_count, count(*) AS track_count,
         (SELECT a.art_hash FROM albums a WHERE a.album_artist = t.album_artist${artColl ? ` AND ${artColl}` : ''} AND a.art_hash IS NOT NULL ORDER BY a.year DESC LIMIT 1) AS art_hash
       FROM tracks t ${w} GROUP BY album_artist COLLATE NOCASE ORDER BY coalesce(max(album_artist_sort), album_artist) COLLATE NOCASE`,
    )
    .all(...params) as Array<{ name: string; album_count: number; track_count: number; art_hash: string | null }>
  const liked = likedArtistKeys(db)
  const out = rows.map((r) => ({
    name: r.name,
    albumCount: r.album_count,
    trackCount: r.track_count,
    artHash: r.art_hash,
    liked: liked.size > 0 && liked.has(artistFavoriteKey(r.name)),
  }))
  return q.liked ? out.filter((a) => a.liked) : out
}

/** Liked items that exist in the library: in every collection, or only normal music or only rips. */
export function favoriteCounts(db: DB, collection: LibraryCollection = 'all'): FavoriteCounts {
  const tc = collectionWhere('t', collection)
  const ac = collectionWhere('a', collection)
  const tracks = (db.prepare(`SELECT count(*) AS n FROM tracks t WHERE ${TRACK_LIKED_SQL}${tc ? ` AND ${tc}` : ''}`).get() as { n: number }).n
  const albums = (
    db
      .prepare(`SELECT count(*) AS n FROM albums a WHERE ${ALBUM_LIKED_SQL}${ac ? ` AND ${ac}` : ''} AND EXISTS (SELECT 1 FROM tracks t WHERE t.album_id = a.id)`)
      .get() as { n: number }
  ).n
  const liked = likedArtistKeys(db)
  const seen = new Set<string>()
  if (liked.size) {
    for (const { name } of db.prepare(`SELECT DISTINCT album_artist AS name FROM tracks t${tc ? ` WHERE ${tc}` : ''}`).all() as Array<{ name: string }>) {
      const k = artistFavoriteKey(name)
      if (liked.has(k)) seen.add(k)
    }
  }
  return { tracks, albums, artists: seen.size }
}

export function queryGenres(db: DB, q: { collection?: LibraryCollection } = {}): GenreRow[] {
  const coll = collectionWhere('t', q.collection ?? 'main')
  const rows = db
    .prepare(
      `SELECT genre AS name, count(*) AS track_count, count(DISTINCT album_id) AS album_count
       FROM tracks t WHERE genre IS NOT NULL AND genre <> ''${coll ? ` AND ${coll}` : ''} GROUP BY genre COLLATE NOCASE ORDER BY genre COLLATE NOCASE`,
    )
    .all() as Array<{ name: string; track_count: number; album_count: number }>
  return rows.map((r) => ({ name: r.name, trackCount: r.track_count, albumCount: r.album_count }))
}

export function libraryStats(db: DB, libraryRoot: string, scanning: boolean): LibraryStats {
  const r = db
    .prepare(
      `SELECT count(*) tracks, count(DISTINCT album_id) albums, count(DISTINCT album_artist COLLATE NOCASE) artists,
         coalesce(sum(duration_ms), 0) duration, coalesce(sum(size), 0) bytes FROM tracks WHERE hq_rip = ''`,
    )
    .get() as { tracks: number; albums: number; artists: number; duration: number; bytes: number }
  const rips = db.prepare(`SELECT count(*) tracks, count(DISTINCT album_id) albums FROM tracks WHERE hq_rip <> ''`).get() as { tracks: number; albums: number }
  return { tracks: r.tracks, albums: r.albums, artists: r.artists, durationMs: r.duration, bytes: r.bytes, ripTracks: rips.tracks, ripAlbums: rips.albums, libraryRoot, scanning }
}
