// Read-side queries backing the library views.

import type { AlbumRow, ArtistRow, GenreRow, LibraryCollection, LibraryStats, TrackQuery, TrackRow } from '@shared/types'
import type { DB } from '@main/db/db'

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
  SELECT t.*, coalesce(ps.play_count, 0) AS play_count, ps.last_played AS last_played
  FROM tracks t
  LEFT JOIN play_stats ps ON ps.track_key = coalesce(t.valence_id, 'path:' || t.rel_path)`

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
  const coll = collectionWhere('t', q.collection ?? (q.albumId !== undefined || q.playlistId ? 'all' : 'main'), q.ripKinds, params)
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
  if (q.playlistId) {
    where.push('t.rel_path IN (SELECT rel_path FROM playlist_items WHERE playlist_id = ?)')
    params.push(q.playlistId)
  }
  if (q.recentlyAdded) {
    where.push('t.added_at > ?')
    params.push(Date.now() - 30 * 24 * 3600 * 1000)
  }
  const w = where.length ? `WHERE ${where.join(' AND ')}` : ''
  let order = ALBUM_ORDER
  if (q.playlistId) order = `(SELECT min(pos) FROM playlist_items pi WHERE pi.playlist_id = '${q.playlistId.replace(/'/g, "''")}' AND pi.rel_path = t.rel_path)`
  if (q.recentlyAdded) order = 't.added_at DESC, ' + ALBUM_ORDER
  if (q.sort && SORT_COLUMNS[q.sort.key]) order = `${SORT_COLUMNS[q.sort.key]} ${q.sort.dir === 'desc' ? 'DESC' : 'ASC'}, ${ALBUM_ORDER}`
  const total = (db.prepare(`SELECT count(*) n FROM tracks t ${w}`).get(...params) as { n: number }).n
  const limit = q.limit ?? 100000
  const rows = db.prepare(`${TRACK_SELECT} ${w} ORDER BY ${order} LIMIT ? OFFSET ?`).all(...params, limit, q.offset ?? 0)
  return { rows: (rows as Record<string, any>[]).map(toTrackRow), total }
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
  }
}

const ALBUM_SELECT = `
  SELECT a.*, count(t.id) AS track_count, sum(t.duration_ms) AS duration_ms
  FROM albums a JOIN tracks t ON t.album_id = a.id`

export function queryAlbums(
  db: DB,
  q: {
    albumArtist?: string
    genre?: string
    search?: string
    sort?: 'artist' | 'title' | 'year' | 'added'
    limit?: number
    collection?: LibraryCollection
    ripKinds?: string[]
  } = {},
): AlbumRow[] {
  const where: string[] = []
  const params: unknown[] = []
  const coll = collectionWhere('a', q.collection ?? 'main', q.ripKinds, params)
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
  const order =
    q.sort === 'title'
      ? 'a.title COLLATE NOCASE'
      : q.sort === 'year'
        ? 'a.year DESC, a.album_artist COLLATE NOCASE'
        : q.sort === 'added'
          ? 'a.added_at DESC'
          : 'a.album_artist COLLATE NOCASE, a.year, a.title COLLATE NOCASE'
  const w = where.length ? `WHERE ${where.join(' AND ')}` : ''
  const rows = db.prepare(`${ALBUM_SELECT} ${w} GROUP BY a.id ORDER BY ${order} LIMIT ?`).all(...params, q.limit ?? 100000)
  return (rows as Record<string, any>[]).map(toAlbumRow)
}

export function albumById(db: DB, id: number): AlbumRow | null {
  const r = db.prepare(`${ALBUM_SELECT} WHERE a.id = ? GROUP BY a.id`).get(id) as Record<string, any> | undefined
  return r ? toAlbumRow(r) : null
}

export function queryArtists(db: DB, q: { search?: string; collection?: LibraryCollection } = {}): ArtistRow[] {
  const params: unknown[] = []
  const where: string[] = []
  const coll = collectionWhere('t', q.collection ?? 'main')
  const artColl = collectionWhere('a', q.collection ?? 'main')
  if (coll) where.push(coll)
  if (q.search) {
    where.push('album_artist LIKE ?')
    params.push(`%${q.search}%`)
  }
  const w = where.length ? `WHERE ${where.join(' AND ')}` : ''
  const rows = db
    .prepare(
      `SELECT album_artist AS name, count(DISTINCT album_id) AS album_count, count(*) AS track_count,
         (SELECT a.art_hash FROM albums a WHERE a.album_artist = t.album_artist${artColl ? ` AND ${artColl}` : ''} AND a.art_hash IS NOT NULL ORDER BY a.year DESC LIMIT 1) AS art_hash
       FROM tracks t ${w} GROUP BY album_artist COLLATE NOCASE ORDER BY coalesce(max(album_artist_sort), album_artist) COLLATE NOCASE`,
    )
    .all(...params) as Array<{ name: string; album_count: number; track_count: number; art_hash: string | null }>
  return rows.map((r) => ({ name: r.name, albumCount: r.album_count, trackCount: r.track_count, artHash: r.art_hash }))
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
