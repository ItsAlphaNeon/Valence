// Turns probed files into DB rows and keeps the albums table derived from tracks.

import { createHash } from 'node:crypto'
import type { TrackTags } from '@shared/types'
import type { ProbeResult } from '@main/tags/read'
import { foldKey, matchKey } from '@shared/sanitize'
import { isVariousArtists, VARIOUS_ARTISTS } from '@shared/artist-credit'
import { isSyncedLyrics, multiToString } from '@shared/tag-schema'
import { yearOf } from '@shared/path-template'
import type { DB } from '@main/db/db'

export interface FileStat {
  size: number
  mtimeMs: number
}

export type TrackRecord = Record<string, string | number | null>

export function relDirOf(relPath: string): string {
  const i = relPath.lastIndexOf('/')
  return i < 0 ? '' : relPath.slice(0, i)
}

export function pathKey(relPath: string): string {
  return foldKey(relPath)
}

export function artHashOf(data: Uint8Array): string {
  return createHash('sha1').update(data).digest('hex').slice(0, 20)
}

export function effectiveAlbumArtist(tags: TrackTags): string {
  if (tags.compilation || isVariousArtists(tags.albumartist)) return VARIOUS_ARTISTS
  return tags.albumartist || tags.artist || 'Unknown Artist'
}

/** Groups files of one release: same folder + same album title. Multi-disc releases share a folder in our layout. */
export function albumKeyFor(relPath: string, tags: TrackTags): string {
  return `${foldKey(relDirOf(relPath))}|${matchKey(tags.album || tags.title || '')}`
}

export function trackRecord(relPath: string, st: FileStat, probe: ProbeResult, now = Date.now()): TrackRecord {
  const t = probe.tags
  const f = probe.format
  const y = yearOf(t.date) ?? yearOf(t.originaldate)
  const lyricsKind = t.lyrics ? (isSyncedLyrics(t.lyrics) ? 'synced' : 'plain') : 'none'
  const albumArtist = effectiveAlbumArtist(t)
  return {
    valence_id: t.valence_id ?? null,
    rel_path: relPath,
    path_key: pathKey(relPath),
    size: st.size,
    mtime_ms: Math.round(st.mtimeMs),
    duration_ms: Math.round(f.durationMs),
    container: f.container,
    codec: f.codec,
    bitrate: Math.round(f.bitrate),
    sample_rate: f.sampleRate,
    bit_depth: f.bitDepth,
    channels: f.channels,
    lossless: f.lossless ? 1 : 0,
    title: t.title || stemOf(relPath),
    artist: t.artist || t.albumartist || '',
    artists_json: t.artists?.length ? JSON.stringify(t.artists) : null,
    album: t.album ?? '',
    album_artist: albumArtist,
    artist_sort: t.artistsort ?? null,
    album_artist_sort: t.albumartistsort ?? null,
    title_sort: t.titlesort ?? null,
    album_sort: t.albumsort ?? null,
    track_no: t.tracknumber ?? null,
    track_total: t.totaltracks ?? null,
    disc_no: t.discnumber ?? null,
    disc_total: t.totaldiscs ?? null,
    date: t.date ?? null,
    original_date: t.originaldate ?? null,
    year: y ? Number(y) : null,
    genre: t.genre ?? null,
    compilation: t.compilation || albumArtist === VARIOUS_ARTISTS ? 1 : 0,
    explicit: t.explicit ? 1 : 0,
    isrc: t.isrc?.toUpperCase() ?? null,
    barcode: t.barcode ?? null,
    label: t.label ?? null,
    catalog_no: t.catalognumber ?? null,
    copyright: t.copyright ?? null,
    bpm: t.bpm ?? null,
    music_key: t.key ?? null,
    comment: t.comment ?? null,
    mb_recording_id: t.musicbrainz_recordingid ?? null,
    mb_track_id: t.musicbrainz_trackid ?? null,
    mb_release_id: t.musicbrainz_albumid ?? null,
    mb_release_group_id: t.musicbrainz_releasegroupid ?? null,
    mb_artist_id: t.musicbrainz_artistid?.length ? multiToString(t.musicbrainz_artistid) ?? null : null,
    mb_albumartist_id: t.musicbrainz_albumartistid?.length ? multiToString(t.musicbrainz_albumartistid) ?? null : null,
    acoustid_id: t.acoustid_id ?? null,
    tidal_track_id: t.tidal_track_id ?? null,
    tidal_album_id: t.tidal_album_id ?? null,
    bandcamp_item_id: t.bandcamp_item_id ?? null,
    bandcamp_track_id: t.bandcamp_track_id ?? null,
    bandcamp_url: t.bandcamp_url ?? null,
    source: t.source ?? null,
    source_quality: t.source_quality ?? null,
    owner_device: t.valence_owner ?? null,
    rating: t.rating ?? 0,
    rg_track_gain: t.replaygain_track_gain ?? null,
    rg_track_peak: t.replaygain_track_peak ?? null,
    rg_album_gain: t.replaygain_album_gain ?? null,
    rg_album_peak: t.replaygain_album_peak ?? null,
    lyrics_kind: lyricsKind,
    art_hash: probe.picture ? artHashOf(probe.picture.data) : null,
    match_title: matchKey(t.title || stemOf(relPath)),
    match_artist: matchKey(t.artist || t.albumartist || ''),
    hq_rip: t.hq_rip ?? '',
    composer: t.composer ?? null,
    youtube_video_id: t.youtube_video_id ?? null,
    youtube_uploaded: t.youtube_uploaded ?? null,
    gdrive_file_id: t.gdrive_file_id ?? null,
    hqr_release: t.hqr_release ?? null,
    rip_game: t.rip_game ?? null,
    rip_platform: t.rip_platform ?? null,
    scanned_at: now,
  }
}

function stemOf(relPath: string): string {
  const name = relPath.slice(relPath.lastIndexOf('/') + 1)
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(0, dot) : name
}

const COLS = [
  'valence_id', 'rel_path', 'path_key', 'size', 'mtime_ms', 'duration_ms', 'container', 'codec', 'bitrate', 'sample_rate',
  'bit_depth', 'channels', 'lossless', 'title', 'artist', 'artists_json', 'album', 'album_artist', 'artist_sort',
  'album_artist_sort', 'title_sort', 'album_sort', 'track_no', 'track_total', 'disc_no', 'disc_total', 'date',
  'original_date', 'year', 'genre', 'compilation', 'explicit', 'isrc', 'barcode', 'label', 'catalog_no', 'copyright', 'bpm',
  'music_key', 'comment', 'mb_recording_id', 'mb_track_id', 'mb_release_id', 'mb_release_group_id', 'mb_artist_id',
  'mb_albumartist_id', 'acoustid_id', 'tidal_track_id', 'tidal_album_id', 'bandcamp_item_id', 'bandcamp_track_id',
  'bandcamp_url', 'source', 'source_quality', 'owner_device', 'rating', 'rg_track_gain', 'rg_track_peak', 'rg_album_gain',
  'rg_album_peak', 'lyrics_kind', 'art_hash', 'match_title', 'match_artist', 'hq_rip', 'composer', 'youtube_video_id',
  'youtube_uploaded', 'gdrive_file_id', 'hqr_release', 'rip_game', 'rip_platform', 'scanned_at',
] as const

export class Indexer {
  private insert
  private update
  private byPath
  private byValenceId
  private albumByKey
  private albumInsert
  private albumUpdate
  private albumOfTrack
  private dirtyAlbums = new Set<number>()

  constructor(private db: DB) {
    this.insert = db.prepare(
      `INSERT INTO tracks (${COLS.join(', ')}, added_at, album_id) VALUES (${COLS.map((c) => '@' + c).join(', ')}, @added_at, @album_id)`,
    )
    this.update = db.prepare(`UPDATE tracks SET ${COLS.map((c) => `${c} = @${c}`).join(', ')}, album_id = @album_id WHERE id = @id`)
    this.byPath = db.prepare('SELECT id, album_id FROM tracks WHERE rel_path = ?')
    this.byValenceId = db.prepare('SELECT id, rel_path, album_id, added_at FROM tracks WHERE valence_id = ?')
    this.albumByKey = db.prepare('SELECT id FROM albums WHERE album_key = ?')
    this.albumInsert = db.prepare(
      `INSERT INTO albums (album_key, title, album_artist, rel_dir, added_at) VALUES (?, ?, ?, ?, ?)`,
    )
    this.albumUpdate = db.prepare(`
      UPDATE albums SET
        title = coalesce((SELECT album FROM tracks WHERE album_id = @id AND album <> '' GROUP BY album ORDER BY count(*) DESC LIMIT 1), title),
        album_artist = coalesce((SELECT album_artist FROM tracks WHERE album_id = @id GROUP BY album_artist ORDER BY count(*) DESC LIMIT 1), album_artist),
        year = (SELECT year FROM tracks WHERE album_id = @id AND year IS NOT NULL GROUP BY year ORDER BY count(*) DESC LIMIT 1),
        genre = (SELECT genre FROM tracks WHERE album_id = @id AND genre IS NOT NULL GROUP BY genre ORDER BY count(*) DESC LIMIT 1),
        track_total = (SELECT max(track_total) FROM tracks WHERE album_id = @id),
        disc_total = (SELECT max(coalesce(disc_total, disc_no)) FROM tracks WHERE album_id = @id),
        compilation = (SELECT max(compilation) FROM tracks WHERE album_id = @id),
        hq_rip = (SELECT max(hq_rip) FROM tracks WHERE album_id = @id),
        art_hash = (SELECT art_hash FROM tracks WHERE album_id = @id AND art_hash IS NOT NULL
                    ORDER BY coalesce(disc_no, 1), coalesce(track_no, 999) LIMIT 1),
        mb_release_id = (SELECT max(mb_release_id) FROM tracks WHERE album_id = @id),
        tidal_album_id = (SELECT max(tidal_album_id) FROM tracks WHERE album_id = @id),
        bandcamp_item_id = (SELECT max(bandcamp_item_id) FROM tracks WHERE album_id = @id),
        barcode = (SELECT max(barcode) FROM tracks WHERE album_id = @id),
        added_at = coalesce((SELECT min(added_at) FROM tracks WHERE album_id = @id), added_at)
      WHERE id = @id`)
    this.albumOfTrack = db.prepare('SELECT album_id FROM tracks WHERE id = ?')
  }

  private albumIdFor(relPath: string, tags: TrackTags, now: number): number {
    const key = albumKeyFor(relPath, tags)
    const row = this.albumByKey.get(key) as { id: number } | undefined
    if (row) return row.id
    const title = tags.album || tags.title || 'Unknown Album'
    return Number(this.albumInsert.run(key, title, effectiveAlbumArtist(tags), relDirOf(relPath), now).lastInsertRowid)
  }

  /** Inserts or updates a track. A known VALENCE_ID at a vanished path is treated as a move, keeping the row id. */
  upsert(relPath: string, st: FileStat, probe: ProbeResult, opts: { now?: number; pathExists?: (rel: string) => boolean } = {}): { id: number; kind: 'insert' | 'update' | 'move'; from?: string } {
    const now = opts.now ?? Date.now()
    const rec = trackRecord(relPath, st, probe, now)
    const albumId = this.albumIdFor(relPath, probe.tags, now)
    const existing = this.byPath.get(relPath) as { id: number; album_id: number | null } | undefined
    if (existing) {
      if (existing.album_id && existing.album_id !== albumId) this.dirtyAlbums.add(existing.album_id)
      this.update.run({ ...rec, album_id: albumId, id: existing.id })
      this.dirtyAlbums.add(albumId)
      return { id: existing.id, kind: 'update' }
    }
    if (rec.valence_id) {
      const moved = (this.byValenceId.all(rec.valence_id) as Array<{ id: number; rel_path: string; album_id: number | null }>).find(
        (r) => opts.pathExists && !opts.pathExists(r.rel_path),
      )
      if (moved) {
        if (moved.album_id && moved.album_id !== albumId) this.dirtyAlbums.add(moved.album_id)
        this.update.run({ ...rec, album_id: albumId, id: moved.id })
        this.dirtyAlbums.add(albumId)
        return { id: moved.id, kind: 'move', from: moved.rel_path }
      }
    }
    const id = Number(this.insert.run({ ...rec, added_at: now, album_id: albumId }).lastInsertRowid)
    this.dirtyAlbums.add(albumId)
    return { id, kind: 'insert' }
  }

  removeByPath(relPath: string): boolean {
    const row = this.byPath.get(relPath) as { id: number; album_id: number | null } | undefined
    if (!row) return false
    this.db.prepare('DELETE FROM tracks WHERE id = ?').run(row.id)
    if (row.album_id) this.dirtyAlbums.add(row.album_id)
    return true
  }

  /** Recomputes derived album fields for albums touched since the last call; drops empty albums. */
  flushAlbums(): number[] {
    const ids = [...this.dirtyAlbums]
    this.dirtyAlbums.clear()
    const del = this.db.prepare('DELETE FROM albums WHERE id = ? AND NOT EXISTS (SELECT 1 FROM tracks WHERE album_id = ?)')
    const get = this.db.prepare('SELECT title, album_artist FROM albums WHERE id = ?')
    const setMatch = this.db.prepare('UPDATE albums SET match_title = ?, match_artist = ? WHERE id = ?')
    this.db.transaction(() => {
      for (const id of ids) {
        if (del.run(id, id).changes) continue
        this.albumUpdate.run({ id })
        const a = get.get(id) as { title: string; album_artist: string }
        setMatch.run(matchKey(a.title), matchKey(a.album_artist), id)
      }
    })()
    return ids
  }

  albumIdOfTrack(id: number): number | null {
    return (this.albumOfTrack.get(id) as { album_id: number | null } | undefined)?.album_id ?? null
  }
}
