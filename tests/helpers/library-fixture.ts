// Fast library fixtures: rows inserted straight into a (sandboxed or in-memory) index DB, no audio files.

import type { DB } from '@main/db/db'
import { pathKey } from '@main/library/indexer'

export interface FixtureAlbum {
  key?: string
  title: string
  artist: string
  relDir?: string
  year?: number | null
  genre?: string | null
  artHash?: string | null
  addedAt?: number
  hqRip?: string
}

export function insertAlbum(db: DB, a: FixtureAlbum): number {
  const relDir = a.relDir ?? `${a.artist}/${a.title}`
  return Number(
    db
      .prepare('INSERT INTO albums(album_key, title, album_artist, rel_dir, year, genre, art_hash, added_at, hq_rip) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(a.key ?? `${relDir.toLowerCase()}|${a.title.toLowerCase()}`, a.title, a.artist, relDir, a.year ?? null, a.genre ?? null, a.artHash ?? null, a.addedAt ?? 1, a.hqRip ?? '')
      .lastInsertRowid,
  )
}

export interface FixtureTrack {
  rel: string
  title: string
  artist?: string
  albumArtist?: string
  album?: string
  albumId?: number | null
  valenceId?: string | null
  genre?: string | null
  year?: number | null
  trackNo?: number | null
  codec?: string
  bitrate?: number
  lossless?: boolean
  sampleRate?: number
  bitDepth?: number
  durationMs?: number
  rating?: number
  addedAt?: number
  hqRip?: string
  artHash?: string | null
  compilation?: boolean
}

let insertStmt: { db: DB; stmt: ReturnType<DB['prepare']> } | null = null

export function insertTrack(db: DB, t: FixtureTrack): number {
  if (insertStmt?.db !== db) {
    insertStmt = {
      db,
      stmt: db.prepare(
        `INSERT INTO tracks(valence_id, rel_path, path_key, size, mtime_ms, duration_ms, codec, bitrate, sample_rate, bit_depth, lossless,
           title, artist, album, album_artist, track_no, year, genre, compilation, rating, art_hash, album_id, added_at, scanned_at, hq_rip)
         VALUES (@valence_id, @rel_path, @path_key, 1000, 1, @duration_ms, @codec, @bitrate, @sample_rate, @bit_depth, @lossless,
           @title, @artist, @album, @album_artist, @track_no, @year, @genre, @compilation, @rating, @art_hash, @album_id, @added_at, @added_at, @hq_rip)`,
      ),
    }
  }
  const albumArtist = t.albumArtist ?? t.artist ?? ''
  return Number(
    insertStmt.stmt.run({
      valence_id: t.valenceId ?? null,
      rel_path: t.rel,
      path_key: pathKey(t.rel),
      duration_ms: t.durationMs ?? 200_000,
      codec: t.codec ?? 'mp3',
      bitrate: t.bitrate ?? 320_000,
      sample_rate: t.sampleRate ?? 44100,
      bit_depth: t.bitDepth ?? 0,
      lossless: t.lossless ? 1 : 0,
      title: t.title,
      artist: t.artist ?? albumArtist,
      album: t.album ?? '',
      album_artist: albumArtist,
      track_no: t.trackNo ?? null,
      year: t.year ?? null,
      genre: t.genre ?? null,
      compilation: t.compilation ? 1 : 0,
      rating: t.rating ?? 0,
      art_hash: t.artHash ?? null,
      album_id: t.albumId ?? null,
      added_at: t.addedAt ?? 1,
      hq_rip: t.hqRip ?? '',
    }).lastInsertRowid,
  )
}

let playSeq = 0

/** One row in the plays table (as if ingested from a device log). */
export function insertPlay(db: DB, p: { key: string; at: number; ms?: number; skipped?: boolean; device?: string }): void {
  playSeq++
  db.prepare('INSERT INTO plays(device_id, hlc, track_key, played_at, ms, completed, skipped) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    p.device ?? 'fixture',
    `${p.at.toString(36).padStart(9, '0')}-${playSeq.toString(36).padStart(4, '0')}-fixture`,
    p.key,
    p.at,
    p.ms ?? 180_000,
    p.skipped ? 0 : 1,
    p.skipped ? 1 : 0,
  )
}

/** The plays/favorites key of a track row. */
export function trackKey(db: DB, id: number): string {
  return (db.prepare("SELECT coalesce(valence_id, 'path:' || rel_path) AS k FROM tracks WHERE id = ?").get(id) as { k: string }).k
}
