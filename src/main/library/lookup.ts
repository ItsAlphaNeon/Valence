// "Already in library?" checks for TIDAL/Bandcamp browse views: source ids, then ISRC/UPC, then
// normalized artist+title(+duration) matching.

import type { InLibraryBadge } from '@shared/types'
import type { BadgeQueryAlbum, BadgeQueryTrack, LibraryLookup } from '@main/context'
import { matchKey } from '@shared/sanitize'
import { primaryArtist } from '@shared/artist-credit'
import type { DB } from '@main/db/db'

/** Strips bracketed qualifiers ("(Remastered 2011)", "[Explicit]", "- Radio Edit") for a looser title key. */
export function looseTitleKey(title: string | undefined): string {
  const t = (title ?? '')
    .replace(/\s*[([][^)\]]*(remaster|explicit|clean|edit|version|mono|stereo|deluxe|bonus|live|mix)[^)\]]*[)\]]/gi, '')
    .replace(/\s+-\s+.*(remaster|edit|version|mix).*$/i, '')
  return matchKey(t)
}

function artistMatches(a: string, b: string): boolean {
  const ka = matchKey(a)
  const kb = matchKey(b)
  if (!ka || !kb) return false
  if (ka === kb) return true
  const pa = matchKey(primaryArtist(a))
  const pb = matchKey(primaryArtist(b))
  return pa === pb || ka.startsWith(pb + ' ') || kb.startsWith(pa + ' ')
}

interface Cand {
  id: number
  rel_path: string
  artist: string
  album_artist: string
  title: string
  duration_ms: number
}

export interface LibraryLookupEx extends LibraryLookup {
  /** Library-relative path of the best matching track, or null. */
  resolve(track: BadgeQueryTrack): string | null
}

export function createLibraryLookup(db: DB): LibraryLookupEx {
  const byTidal = db.prepare('SELECT rel_path FROM tracks WHERE tidal_track_id = ? LIMIT 1')
  const byBandcamp = db.prepare('SELECT rel_path FROM tracks WHERE bandcamp_track_id = ? LIMIT 1')
  // Fuzzy matches (ISRC, title, barcode, artist) never land on a rip: a rip is not the song it parodies.
  const byIsrc = db.prepare("SELECT rel_path FROM tracks WHERE isrc = ? AND hq_rip = '' LIMIT 1")
  const byTitle = db.prepare("SELECT id, rel_path, artist, album_artist, title, duration_ms FROM tracks WHERE match_title = ? AND hq_rip = '' LIMIT 50")
  const albumByTidal = db.prepare('SELECT count(*) n FROM tracks WHERE tidal_album_id = ?')
  const albumByBandcamp = db.prepare('SELECT count(*) n FROM tracks WHERE bandcamp_item_id = ?')
  const albumByBarcode = db.prepare("SELECT id FROM albums WHERE barcode = ? AND hq_rip = '' LIMIT 1")
  const albumsByTitle = db.prepare("SELECT id, album_artist FROM albums WHERE match_title = ? AND hq_rip = '' LIMIT 20")
  const albumCount = db.prepare('SELECT count(*) n FROM tracks WHERE album_id = ?')
  const artistCount = db.prepare(
    "SELECT count(*) n FROM tracks WHERE hq_rip = '' AND (match_artist = @k OR album_id IN (SELECT id FROM albums WHERE match_artist = @k))",
  )

  const fuzzy = (t: BadgeQueryTrack): string | null => {
    const keys = [matchKey(t.title), looseTitleKey(t.title)].filter((k, i, a) => k && a.indexOf(k) === i)
    for (const key of keys) {
      for (const c of byTitle.all(key) as Cand[]) {
        const artistOk =
          (t.artist && (artistMatches(t.artist, c.artist) || artistMatches(t.artist, c.album_artist))) ||
          (t.albumArtist && artistMatches(t.albumArtist, c.album_artist))
        if (!artistOk) continue
        if (t.durationMs && c.duration_ms && Math.abs(t.durationMs - c.duration_ms) > 4000) continue
        return c.rel_path
      }
    }
    return null
  }

  type PathRow = { rel_path: string } | undefined
  const resolve = (t: BadgeQueryTrack): string | null => {
    if (t.tidalTrackId) {
      const r = byTidal.get(String(t.tidalTrackId)) as PathRow
      if (r) return r.rel_path
    }
    if (t.bandcampTrackId) {
      const r = byBandcamp.get(String(t.bandcampTrackId)) as PathRow
      if (r) return r.rel_path
    }
    if (t.isrc) {
      const r = byIsrc.get(t.isrc.toUpperCase()) as PathRow
      if (r) return r.rel_path
    }
    return fuzzy(t)
  }
  const matchOne = (t: BadgeQueryTrack): boolean => resolve(t) !== null

  const badge = (have: number, total: number): InLibraryBadge => {
    const h = Math.min(have, total || have)
    return { status: h === 0 ? 'missing' : total && h >= total ? 'in-library' : 'partial', have: h, total: total || h }
  }

  const albumBadge = (a: BadgeQueryAlbum): InLibraryBadge => {
    if (a.tracks?.length) {
      const have = a.tracks.filter(matchOne).length
      return badge(have, a.tracks.length)
    }
    const total = a.trackCount ?? 0
    if (a.tidalAlbumId) {
      const n = (albumByTidal.get(String(a.tidalAlbumId)) as { n: number }).n
      if (n) return badge(n, total)
    }
    if (a.bandcampAlbumId) {
      const n = (albumByBandcamp.get(String(a.bandcampAlbumId)) as { n: number }).n
      if (n) return badge(n, total)
    }
    if (a.upc) {
      const row = albumByBarcode.get(a.upc) as { id: number } | undefined
      if (row) return badge((albumCount.get(row.id) as { n: number }).n, total)
    }
    if (a.title) {
      const keys = [matchKey(a.title), looseTitleKey(a.title)].filter((k, i, arr) => k && arr.indexOf(k) === i)
      for (const key of keys) {
        for (const row of albumsByTitle.all(key) as Array<{ id: number; album_artist: string }>) {
          if (a.albumArtist && !artistMatches(a.albumArtist, row.album_artist)) continue
          return badge((albumCount.get(row.id) as { n: number }).n, total)
        }
      }
    }
    return badge(0, total)
  }

  return {
    resolve,
    matchTracks: (tracks) => tracks.map(matchOne),
    albumBadge,
    albumBadges: (albums) => albums.map(albumBadge),
    artistTracks: (names) =>
      names.map((name) => {
        const k = matchKey(name)
        return k ? (artistCount.get({ k }) as { n: number }).n : 0
      }),
  }
}
