// Finds an existing library copy of "the same track on the same release" and decides between
// adding, upgrading (replace with better quality) and skipping. A single and the album version of
// the same recording are different library entries (singles get their own folder).

import type { TrackTags, AudioFormat } from '@shared/types'
import { decodeSourceQuality, isUpgrade, type QualityInfo } from '@shared/quality'
import { matchKey } from '@shared/sanitize'
import { primaryArtist } from '@shared/artist-credit'
import type { DB } from '@main/db/db'
import { looseTitleKey } from '@main/library/lookup'

export interface ExistingTrack {
  id: number
  rel_path: string
  valence_id: string | null
  source_quality: string | null
  lossless: number
  codec: string | null
  bitrate: number
  sample_rate: number
  bit_depth: number
  duration_ms: number
  album: string
  album_artist: string
  artist: string
  title: string
  owner_device: string | null
}

const COLS = 'id, rel_path, valence_id, source_quality, lossless, codec, bitrate, sample_rate, bit_depth, duration_ms, album, album_artist, artist, title, owner_device'

export function existingQuality(t: ExistingTrack): QualityInfo {
  return decodeSourceQuality(t.source_quality) ?? { lossless: !!t.lossless, codec: t.codec ?? undefined, bitrate: t.bitrate, sampleRate: t.sample_rate, bitDepth: t.bit_depth }
}

export function formatQuality(f: AudioFormat): QualityInfo {
  return { lossless: f.lossless, codec: f.codec, bitrate: f.bitrate, sampleRate: f.sampleRate, bitDepth: f.bitDepth }
}

function sameAlbum(a: string, b: string): boolean {
  const ka = looseTitleKey(a)
  const kb = looseTitleKey(b)
  return !!ka && ka === kb
}

function sameArtist(a: string, b: string): boolean {
  const ka = matchKey(a)
  const kb = matchKey(b)
  return ka === kb || matchKey(primaryArtist(a)) === matchKey(primaryArtist(b))
}

export function findExisting(db: DB, tags: TrackTags, durationMs: number): ExistingTrack | null {
  const one = (sql: string, ...p: unknown[]) => db.prepare(`SELECT ${COLS} FROM tracks WHERE ${sql} LIMIT 1`).get(...p) as ExistingTrack | undefined
  const many = (sql: string, ...p: unknown[]) => db.prepare(`SELECT ${COLS} FROM tracks WHERE ${sql} LIMIT 50`).all(...p) as ExistingTrack[]
  if (tags.valence_id) {
    const r = one('valence_id = ?', tags.valence_id)
    if (r) return r
  }
  if (tags.tidal_track_id) {
    const r = one('tidal_track_id = ?', tags.tidal_track_id)
    if (r) return r
  }
  if (tags.bandcamp_track_id) {
    const r = one('bandcamp_track_id = ?', tags.bandcamp_track_id)
    if (r) return r
  }
  if (tags.musicbrainz_trackid) {
    const r = one('mb_track_id = ?', tags.musicbrainz_trackid)
    if (r) return r
  }
  if (tags.musicbrainz_recordingid && tags.musicbrainz_releasegroupid) {
    const r = one('mb_recording_id = ? AND mb_release_group_id = ?', tags.musicbrainz_recordingid, tags.musicbrainz_releasegroupid)
    if (r) return r
  }
  const album = tags.album ?? ''
  if (tags.isrc) {
    const r = many('isrc = ?', tags.isrc.toUpperCase()).find((t) => sameAlbum(t.album, album))
    if (r) return r
  }
  const title = matchKey(tags.title)
  if (!title) return null
  const artist = tags.artist ?? tags.albumartist ?? ''
  return (
    many('match_title = ?', title).find(
      (t) =>
        sameAlbum(t.album, album) &&
        (sameArtist(t.artist, artist) || sameArtist(t.album_artist, tags.albumartist ?? artist)) &&
        (!durationMs || !t.duration_ms || Math.abs(t.duration_ms - durationMs) <= 3000),
    ) ?? null
  )
}

export type DedupeDecision =
  | { kind: 'add' }
  | { kind: 'upgrade'; existing: ExistingTrack }
  | { kind: 'skip'; existing: ExistingTrack; reason: string }

export function decide(db: DB, tags: TrackTags, durationMs: number, incoming: QualityInfo): DedupeDecision {
  const existing = findExisting(db, tags, durationMs)
  if (!existing) return { kind: 'add' }
  if (isUpgrade(incoming, existingQuality(existing))) return { kind: 'upgrade', existing }
  return { kind: 'skip', existing, reason: 'Already in library at equal or better quality' }
}
