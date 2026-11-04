// Listening stats and "similar tracks" over a small fixture library (plays and
// favorites inserted directly), plus a timing check of similarTracks on a 50k-track library.

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openDb, type DB } from '@main/db/db'
import { formatLabel, listeningStats, localDayKey, seededRandom, similarTracks, statsRangeStart } from '@main/library/insights'
import { libraryStats } from '@main/library/queries'
import { insertAlbum, insertPlay, insertTrack, trackKey } from '../helpers/library-fixture'

const HOUR = 3_600_000
const DAY = 24 * HOUR
// Local noon, so whole-day offsets stay on the intended calendar day across DST changes.
const NOW = new Date(2026, 5, 15, 12, 0, 0).getTime()

const like = (db: DB, kind: 't' | 'a' | 'r', key: string, at = NOW - DAY) =>
  db.prepare('INSERT OR REPLACE INTO favorites(kind, item_key, liked, hlc, at) VALUES (?, ?, 1, ?, ?)').run(kind, key, `${at.toString(36)}-0000-x`, at)

describe('listening stats', () => {
  const db = openDb(':memory:')
  const al: Record<string, number> = {}
  const tr: Record<string, number> = {}

  beforeAll(() => {
    al.alpha = insertAlbum(db, { title: 'Alpha', artist: 'Artist A', genre: 'Rock', year: 2000, addedAt: 1 })
    al.beta = insertAlbum(db, { title: 'Beta', artist: 'Artist B', genre: 'Rock', year: 2001, addedAt: 2 })
    al.gamma = insertAlbum(db, { title: 'Gamma', artist: 'Artist C', genre: 'Jazz', year: 1960, addedAt: 3 })
    al.comp = insertAlbum(db, { title: 'Comp', artist: 'Various Artists', addedAt: 4 })
    al.old = insertAlbum(db, { title: 'Old', artist: 'Artist F', addedAt: 5 })
    al.never = insertAlbum(db, { title: 'Never', artist: 'Artist G', addedAt: 6 })
    al.rip = insertAlbum(db, { title: 'Rips', artist: 'SiIvaGunner', hqRip: 'SiIvaGunner', addedAt: 7 })
    const flac = { codec: 'flac', lossless: true, bitDepth: 16, sampleRate: 44100 }
    tr.a1 = insertTrack(db, { rel: 'A/Alpha/1.flac', title: 'A One', artist: 'Artist A', albumId: al.alpha, genre: 'Rock', ...flac })
    tr.a2 = insertTrack(db, { rel: 'A/Alpha/2.flac', title: 'A Two', artist: 'Artist A', albumId: al.alpha, genre: 'Rock', ...flac })
    tr.b1 = insertTrack(db, { rel: 'B/Beta/1.flac', title: 'B One', artist: 'Artist B', albumId: al.beta, codec: 'flac', lossless: true, bitDepth: 24, sampleRate: 96000 })
    tr.c1 = insertTrack(db, { rel: 'C/Gamma/1.mp3', title: 'C One', artist: 'Artist C', albumId: al.gamma, valenceId: 'v-c1' })
    tr.d1 = insertTrack(db, { rel: 'VA/Comp/1.mp3', title: 'D One', artist: 'Artist D feat. Someone', albumArtist: 'Various Artists', albumId: al.comp, compilation: true })
    tr.f1 = insertTrack(db, { rel: 'F/Old/1.mp3', title: 'F One', artist: 'Artist F', albumId: al.old })
    tr.g1 = insertTrack(db, { rel: 'G/Never/1.mp3', title: 'G One', artist: 'Artist G', albumId: al.never })
    tr.rip = insertTrack(db, { rel: 'Rips/1.opus', title: 'Rip', artist: 'SiIvaGunner', albumId: al.rip, hqRip: 'SiIvaGunner', codec: 'opus', bitrate: 160_000 })

    for (let i = 0; i < 5; i++) insertPlay(db, { key: trackKey(db, tr.a1), at: NOW - (1 + i * 20) * HOUR, ms: 200_000 })
    for (let i = 0; i < 3; i++) insertPlay(db, { key: trackKey(db, tr.b1), at: NOW - (2 + i * 20) * HOUR, ms: 100_000 })
    insertPlay(db, { key: trackKey(db, tr.b1), at: NOW - 3 * HOUR, ms: 5_000, skipped: true })
    insertPlay(db, { key: trackKey(db, tr.c1), at: NOW - 20 * DAY })
    insertPlay(db, { key: trackKey(db, tr.d1), at: NOW - 2 * DAY })
    insertPlay(db, { key: trackKey(db, tr.d1), at: NOW - 2 * DAY - HOUR })
    insertPlay(db, { key: trackKey(db, tr.f1), at: NOW - 100 * DAY })
    insertPlay(db, { key: trackKey(db, tr.f1), at: NOW - 101 * DAY })
    for (let i = 0; i < 4; i++) insertPlay(db, { key: trackKey(db, tr.rip), at: NOW - DAY - i * HOUR })
    insertPlay(db, { key: 'v-gone', at: NOW - DAY }) // a track no longer in the library

    like(db, 't', 'v-c1')
    like(db, 'a', (db.prepare('SELECT album_key FROM albums WHERE id = ?').get(al.gamma) as { album_key: string }).album_key)
  })
  afterAll(() => db.close())

  it('summarizes listening for a range', () => {
    const lib = libraryStats(db, '/music', false)
    const s = listeningStats(db, '7d', lib, NOW)
    expect(s).toMatchObject({ plays: 15, skips: 1, distinctTracks: 5, library: lib })
    expect(s.ms).toBe(5 * 200_000 + 3 * 100_000 + 5_000 + 2 * 180_000 + 4 * 180_000 + 180_000)
    expect(s.byDay).toHaveLength(7)
    expect(s.byDay[6].day).toBe(localDayKey(NOW))
    expect(s.byDay[0].day).toBe(localDayKey(NOW - 6 * DAY))
    expect(s.byDay.reduce((n, d) => n + d.plays, 0)).toBe(15)
    expect(s.byHour).toHaveLength(24)
    expect(s.byHour.reduce((a, b) => a + b, 0)).toBe(15)
    expect(s.byWeekday).toHaveLength(7)
    expect(s.byWeekday.reduce((a, b) => a + b, 0)).toBe(15)
    expect(s.byHour[new Date(NOW - HOUR).getHours()]).toBeGreaterThan(0)
    // Rips count in stats; tracks no longer in the library only in the totals.
    expect(s.topTracks.map((t) => t.id)).toEqual([tr.a1, tr.rip, tr.b1, tr.d1])
    expect(s.topTracks[1]).toMatchObject({ plays: 4, hqRip: 'SiIvaGunner' })
    expect(s.topAlbums.map((a) => [a.id, a.plays])).toEqual([
      [al.alpha, 5],
      [al.rip, 4],
      [al.beta, 3],
      [al.comp, 2],
    ])
    // Compilations credit the track's primary artist.
    expect(s.topArtists.map((a) => a.name)).toEqual(['Artist A', 'SiIvaGunner', 'Artist B', 'Artist D'])
    expect(s.distinctArtists).toBe(4)
    expect(s.firstPlay).toBe(NOW - 20 * HOUR * 4 - HOUR) // earliest play in the last 7 days
    expect(s.formats).toEqual([
      { label: 'MP3 320', tracks: 4 },
      { label: 'FLAC', tracks: 2 },
      { label: 'FLAC 24/96', tracks: 1 },
    ])

    const month = listeningStats(db, '30d', lib, NOW)
    expect(month.byDay).toHaveLength(30)
    expect(month.plays).toBe(16)
    expect(listeningStats(db, 'bogus' as never, lib, NOW).byDay).toHaveLength(30)

    const all = listeningStats(db, 'all', lib, NOW)
    expect(all.plays).toBe(18)
    expect(all.firstPlay).toBe(NOW - 101 * DAY)
    expect(all.byDay[0].day).toBe(localDayKey(NOW - 101 * DAY))
    expect(all.byDay).toHaveLength(102)
    expect(listeningStats(db, 'year', lib, NOW).byDay).toHaveLength(102)
    expect(statsRangeStart('7d', NOW)).toBe(new Date(2026, 5, 9).getTime())
  })

  it('labels formats', () => {
    const f = (codec: string | null, lossless: boolean, bitDepth: number, sampleRate: number, bitrate = 0) => formatLabel({ codec, lossless, bitDepth, sampleRate, bitrate })
    expect(f('flac', true, 16, 44100)).toBe('FLAC')
    expect(f('flac', true, 24, 96000)).toBe('FLAC 24/96')
    expect(f('alac', true, 24, 44100)).toBe('ALAC 24/44.1')
    expect(f('mp3', false, 0, 44100, 318_000)).toBe('MP3 320')
    expect(f('aac', false, 0, 44100, 256_000)).toBe('AAC 256')
    expect(f('opus', false, 0, 48000, 0)).toBe('Opus')
    expect(f(null, false, 0, 0, 0)).toBe('Unknown')
  })
})

describe('similar tracks', () => {
  const db = openDb(':memory:')
  const ids: Record<string, number[]> = {}

  beforeAll(() => {
    const add = (artist: string, genre: string, n: number, year: number) => {
      const album = insertAlbum(db, { title: `${artist} LP`, artist, genre, year })
      ids[artist] = []
      for (let i = 0; i < n; i++) ids[artist].push(insertTrack(db, { rel: `${artist}/${i}.mp3`, title: `${artist} song ${i}`, artist, albumId: album, genre, year }))
    }
    add('Seedy', 'Shoegaze', 20, 1991)
    for (const a of ['Alt One', 'Alt Two', 'Alt Three', 'Alt Four']) add(a, 'Shoegaze', 4, 1992)
    for (let i = 0; i < 30; i++) add(`Elsewhere ${i}`, 'Polka', 3, 1970)
    // Same song as a seed on another release: never suggested.
    const comp = insertAlbum(db, { title: 'Best Of', artist: 'Seedy' })
    ids.dupe = [insertTrack(db, { rel: 'Seedy/best/0.mp3', title: 'Seedy Song 0', artist: 'Seedy', albumId: comp, genre: 'Shoegaze' })]
    const rip = insertAlbum(db, { title: 'Rip', artist: 'Seedy', hqRip: 'SiIvaGunner' })
    ids.rip = [insertTrack(db, { rel: 'Seedy/rip.mp3', title: 'Seedy rip', artist: 'Seedy', albumId: rip, genre: 'Shoegaze', hqRip: 'SiIvaGunner' })]
  })
  afterAll(() => db.close())

  it('picks related main-library tracks, never seeds, excluded ids or repeats of a seed song', () => {
    const seeds = [ids.Seedy[0], ids.Seedy[1]]
    const exclude = ids.Seedy.slice(2, 6)
    const out = similarTracks(db, seeds, exclude, 12, { random: seededRandom(1), now: Date.now() })
    expect(out).toHaveLength(12)
    expect(new Set(out).size).toBe(12)
    for (const id of [...seeds, ...exclude, ...ids.dupe, ...ids.rip]) expect(out).not.toContain(id)
    const related = new Set([...ids.Seedy, ...ids['Alt One'], ...ids['Alt Two'], ...ids['Alt Three'], ...ids['Alt Four']])
    expect(out.filter((id) => related.has(id)).length).toBeGreaterThanOrEqual(10)
    expect(out.filter((id) => ids.Seedy.includes(id)).length).toBeGreaterThanOrEqual(3)
  })

  it('spreads artists out', () => {
    const artistOf = new Map<number, string>()
    for (const [a, list] of Object.entries(ids)) for (const id of list) artistOf.set(id, a)
    for (let seed = 1; seed <= 5; seed++) {
      const out = similarTracks(db, [ids.Seedy[0]], [], 15, { random: seededRandom(seed) }).map((id) => artistOf.get(id))
      for (let i = 2; i < out.length; i++) expect(new Set([out[i - 2], out[i - 1], out[i]]).size, out.join(', ')).toBe(3)
    }
  })

  it('handles edge cases', () => {
    expect(similarTracks(db, [ids.Seedy[0]], [], 0)).toEqual([])
    expect(similarTracks(db, [ids.Seedy[0]], [], 1000).length).toBeLessThanOrEqual(200)
    expect(similarTracks(db, [], [], 5)).toHaveLength(5)
    expect(similarTracks(db, [999_999], [], 5)).toHaveLength(5)
  })

  it('is fast on a 50k-track library', () => {
    const big = openDb(':memory:')
    try {
      const genres = Array.from({ length: 40 }, (_, i) => `Genre ${i}`)
      big.transaction(() => {
        for (let a = 0; a < 2000; a++) {
          const artist = `Artist ${a}`
          const genre = genres[a % genres.length]
          const album = insertAlbum(big, { title: `Album ${a}`, artist, genre, year: 1960 + (a % 60) })
          for (let i = 0; i < 25; i++) insertTrack(big, { rel: `${a}/${i}.mp3`, title: `Song ${a}-${i}`, artist, albumId: album, genre, year: 1960 + (a % 60) })
        }
        for (let i = 0; i < 2000; i++) insertPlay(big, { key: `path:${i % 2000}/${i % 25}.mp3`, at: Date.now() - i * HOUR })
        for (let i = 0; i < 500; i++) like(big, 't', `path:${(i * 7) % 2000}/${i % 25}.mp3`)
      })()
      const seeds = [1, 2, 3, 26, 27]
      similarTracks(big, seeds, [], 20) // warm the statement cache
      const times: number[] = []
      for (let i = 0; i < 5; i++) {
        const t0 = performance.now()
        const out = similarTracks(big, seeds, [4, 5], 20)
        times.push(performance.now() - t0)
        expect(out).toHaveLength(20)
      }
      times.sort((a, b) => a - b)
      console.log(`similarTracks on 50k tracks: median ${times[2].toFixed(1)} ms`)
      // The target is < 50 ms; the bound is loose for slow CI machines.
      expect(times[2]).toBeLessThan(150)
    } finally {
      big.close()
    }
  }, 60_000)
})
