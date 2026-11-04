// SiIvaGunner rips as a separate half of the library: queries, smart playlists, dedupe and
// in-library badges keep rips and normal music apart; rips get their own folder; tags round-trip.

import { afterAll, describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { sandbox } from '../helpers/sandbox'
import { genAudio } from '../helpers/audio'
import Database from 'better-sqlite3'
import { kvGet, migrate, openDb } from '@main/db/db'
import { MIGRATIONS } from '@main/db/schema'
import { Indexer } from '@main/library/indexer'
import { libraryStats, queryAlbums, queryArtists, queryGenres, queryTracks, ripGames } from '@main/library/queries'
import { smartSql } from '@main/library/playlists'
import { createLibraryLookup } from '@main/library/lookup'
import { chooseRelPath } from '@main/library/organizer'
import { findExisting } from '@main/import/dedupe'
import { probeFile, type ProbeResult } from '@main/tags/read'
import { writeTags } from '@main/tags/write'
import { DEFAULT_TEMPLATE, RIP_TEMPLATE } from '@shared/path-template'
import { RIP_GENRE, type TrackTags } from '@shared/types'

const fmt = { container: 'MPEG', codec: 'mp3', lossless: false, bitrate: 320000, sampleRate: 44100, bitDepth: 0, channels: 2, durationMs: 180000 }
const probe = (tags: TrackTags): ProbeResult => ({ tags, format: fmt, picture: null, tagTypes: [] })

function libraryWith() {
  const db = openDb(':memory:')
  const ix = new Indexer(db)
  const add = (rel: string, tags: TrackTags) => ix.upsert(rel, { size: 1, mtimeMs: 1 }, probe(tags))
  // A real song and a rip of it with the same title: they must never be confused.
  add('Toby Fox/Undertale (2015)/MEGALOVANIA.mp3', { title: 'MEGALOVANIA', artist: 'Toby Fox', albumartist: 'Toby Fox', album: 'Undertale', genre: 'Soundtrack', isrc: 'USX1', date: '2015' })
  add('High Quality Rips/SiIvaGunner: Season 2/MEGALOVANIA.opus', {
    title: 'MEGALOVANIA', artist: 'SiIvaGunner', albumartist: 'SiIvaGunner', album: 'SiIvaGunner: Season 2', genre: RIP_GENRE,
    hq_rip: 'YouTube', youtube_video_id: 'abc123', rip_game: 'UNDERTALE', composer: 'Toby Fox', isrc: 'USX1',
  })
  add('High Quality Rips/Volume 1/Snow halation.mp3', {
    title: 'Snow halation', artist: 'ripper', albumartist: 'SiIvaGunner', album: 'Volume 1', genre: RIP_GENRE, hq_rip: 'SiIvaGunner', gdrive_file_id: 'drive1', hqr_release: 'hqr:folder1',
  })
  ix.flushAlbums()
  return db
}

describe('rips stay out of the main library', () => {
  const db = libraryWith()
  afterAll(() => db.close())

  it('track queries default to the main library and can ask for rips (or one rip collection)', () => {
    expect(queryTracks(db).rows.map((r) => r.title)).toEqual(['MEGALOVANIA'])
    expect(queryTracks(db).rows[0].hqRip).toBe('')
    expect(queryTracks(db, { collection: 'rips' }).rows.map((r) => r.relPath).sort()).toEqual([
      'High Quality Rips/SiIvaGunner: Season 2/MEGALOVANIA.opus',
      'High Quality Rips/Volume 1/Snow halation.mp3',
    ])
    expect(queryTracks(db, { collection: 'rips', ripKinds: ['YouTube'] }).rows).toMatchObject([{ ripGame: 'UNDERTALE', composer: 'Toby Fox', youtubeVideoId: 'abc123' }])
    expect(queryTracks(db, { collection: 'all' }).total).toBe(3)
    expect(queryTracks(db, { search: 'megalovania' }).total).toBe(1)
  })

  it('lists the games that have rips, and the rips of one game (SiivaGunner → Games)', () => {
    expect(ripGames(db)).toEqual([{ name: 'UNDERTALE', trackCount: 1, artHash: null }])
    expect(queryTracks(db, { ripGame: 'undertale' }).rows.map((r) => r.relPath)).toEqual(['High Quality Rips/SiIvaGunner: Season 2/MEGALOVANIA.opus'])
  })

  it('album pages still open for rip albums', () => {
    const season = queryAlbums(db, { collection: 'rips', ripKinds: ['YouTube'] })
    expect(season).toMatchObject([{ title: 'SiIvaGunner: Season 2', hqRip: 'YouTube' }])
    expect(queryTracks(db, { albumId: season[0].id }).total).toBe(1)
  })

  it('albums, artists, genres and stats cover one half at a time', () => {
    expect(queryAlbums(db).map((a) => a.title)).toEqual(['Undertale'])
    expect(queryAlbums(db, { collection: 'rips' }).map((a) => a.title).sort()).toEqual(['SiIvaGunner: Season 2', 'Volume 1'])
    expect(queryArtists(db).map((a) => a.name)).toEqual(['Toby Fox'])
    expect(queryGenres(db).map((g) => g.name)).toEqual(['Soundtrack'])
    expect(queryGenres(db, { collection: 'rips' }).map((g) => g.name)).toEqual([RIP_GENRE])
    expect(libraryStats(db, '/lib', false)).toMatchObject({ tracks: 1, albums: 1, ripTracks: 2, ripAlbums: 2 })
  })

  it('smart playlists leave rips out unless a rule asks for them', () => {
    const run = (rules: Parameters<typeof smartSql>[0]) => {
      const { sql, params } = smartSql(rules)
      return (db.prepare(sql).all(...params) as Array<{ rel_path: string }>).map((r) => r.rel_path)
    }
    expect(run({ match: 'all', rules: [{ field: 'title', op: 'contains', value: 'MEGALOVANIA' }] })).toEqual(['Toby Fox/Undertale (2015)/MEGALOVANIA.mp3'])
    expect(run({ match: 'all', rules: [{ field: 'hqRip', op: 'isNot', value: '' }] })).toHaveLength(2)
    expect(run({ match: 'all', rules: [{ field: 'hqRip', op: 'is', value: 'SiIvaGunner' }] })).toEqual(['High Quality Rips/Volume 1/Snow halation.mp3'])
  })

  it('dedupe matches rips only to rips, by YouTube or Drive id first', () => {
    expect(findExisting(db, { title: 'MEGALOVANIA', artist: 'Toby Fox', album: 'Undertale', isrc: 'USX1' }, 180000)?.rel_path).toBe('Toby Fox/Undertale (2015)/MEGALOVANIA.mp3')
    expect(findExisting(db, { title: 'Other', hq_rip: 'YouTube', youtube_video_id: 'abc123' }, 0)?.rel_path).toBe('High Quality Rips/SiIvaGunner: Season 2/MEGALOVANIA.opus')
    expect(findExisting(db, { title: 'x', hq_rip: 'SiIvaGunner', gdrive_file_id: 'drive1' }, 0)?.rel_path).toBe('High Quality Rips/Volume 1/Snow halation.mp3')
    // A normal import never "finds" the rip, and a rip never finds the real song.
    expect(findExisting(db, { title: 'Snow halation', artist: 'ripper', album: 'Volume 1' }, 180000)).toBeNull()
    expect(findExisting(db, { title: 'MEGALOVANIA', artist: 'Toby Fox', album: 'Undertale', isrc: 'USX1', hq_rip: 'SGFR' }, 180000)).toBeNull()
  })

  it('TIDAL/Bandcamp in-library badges never count a rip', () => {
    const lookup = createLibraryLookup(db)
    expect(lookup.resolve({ title: 'Snow halation', artist: 'ripper', durationMs: 180000 })).toBeNull()
    expect(lookup.resolve({ title: 'MEGALOVANIA', artist: 'Toby Fox', durationMs: 180000 })).toBe('Toby Fox/Undertale (2015)/MEGALOVANIA.mp3')
  })
})

describe('schema upgrade', () => {
  it('adds the rip columns to an existing database and asks for one full rescan', () => {
    const db = new Database(':memory:')
    db.exec(MIGRATIONS[0])
    db.pragma('user_version = 1')
    db.prepare("INSERT INTO tracks (rel_path, path_key, size, mtime_ms, added_at, scanned_at) VALUES ('a.mp3', 'a.mp3', 1, 1, 1, 1)").run()
    migrate(db)
    expect(db.pragma('user_version', { simple: true })).toBe(MIGRATIONS.length)
    expect(db.prepare('SELECT hq_rip, youtube_video_id FROM tracks').get()).toEqual({ hq_rip: '', youtube_video_id: null })
    expect(kvGet(db, 'library.fullRescanPending', 0)).toBe(1)
    db.close()
  })
})

describe('rip files', () => {
  const sb = sandbox('rips')
  afterAll(() => sb.cleanup())

  it('live under their own top folder', async () => {
    const tags: TrackTags = { title: 'Gourmet Race', album: 'SiIvaGunner: Season 1', albumartist: 'SiIvaGunner', date: '2016-02-01', hq_rip: 'YouTube' }
    // ":" can't be in a Windows folder name; the sanitizer writes " - ".
    expect(await chooseRelPath(join(sb.dir, 'lib'), tags, 'opus', { template: RIP_TEMPLATE })).toBe('High Quality Rips/SiIvaGunner - Season 1/Gourmet Race.opus')
    expect(await chooseRelPath(join(sb.dir, 'lib'), { ...tags, hq_rip: undefined }, 'opus', { template: DEFAULT_TEMPLATE })).toBe('SiIvaGunner/SiIvaGunner - Season 1 (2016)/Gourmet Race.opus')
  })

  it('round-trip the rip marker, composer and source ids in MP3, Opus and FLAC', async () => {
    const tags: TrackTags = {
      title: 'Swashbuckler Spectacular', album: 'SiIvaGunner: Season X', albumartist: 'SiIvaGunner', genre: RIP_GENRE, composer: 'Noriyuki Iwadare',
      hq_rip: 'YouTube', youtube_video_id: 'hj5YJf94QdQ', youtube_uploaded: '2026-11-03T16:00:39.000Z', hqr_release: 'yt', rip_game: 'Phoenix Wright: Ace Attorney - Dual Destinies', rip_platform: 'Nintendo 3DS',
      gdrive_file_id: 'drive-x',
    }
    for (const fmtName of ['mp3_128', 'opus', 'flac16'] as const) {
      const file = await genAudio(join(sb.dir, `t.${fmtName === 'mp3_128' ? 'mp3' : fmtName === 'opus' ? 'opus' : 'flac'}`), fmtName, { seconds: 1 })
      writeTags(file, tags)
      const back = (await probeFile(file)).tags
      for (const k of Object.keys(tags) as Array<keyof TrackTags>) expect([fmtName, k, back[k]]).toEqual([fmtName, k, tags[k]])
    }
  })
})
