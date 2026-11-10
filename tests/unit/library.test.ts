import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { sandbox } from '../helpers/sandbox'
import { genAudio } from '../helpers/audio'
import { openDb } from '@main/db/db'
import { Indexer } from '@main/library/indexer'
import { scanLibrary, walkLibrary } from '@main/library/scanner'
import { chooseRelPath, moveWithinLibrary, placeFile } from '@main/library/organizer'
import { createLibraryLookup } from '@main/library/lookup'
import { queryAlbums, queryArtists, queryTracks, libraryStats } from '@main/library/queries'
import { PlaylistStore } from '@main/library/playlists'
import { writeTags } from '@main/tags/write'
import { probeFile } from '@main/tags/read'
import { HlcClock } from '@main/sync/hlc'
import { DeviceLog, readNewEvents } from '@main/sync/device-log'
import { PlayLog } from '@main/sync/plays'
import { renderStignore } from '@main/sync/stignore'
import { parseM3u, writeM3u } from '@main/sync/m3u'
import { Claims } from '@main/sync/claims'
import { mergeShared } from '@main/settings'
import { isIgnoredName, sanitizeComponent } from '@shared/sanitize'
import { renderRelStem } from '@shared/path-template'
import type { TrackTags } from '@shared/types'

describe('sanitize additions', () => {
  it('strips bidi isolates and mongolian vowel separator', () => {
    expect(sanitizeComponent('A\u2066B\u2069C\u180E')).toBe('ABC')
  })
  it('suffixes reserved top-level artist folders', () => {
    expect(renderRelStem('{albumartist_primary}/{album}/{title}', { albumartist: 'Playlists', album: 'X', title: 'Y' })).toBe('Playlists (Artist)/X/Y')
    expect(renderRelStem('{albumartist_primary}/{album}/{title}', { albumartist: 'Music', album: 'X', title: 'Y' })).toBe('Music (Artist)/X/Y')
  })
  it('recognizes syncthing / temp names', () => {
    for (const n of ['a.sync-conflict-20250101-120000-ABCDEFG.mp3', 'x.valence-tmp', '~syncthing~a.mp3.tmp', '.stfolder', 'desktop.ini'])
      expect(isIgnoredName(n)).toBe(true)
    expect(isIgnoredName('Song.mp3')).toBe(false)
  })
})

describe('file names in another Unicode normalization', () => {
  // On macOS, Syncthing renames every synced file to NFD ("é" as "e" + a combining accent), and the
  // disk treats both spellings as one file. The index keeps one row per file, under the disk's spelling.
  const sb = sandbox('nfd')
  const root = join(sb.dir, 'Music')
  const db = openDb(join(sb.dir, 'valence.db'))
  const indexer = new Indexer(db)
  const nfc = 'SiIvaGunner/Rips (2025)/Littleroot Town - Pokémon Ruby.mp3'
  const nfd = nfc.normalize('NFD')
  const abs = (rel: string) => join(root, ...rel.split('/'))
  const rows = () => db.prepare('SELECT id, rel_path FROM tracks ORDER BY id').all() as Array<{ id: number; rel_path: string }>
  afterAll(() => {
    db.close()
    sb.cleanup()
  })

  it('follows a rename to the other spelling instead of adding a second row', async () => {
    mkdirSync(dirname(abs(nfc)), { recursive: true })
    await genAudio(abs(nfc), 'mp3_128', { seconds: 1 })
    writeTags(abs(nfc), { title: 'Littleroot Town - Pokémon Ruby', artist: 'SiIvaGunner', valence_id: 'v-nfd' })
    await scanLibrary({ root, db, indexer })
    const [before] = rows()
    renameSync(abs(nfc), abs(nfd))
    expect(readdirSync(dirname(abs(nfc)))).toEqual([nfd.slice(nfd.lastIndexOf('/') + 1)])
    // The watcher reports both spellings in one batch.
    await scanLibrary({ root, db, indexer, only: [nfc, nfd] })
    expect(rows()).toEqual([{ id: before.id, rel_path: nfd }])
    const again = await scanLibrary({ root, db, indexer })
    expect(again.added + again.removed).toBe(0)
  })

  it('drops the leftover row an earlier version kept under the old spelling', async () => {
    const st = statSync(abs(nfd))
    indexer.upsert(nfc, { size: st.size, mtimeMs: st.mtimeMs }, await probeFile(abs(nfd)))
    expect(rows()).toHaveLength(2)
    const r = await scanLibrary({ root, db, indexer })
    expect(r.removed).toBe(1)
    expect(rows().map((x) => x.rel_path)).toEqual([nfd])
  })
})

describe('Syncthing conflict copies', () => {
  const sb = sandbox('conflict')
  const root = join(sb.dir, 'Music')
  const db = openDb(join(sb.dir, 'valence.db'))
  const indexer = new Indexer(db)
  const rel = 'SiIvaGunner/Rips (2025)/Lancer - DELTARUNE.opus'
  const copy = 'SiIvaGunner/Rips (2025)/Lancer - DELTARUNE.sync-conflict-20261104-204122-UYQHYMI.opus'
  const abs = (r: string) => join(root, ...r.split('/'))
  const paths = () => (db.prepare('SELECT rel_path FROM tracks ORDER BY id').all() as Array<{ rel_path: string }>).map((r) => r.rel_path)
  afterAll(() => {
    db.close()
    sb.cleanup()
  })

  it('are not indexed when the watcher reports them, and an indexed one is dropped (the file stays)', async () => {
    mkdirSync(dirname(abs(rel)), { recursive: true })
    await genAudio(abs(rel), 'opus', { seconds: 1 })
    writeTags(abs(rel), { title: 'Lancer - DELTARUNE', artist: 'SiIvaGunner', valence_id: 'v-lancer' })
    writeFileSync(abs(copy), readFileSync(abs(rel)))
    await scanLibrary({ root, db, indexer })
    await scanLibrary({ root, db, indexer, only: [copy] })
    expect(paths()).toEqual([rel])
    // What earlier versions did: index the copy as a track of its own.
    const st = statSync(abs(copy))
    indexer.upsert(copy, { size: st.size, mtimeMs: st.mtimeMs }, await probeFile(abs(copy)))
    expect(paths()).toEqual([rel, copy])
    await scanLibrary({ root, db, indexer })
    expect(paths()).toEqual([rel])
    expect(existsSync(abs(copy))).toBe(true)
  })
})

describe('organizer', () => {
  const sb = sandbox('org')
  afterAll(() => sb.cleanup())

  it('resolves title collisions: disc, then artist, then counter', async () => {
    const root = join(sb.dir, 'lib1')
    const base: TrackTags = { albumartist: 'Artist', album: 'Album', date: '2020', title: 'Intro', totaldiscs: 2 }
    mkdirSync(join(root, 'Artist', 'Album (2020)'), { recursive: true })
    writeFileSync(join(root, 'Artist', 'Album (2020)', 'Intro.mp3'), 'x')
    expect(await chooseRelPath(root, { ...base, discnumber: 2 }, 'mp3')).toBe('Artist/Album (2020)/Intro (Disc 2).mp3')
    expect(await chooseRelPath(root, { ...base, totaldiscs: 1, artist: 'Guest' }, 'mp3')).toBe('Artist/Album (2020)/Intro (Guest).mp3')
    expect(await chooseRelPath(root, { ...base, totaldiscs: 1 }, 'mp3')).toBe('Artist/Album (2020)/Intro (2).mp3')
    // Same stem with a different extension does not collide.
    expect(await chooseRelPath(root, { ...base, totaldiscs: 1 }, 'flac')).toBe('Artist/Album (2020)/Intro.flac')
  })

  it('reuses existing folder casing', async () => {
    const root = join(sb.dir, 'lib2')
    mkdirSync(join(root, 'The Beatles', 'Abbey Road (1969)'), { recursive: true })
    expect(await chooseRelPath(root, { albumartist: 'the beatles', album: 'abbey road', date: '1969', title: 'Something' }, 'mp3')).toBe(
      'The Beatles/Abbey Road (1969)/Something.mp3',
    )
  })

  it('places without clobbering and leaves no temp files', async () => {
    const root = join(sb.dir, 'lib3')
    const src = join(sb.dir, 'src.bin')
    writeFileSync(src, 'new')
    mkdirSync(join(root, 'A', 'B'), { recursive: true })
    writeFileSync(join(root, 'A', 'B', 'T.mp3'), 'old')
    await expect(placeFile(src, root, 'A/B/T.mp3')).rejects.toThrow(/exists/)
    const r = await placeFile(src, root, 'A/B/T.mp3', { rechoose: async () => 'A/B/T (2).mp3' })
    expect(r.relPath).toBe('A/B/T (2).mp3')
    expect(readFileSync(join(root, 'A', 'B', 'T.mp3'), 'utf8')).toBe('old')
    expect(readFileSync(join(root, 'A', 'B', 'T (2).mp3'), 'utf8')).toBe('new')
    expect(readdirSync(join(root, 'A', 'B')).filter((f) => f.includes('valence-tmp'))).toEqual([])
    expect(existsSync(src)).toBe(true)
  })

  it('puts a moved file back and leaves no temp file when rechoose gives up', async () => {
    const root = join(sb.dir, 'lib3b')
    const src = join(sb.dir, 'src-moved.bin')
    writeFileSync(src, 'new')
    mkdirSync(join(root, 'A'), { recursive: true })
    writeFileSync(join(root, 'A', 'T.mp3'), 'old')
    const giveUp = async () => {
      throw new Error('same video')
    }
    await expect(placeFile(src, root, 'A/T.mp3', { move: true, rechoose: giveUp })).rejects.toThrow('same video')
    expect(readdirSync(join(root, 'A'))).toEqual(['T.mp3'])
    expect(readFileSync(join(root, 'A', 'T.mp3'), 'utf8')).toBe('old')
    expect(readFileSync(src, 'utf8')).toBe('new')
  })

  it('moves within the library, including case-only renames, and prunes empty folders', async () => {
    const root = join(sb.dir, 'lib4')
    mkdirSync(join(root, 'Old', 'Album'), { recursive: true })
    writeFileSync(join(root, 'Old', 'Album', 'song.mp3'), 'x')
    writeFileSync(join(root, 'Old', 'Album', 'desktop.ini'), 'junk')
    await moveWithinLibrary(root, 'Old/Album/song.mp3', 'Old/Album/Song.mp3')
    expect(readdirSync(join(root, 'Old', 'Album'))).toContain('Song.mp3')
    await moveWithinLibrary(root, 'Old/Album/Song.mp3', 'New/Album/Song.mp3')
    expect(existsSync(join(root, 'New', 'Album', 'Song.mp3'))).toBe(true)
    expect(existsSync(join(root, 'Old'))).toBe(false)
  })
})

describe('scanner + indexer + queries + lookup', () => {
  const sb = sandbox('scan')
  const root = join(sb.dir, 'Music')
  const db = openDb(join(sb.dir, 'valence.db'))
  const indexer = new Indexer(db)

  beforeAll(async () => {
    const mk = async (rel: string, tags: TrackTags, fmt: 'mp3_320' | 'flac16' = 'mp3_320') => {
      const abs = join(root, ...rel.split('/'))
      mkdirSync(join(abs, '..'), { recursive: true })
      await genAudio(abs, fmt, { seconds: 2 })
      await writeTags(abs, tags)
    }
    await mk('Daft Punk/Discovery (2001)/One More Time.mp3', {
      title: 'One More Time', artist: 'Daft Punk', albumartist: 'Daft Punk', album: 'Discovery', date: '2001-03-12',
      tracknumber: 1, totaltracks: 14, genre: 'House', isrc: 'GBDUW0000053', valence_id: 'v-1', tidal_track_id: '111',
      tidal_album_id: '900', barcode: '724384960650',
    })
    await mk('Daft Punk/Discovery (2001)/Aerodynamic.mp3', {
      title: 'Aerodynamic', artist: 'Daft Punk', albumartist: 'Daft Punk', album: 'Discovery', date: '2001', tracknumber: 2,
      totaltracks: 14, genre: 'House', valence_id: 'v-2',
    })
    await mk('Various Artists/Hits (2010)/Song A.mp3', {
      title: 'Song A', artist: 'Kaos & Ethos', albumartist: 'Various Artists', album: 'Hits', date: '2010', compilation: true,
    })
    await mk('Loose/whatever.flac', { title: 'Loose Track', artist: 'Someone' }, 'flac16')
    mkdirSync(join(root, '.valence'), { recursive: true })
    writeFileSync(join(root, '.valence', 'x.mp3'), 'not audio')
    writeFileSync(join(root, 'Daft Punk', 'Discovery (2001)', 'One More Time.sync-conflict-20250101-000000-AAAAAAA.mp3'), 'c')
    mkdirSync(join(root, 'Playlists'), { recursive: true })
    writeFileSync(join(root, 'Playlists', 'Faves.m3u8'), '#EXTM3U\n../Daft Punk/Discovery (2001)/Aerodynamic.mp3\n')
  })
  afterAll(() => {
    db.close()
    sb.cleanup()
  })

  it('walks, skipping .valence and collecting conflicts/playlists', async () => {
    const w = await walkLibrary(root)
    expect(w.files.map((f) => f.rel).sort()).toEqual([
      'Daft Punk/Discovery (2001)/Aerodynamic.mp3',
      'Daft Punk/Discovery (2001)/One More Time.mp3',
      'Loose/whatever.flac',
      'Various Artists/Hits (2010)/Song A.mp3',
    ])
    expect(w.conflicts).toHaveLength(1)
    expect(w.playlists.map((p) => p.rel)).toEqual(['Playlists/Faves.m3u8'])
  })

  it('indexes and is incremental', async () => {
    const r1 = await scanLibrary({ root, db, indexer })
    expect(r1.added).toBe(4)
    expect(r1.errors).toEqual([])
    const r2 = await scanLibrary({ root, db, indexer })
    expect(r2.added + r2.updated + r2.removed).toBe(0)
    expect(r2.unchanged).toBe(4)
    const stats = libraryStats(db, root, false)
    expect(stats.tracks).toBe(4)
    expect(stats.albums).toBe(3)
  })

  it('queries tracks/albums/artists with search', () => {
    const { rows, total } = queryTracks(db, { search: 'daft one' })
    expect(total).toBe(1)
    expect(rows[0].title).toBe('One More Time')
    expect(rows[0].year).toBe(2001)
    const albums = queryAlbums(db)
    const disc = albums.find((a) => a.title === 'Discovery')!
    expect(disc.trackCount).toBe(2)
    expect(disc.trackTotal).toBe(14)
    expect(disc.genre).toBe('House')
    expect(albums.find((a) => a.title === 'Hits')!.compilation).toBe(true)
    expect(queryArtists(db).map((a) => a.name)).toContain('Various Artists')
    const ordered = queryTracks(db, { albumId: disc.id }).rows.map((r) => r.trackNo)
    expect(ordered).toEqual([1, 2])
  })

  it('computes in-library badges', () => {
    const lookup = createLibraryLookup(db)
    expect(lookup.matchTracks([{ tidalTrackId: '111' }, { isrc: 'gbduw0000053' }, { title: 'aerodynamic', artist: 'Daft Punk', durationMs: 2000 }, { title: 'Nope', artist: 'X' }])).toEqual([
      true, true, true, false,
    ])
    expect(lookup.matchTracks([{ title: 'One More Time (Radio Edit)', artist: 'Daft Punk' }])).toEqual([true])
    expect(lookup.albumBadge({ tidalAlbumId: '900', trackCount: 14 })).toEqual({ status: 'partial', have: 1, total: 14 })
    expect(lookup.albumBadge({ title: 'Discovery', albumArtist: 'Daft Punk', trackCount: 2 })).toEqual({ status: 'in-library', have: 2, total: 2 })
    expect(lookup.albumBadge({ upc: '724384960650', trackCount: 14 }).status).toBe('partial')
    expect(lookup.albumBadge({ title: 'Homework', albumArtist: 'Daft Punk', trackCount: 16 }).status).toBe('missing')
    expect(lookup.resolve({ tidalTrackId: '111' })).toBe('Daft Punk/Discovery (2001)/One More Time.mp3')
    expect(lookup.artistTracks!(['daft punk', 'Nobody', ''])).toEqual([2, 0, 0])
  })

  it('detects moves by VALENCE_ID and keeps the row id', async () => {
    const before = queryTracks(db, { search: 'aerodynamic' }).rows[0]
    await moveWithinLibrary(root, before.relPath, 'Daft Punk/Discovery (2001)/Aerodynamic (Moved).mp3')
    const r = await scanLibrary({ root, db, indexer })
    const after = queryTracks(db, { search: 'aerodynamic' }).rows[0]
    expect(after.id).toBe(before.id)
    expect(after.relPath).toBe('Daft Punk/Discovery (2001)/Aerodynamic (Moved).mp3')
    expect(r.added).toBe(0)
  })

  it('indexes playlists and evaluates smart rules', async () => {
    const lookup = createLibraryLookup(db)
    const trashed: string[] = []
    const store = new PlaylistStore(db, root, lookup, async (p) => void trashed.push(p))
    // The move above left the m3u pointing at the old path; rewrite via pathMoved.
    store.indexAll()
    store.pathMoved('Daft Punk/Discovery (2001)/Aerodynamic.mp3', 'Daft Punk/Discovery (2001)/Aerodynamic (Moved).mp3')
    const faves = store.list().find((p) => p.name === 'Faves')!
    expect(store.items(faves.id)).toEqual(['Daft Punk/Discovery (2001)/Aerodynamic (Moved).mp3'])
    const id = store.create('Road Trip', ['Loose/whatever.flac'])
    expect(readFileSync(join(root, 'Playlists', 'Road Trip.m3u8'), 'utf8')).toContain('../Loose/whatever.flac')
    const smart = store.saveSmart('House', { match: 'all', rules: [{ field: 'genre', op: 'is', value: 'house' }] })
    expect(store.items(smart)).toHaveLength(2)
    store.mirror({ name: 'TIDAL Mix', sourceKey: 'tidal:playlist:abc', tracks: [{ tidalTrackId: '111' }, { tidalTrackId: '999' }] })
    const mirror = store.list().find((p) => p.kind === 'mirror')!
    expect(mirror.count).toBe(1)
    store.indexAll()
    expect(store.list().map((p) => p.name).sort()).toEqual(['Faves', 'House', 'Road Trip', 'TIDAL Mix'])
    await store.remove(id)
    expect(trashed.some((t) => t.endsWith('Road Trip.m3u8'))).toBe(true)
  })

  it('mirrored playlists: rename keeps the link, an edit breaks it away, delete takes the doc', async () => {
    const trashed: string[] = []
    const store = new PlaylistStore(db, root, createLibraryLookup(db), async (p) => void trashed.push(p))
    store.indexAll()
    const docs = () => readdirSync(join(root, '.valence', 'playlists')).filter((f) => f.startsWith('mirror-'))
    store.mirror({ name: 'Edit Me', sourceKey: 'tidal:playlist:edit', tracks: [{ tidalTrackId: '111' }, { tidalTrackId: '999' }] })
    const m = store.list().find((p) => p.name === 'Edit Me')!
    const docsBefore = docs().length

    const renamed = await store.rename(m.id, 'Edited')
    expect(renamed).toBe(m.id)
    expect(store.list().find((p) => p.id === m.id)).toMatchObject({ kind: 'mirror', name: 'Edited', relPath: 'Playlists/Edited.m3u8' })
    store.indexAll()
    expect(store.list().find((p) => p.id === m.id)?.kind).toBe('mirror')

    const items = store.items(m.id)
    const newId = store.addItems(m.id, ['Loose/whatever.flac'])
    expect(newId).not.toBe(m.id)
    expect(docs()).toHaveLength(docsBefore - 1)
    const after = store.list().find((p) => p.id === newId)!
    expect(after).toMatchObject({ kind: 'static', name: 'Edited', relPath: 'Playlists/Edited.m3u8', sourceKey: null })
    store.refreshMirrors() // the source still has a missing track; a mirror would be rewritten here
    store.indexAll()
    expect(store.list().find((p) => p.relPath === 'Playlists/Edited.m3u8')).toMatchObject({ id: newId, kind: 'static' })
    expect(store.items(newId)).toEqual([...items, 'Loose/whatever.flac'])

    const tidal = store.list().find((p) => p.name === 'TIDAL Mix')!
    await store.remove(tidal.id)
    expect(trashed.some((t) => t.endsWith(`${tidal.id}.json`))).toBe(true)
  })
})

describe('sync primitives', () => {
  const sb = sandbox('sync')
  afterAll(() => sb.cleanup())

  it('HLC is monotonic and observes remote clocks', () => {
    let now = 1000
    const c = new HlcClock('aaaa', () => now)
    const a = c.tick()
    const b = c.tick()
    expect(b > a).toBe(true)
    now = 500 // clock went backwards
    expect(c.tick() > b).toBe(true)
    const remote = new HlcClock('bbbb', () => 99999).tick()
    c.observe(remote)
    expect(c.tick() > remote).toBe(true)
  })

  it('reads device logs incrementally, ignoring partial trailing lines', () => {
    const root = join(sb.dir, 'lib')
    const db = openDb(':memory:')
    const logA = new DeviceLog(root, 'deva', new HlcClock('deva'))
    const logB = new DeviceLog(root, 'devb', new HlcClock('devb'))
    logA.append('plays', { k: 'x' }, { monthly: true })
    logB.append('plays', { k: 'y' }, { monthly: true })
    expect(readNewEvents(db, root, 'plays')).toHaveLength(2)
    expect(readNewEvents(db, root, 'plays')).toHaveLength(0)
    const dirB = join(root, '.valence', 'devices', 'devb')
    const file = join(dirB, readdirSync(dirB).find((f) => f.startsWith('plays'))!)
    appendFileSync(file, '{"hlc":"zzz","k":"partial"')
    expect(readNewEvents(db, root, 'plays')).toHaveLength(0)
    appendFileSync(file, '}\n')
    const evs = readNewEvents(db, root, 'plays')
    expect(evs.map((e) => e.k)).toEqual(['partial'])
    db.close()
  })

  it('materializes plays from all devices', () => {
    const root = join(sb.dir, 'lib2')
    const db = openDb(':memory:')
    const mine = new PlayLog(db, new DeviceLog(root, 'deva', new HlcClock('deva')), root, 'deva')
    mine.record({ trackKey: 'v-1', playedAt: 1, ms: 200000, completed: true, skipped: false })
    new DeviceLog(root, 'devb', new HlcClock('devb')).append('plays', { k: 'v-1', at: 2, ms: 1000, c: 0, s: 1 }, { monthly: true })
    expect(mine.ingest()).toBe(1) // own event already inserted
    const s = db.prepare('SELECT * FROM play_stats WHERE track_key = ?').get('v-1') as { play_count: number; skip_count: number }
    expect(s).toMatchObject({ play_count: 1, skip_count: 1 })
    db.close()
  })

  it('stignore keeps user lines and is idempotent', () => {
    const once = renderStignore('// mine\n/Podcasts\n')
    expect(once).toContain('/Podcasts')
    expect(once).toContain('*.valence-tmp')
    expect(renderStignore(once)).toBe(once)
  })

  it('m3u round-trips relative paths', () => {
    const text = writeM3u('Playlists/Mix.m3u8', [{ relPath: 'A/B (2020)/C.mp3', title: 'A - C', durationSec: 200 }])
    expect(text).toBe('#EXTM3U\n#EXTINF:200,A - C\n../A/B (2020)/C.mp3\n')
    expect(parseM3u(text, 'Playlists/Mix.m3u8')).toEqual([{ relPath: 'A/B (2020)/C.mp3', title: 'A - C', durationSec: 200 }])
    expect(parseM3u('C:\\Users\\x\\Music\\A\\b.mp3\r\n', 'Playlists/x.m3u', 'C:\\Users\\x\\Music')).toEqual([{ relPath: 'A/b.mp3' }])
  })

  it('claims block other devices until released or expired', () => {
    const root = join(sb.dir, 'lib3')
    let now = 0
    const a = new Claims(root, 'deva', () => now)
    const b = new Claims(root, 'devb', () => now)
    expect(a.claim(['tidal:album:1'], 1000)).toBe(true)
    expect(b.claim(['tidal:album:1'])).toBe(false)
    now = 2000
    expect(b.claim(['tidal:album:1'])).toBe(true)
    b.release(['tidal:album:1'])
    expect(a.heldElsewhere(['tidal:album:1'])).toBeNull()
  })

  it('shared settings merge newest-wins per key', () => {
    const m = mergeShared({ a: { v: 1, hlc: '2' }, b: { v: 1, hlc: '5' } }, { a: { v: 2, hlc: '3' }, b: { v: 2, hlc: '4' }, c: { v: 3, hlc: '1' } })
    expect(m).toEqual({ a: { v: 2, hlc: '3' }, b: { v: 1, hlc: '5' }, c: { v: 3, hlc: '1' } })
  })
})
