// Favorites: per-device logs merged last-writer-wins by HLC, liked flags on rows and queries,
// the smart-playlist rule, and the album paging used for chunked loading.

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { sandbox } from '../helpers/sandbox'
import { insertAlbum, insertTrack, trackKey } from '../helpers/library-fixture'
import { openDb, type DB } from '@main/db/db'
import { HlcClock } from '@main/sync/hlc'
import { DeviceLog } from '@main/sync/device-log'
import { artistFavoriteKey, FavoritesLog } from '@main/sync/favorites'
import { favoriteCounts, queryAlbums, queryAlbumsPage, queryArtists, queryTracks, trackById } from '@main/library/queries'
import { smartSql } from '@main/library/playlists'

function device(root: string, id: string, now: () => number) {
  const db = openDb(':memory:')
  const clock = new HlcClock(id, now)
  const favs = new FavoritesLog(db, new DeviceLog(root, id, clock), clock, root)
  return { db, clock, favs }
}

const liked = (db: DB, kind: string, key: string) =>
  (db.prepare('SELECT liked FROM favorites WHERE kind = ? AND item_key = ?').get(kind, key) as { liked: number } | undefined)?.liked ?? null

describe('favorites sync', () => {
  const sb = sandbox('favs')
  const root = join(sb.dir, 'Music')
  let tA = 1_000_000
  let tB = 1_000_000
  const A = device(root, 'deva0000000000', () => tA)
  const B = device(root, 'devb0000000000', () => tB)
  afterAll(() => {
    A.db.close()
    B.db.close()
    sb.cleanup()
  })

  it('appends one event per change to the device favorites log', () => {
    expect(A.favs.set('t', ['v-1', 'v-1', ''], true)).toBe(1)
    // Re-liking changes nothing and logs nothing.
    expect(A.favs.set('t', ['v-1'], true)).toBe(0)
    const dir = join(root, '.valence', 'devices', 'deva0000000000')
    expect(readdirSync(dir)).toContain('favorites.jsonl')
    const lines = readFileSync(join(dir, 'favorites.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatchObject({ kind: 't', k: 'v-1', on: 1 })
    expect(typeof lines[0].hlc).toBe('string')
  })

  it('ingests other devices and converges last-writer-wins', () => {
    expect(B.favs.ingest()).toBe(1)
    expect(liked(B.db, 't', 'v-1')).toBe(1)
    expect(B.favs.ingest()).toBe(0)
    // Own events read back from disk change nothing.
    expect(A.favs.ingest()).toBe(0)

    tB += 10_000
    B.favs.set('t', ['v-1'], false)
    expect(A.favs.ingest()).toBe(1)
    expect(liked(A.db, 't', 'v-1')).toBe(0)

    // Concurrent toggles of the same album: the later HLC wins on both devices.
    tA += 50_000
    tB += 20_000
    A.favs.set('a', ['album-x'], true)
    B.favs.set('a', ['album-x'], true)
    B.favs.set('a', ['album-x'], false) // B's clock is behind A's
    A.favs.ingest()
    B.favs.ingest()
    expect(liked(A.db, 'a', 'album-x')).toBe(1)
    expect(liked(B.db, 'a', 'album-x')).toBe(1)
  })

  it('orders a toggle after anything it has seen, even with a clock far behind', () => {
    tB = 5 // B's clock jumped back
    B.favs.set('a', ['album-x'], false)
    A.favs.ingest()
    expect(liked(A.db, 'a', 'album-x')).toBe(0)
    expect(liked(B.db, 'a', 'album-x')).toBe(0)
    // A fresh DB on a device whose clock is behind still continues after the stored HLCs.
    const C = device(root, 'devc0000000000', () => 1)
    C.favs.ingest()
    C.favs.set('a', ['album-x'], true)
    A.favs.ingest()
    expect(liked(A.db, 'a', 'album-x')).toBe(1)
    C.db.close()
  })

  it('moves a like to a renamed path-keyed track, keeping when it was liked, on every device', () => {
    tA += 1000
    A.favs.set('t', ['path:Old/Song.mp3'], true)
    const at = A.favs.get('t', 'path:Old/Song.mp3')!.at
    B.favs.ingest()
    tA += 1000
    expect(A.favs.moveKey('t', 'path:Old/Song.mp3', 'path:New/Song.mp3')).toBe(true)
    expect(A.favs.get('t', 'path:New/Song.mp3')).toMatchObject({ liked: true, at })
    expect(A.favs.get('t', 'path:Old/Song.mp3')?.liked).toBe(false)
    B.favs.ingest()
    expect(B.favs.get('t', 'path:New/Song.mp3')).toMatchObject({ liked: true, at })
    expect(B.favs.get('t', 'path:Old/Song.mp3')?.liked).toBe(false)
    // Nothing to move when the old key wasn't liked.
    expect(A.favs.moveKey('t', 'path:Nope.mp3', 'path:Other.mp3')).toBe(false)
  })

  it('keys artists case-insensitively (NFC, trimmed)', () => {
    expect(artistFavoriteKey('  Beyoncé ')).toBe(artistFavoriteKey('BEYONCÉ'))
  })
})

describe('liked rows and queries', () => {
  const sb = sandbox('liked')
  const root = join(sb.dir, 'Music')
  let now = 2_000_000_000_000
  const db = openDb(':memory:')
  const clock = new HlcClock('dev10000000000', () => now)
  const favs = new FavoritesLog(db, new DeviceLog(root, 'dev10000000000', clock), clock, root)
  const ids: Record<string, number> = {}
  const albums: Record<string, number> = {}

  beforeAll(() => {
    albums.disc = insertAlbum(db, { title: 'Discovery', artist: 'Daft Punk', year: 2001, addedAt: 10 })
    albums.home = insertAlbum(db, { title: 'Homework', artist: 'Daft Punk', year: 1997, addedAt: 20 })
    albums.ram = insertAlbum(db, { title: 'Random Access Memories', artist: 'Daft Punk', year: 2013, addedAt: 30 })
    albums.rip = insertAlbum(db, { title: 'Rip Album', artist: 'SiIvaGunner', hqRip: 'SiIvaGunner', addedAt: 40 })
    for (let i = 0; i < 25; i++) insertAlbum(db, { title: `Filler ${String(i).padStart(2, '0')}`, artist: `Zed ${i}`, addedAt: 100 + i })
    ids.omt = insertTrack(db, { rel: 'Daft Punk/Discovery/One More Time.mp3', title: 'One More Time', artist: 'Daft Punk', album: 'Discovery', albumId: albums.disc, valenceId: 'v-omt', trackNo: 1 })
    ids.aero = insertTrack(db, { rel: 'Daft Punk/Discovery/Aerodynamic.mp3', title: 'Aerodynamic', artist: 'Daft Punk', album: 'Discovery', albumId: albums.disc, trackNo: 2 })
    ids.da = insertTrack(db, { rel: 'Daft Punk/Homework/Da Funk.mp3', title: 'Da Funk', artist: 'Daft Punk', album: 'Homework', albumId: albums.home })
    ids.gl = insertTrack(db, { rel: 'Daft Punk/RAM/Get Lucky.mp3', title: 'Get Lucky', artist: 'Daft Punk', album: 'Random Access Memories', albumId: albums.ram })
    ids.rip = insertTrack(db, { rel: 'SiIvaGunner/Rip/Rip.mp3', title: 'Rip', artist: 'SiIvaGunner', album: 'Rip Album', albumId: albums.rip, hqRip: 'SiIvaGunner' })
    const all = db.prepare('SELECT id, title, album_artist FROM albums WHERE title LIKE ?').all('Filler%') as Array<{ id: number; title: string; album_artist: string }>
    for (const a of all) insertTrack(db, { rel: `Fill/${a.id}.mp3`, title: `Fill ${a.id}`, artist: a.album_artist, album: a.title, albumId: a.id })
    insertTrack(db, { rel: 'Beyoncé/Lemonade/Formation.mp3', title: 'Formation', artist: 'Beyoncé' })
  })
  afterAll(() => {
    db.close()
    sb.cleanup()
  })

  it('marks liked tracks and lists them most recently liked first', () => {
    now += 1000
    favs.set('t', [trackKey(db, ids.aero)], true)
    now += 1000
    favs.set('t', [trackKey(db, ids.omt), trackKey(db, ids.rip)], true)
    now += 1000
    favs.set('t', [trackKey(db, ids.gl)], true)
    expect(trackById(db, ids.aero)).toMatchObject({ liked: true, likedAt: now - 2000 })
    expect(trackById(db, ids.da)).toMatchObject({ liked: false, likedAt: null })

    const q = queryTracks(db, { liked: true })
    expect(q.total).toBe(4)
    expect(q.rows[0].id).toBe(ids.gl)
    expect(q.rows[q.rows.length - 1].id).toBe(ids.aero)
    // Liked rips are included unless the query narrows the collection.
    expect(q.rows.map((r) => r.id)).toContain(ids.rip)
    expect(queryTracks(db, { liked: true, collection: 'main' }).total).toBe(3)
    // An explicit sort wins; likedAt is sortable too.
    expect(queryTracks(db, { liked: true, sort: { key: 'title', dir: 'asc' } }).rows[0].title).toBe('Aerodynamic')
    expect(queryTracks(db, { sort: { key: 'likedAt', dir: 'desc' } }).rows[0].id).toBe(ids.gl)

    favs.set('t', [trackKey(db, ids.gl)], false)
    expect(queryTracks(db, { liked: true }).total).toBe(3)
    expect(trackById(db, ids.gl)).toMatchObject({ liked: false, likedAt: null })
  })

  it('likes albums and artists', () => {
    now += 1000
    favs.set('a', [(db.prepare('SELECT album_key FROM albums WHERE id = ?').get(albums.home) as { album_key: string }).album_key], true)
    now += 1000
    favs.set('a', [(db.prepare('SELECT album_key FROM albums WHERE id = ?').get(albums.disc) as { album_key: string }).album_key], true)
    favs.set('r', [artistFavoriteKey('daft punk'), artistFavoriteKey('BEYONCÉ'), artistFavoriteKey('Not In Library')], true)

    const likedAlbums = queryAlbums(db, { liked: true })
    expect(likedAlbums.map((a) => a.id)).toEqual([albums.disc, albums.home])
    expect(likedAlbums.every((a) => a.liked)).toBe(true)
    expect(queryAlbums(db).find((a) => a.id === albums.ram)?.liked).toBe(false)
    expect(queryAlbums(db, { liked: true, sort: 'year' }).map((a) => a.id)).toEqual([albums.disc, albums.home])

    const artists = queryArtists(db)
    expect(artists.find((a) => a.name === 'Daft Punk')?.liked).toBe(true)
    expect(artists.find((a) => a.name === 'Beyoncé')?.liked).toBe(true)
    expect(artists.find((a) => a.name.startsWith('Zed'))?.liked).toBe(false)
    expect(queryArtists(db, { liked: true }).map((a) => a.name).sort()).toEqual(['Beyoncé', 'Daft Punk'])

    expect(favoriteCounts(db)).toEqual({ tracks: 3, albums: 2, artists: 2 })
    // The Favorites switch counts normal music and SiivaGunner rips apart.
    expect(favoriteCounts(db, 'main')).toEqual({ tracks: 2, albums: 2, artists: 2 })
    expect(favoriteCounts(db, 'rips')).toEqual({ tracks: 1, albums: 0, artists: 0 })
    const ripKey = (db.prepare('SELECT album_key FROM albums WHERE id = ?').get(albums.rip) as { album_key: string }).album_key
    favs.set('a', [ripKey], true)
    favs.set('r', [artistFavoriteKey('SiIvaGunner')], true)
    expect(favoriteCounts(db, 'rips')).toEqual({ tracks: 1, albums: 1, artists: 1 })
    expect(favoriteCounts(db, 'main')).toEqual({ tracks: 2, albums: 2, artists: 2 })
    expect(favoriteCounts(db)).toEqual({ tracks: 3, albums: 3, artists: 3 })
    expect(queryAlbums(db, { liked: true, collection: 'rips' }).map((a) => a.id)).toEqual([albums.rip])
    expect(queryArtists(db, { liked: true, collection: 'rips' }).map((a) => a.name)).toEqual(['SiIvaGunner'])
    favs.set('a', [ripKey], false)
    favs.set('r', [artistFavoriteKey('SiIvaGunner')], false)
  })

  it('evaluates the liked smart rule', () => {
    const run = (value: boolean, op: 'is' | 'isNot' = 'is') => {
      const { sql, params } = smartSql({ match: 'all', rules: [{ field: 'liked', op, value }], sort: 'likedAt' })
      return (db.prepare(sql).all(...params) as Array<{ rel_path: string }>).map((r) => r.rel_path)
    }
    // Rips stay out of smart playlists unless a rule asks for them.
    expect(run(true)).toEqual(['Daft Punk/Discovery/One More Time.mp3', 'Daft Punk/Discovery/Aerodynamic.mp3'])
    expect(run(false)).not.toContain('Daft Punk/Discovery/Aerodynamic.mp3')
    expect(run(false)).toContain('Daft Punk/Homework/Da Funk.mp3')
    expect(run(true, 'isNot').sort()).toEqual(run(false).sort())
  })

  it('pages albums with stable totals', () => {
    const all = queryAlbums(db)
    expect(all).toHaveLength(28) // the rip album is not in the main library
    const seen: number[] = []
    for (let offset = 0; offset < 40; offset += 10) {
      const page = queryAlbumsPage(db, { offset, limit: 10 })
      expect(page.total).toBe(28)
      seen.push(...page.rows.map((a) => a.id))
    }
    expect(seen).toEqual(all.map((a) => a.id))
    expect(queryAlbumsPage(db, { offset: 100, limit: 10 })).toEqual({ rows: [], total: 28 })
    expect(queryAlbumsPage(db, { liked: true, limit: 1 })).toMatchObject({ total: 2, rows: [{ id: albums.disc }] })
    expect(queryAlbumsPage(db, { collection: 'rips' }).total).toBe(1)
    expect(queryAlbumsPage(db, { search: 'filler', limit: 5, sort: 'title' }).total).toBe(25)
    // Albums without tracks don't count.
    insertAlbum(db, { title: 'Empty', artist: 'Nobody' })
    expect(queryAlbumsPage(db, { limit: 1 }).total).toBe(28)
  })
})
