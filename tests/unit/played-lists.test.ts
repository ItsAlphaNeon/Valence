// The phone's built-in lists on the desktop: recently played, most played, not played, and the
// listening history (every device's plays, newest first).

import { afterAll, describe, expect, it } from 'vitest'
import { openDb } from '@main/db/db'
import { Indexer } from '@main/library/indexer'
import { listeningHistory, queryTracks } from '@main/library/queries'
import type { ProbeResult } from '@main/tags/read'
import type { TrackTags } from '@shared/types'

const fmt = { container: 'MPEG', codec: 'mp3', lossless: false, bitrate: 320000, sampleRate: 44100, bitDepth: 0, channels: 2, durationMs: 180000 }
const probe = (tags: TrackTags): ProbeResult => ({ tags, format: fmt, picture: null, tagTypes: [] })

function library() {
  const db = openDb(':memory:')
  const ix = new Indexer(db)
  for (const t of ['Alpha', 'Bravo', 'Charlie', 'Delta']) ix.upsert(`Band/Album/${t}.mp3`, { size: 1, mtimeMs: 1 }, probe({ title: t, artist: 'Band', albumartist: 'Band', album: 'Album' }))
  ix.upsert('High Quality Rips/Volume 1/Echo.mp3', { size: 1, mtimeMs: 1 }, probe({ title: 'Echo', artist: 'ripper', albumartist: 'SiIvaGunner', album: 'Volume 1', hq_rip: 'SiIvaGunner' }))
  ix.flushAlbums()
  const play = db.prepare('INSERT INTO plays (device_id, hlc, track_key, played_at, ms, completed, skipped) VALUES (?, ?, ?, ?, ?, 1, ?)')
  let n = 0
  const add = (title: string, at: number, skipped = 0, device = 'pc') => play.run(device, `h${n++}`, `path:Band/Album/${title}.mp3`, at, 60000, skipped)
  add('Alpha', 1000)
  add('Alpha', 2000)
  add('Alpha', 3000, 0, 'phone')
  add('Bravo', 5000)
  add('Charlie', 4000, 1) // a skip: not a play
  play.run('pc', `h${n++}`, 'path:High Quality Rips/Volume 1/Echo.mp3', 6000, 60000, 0)
  play.run('pc', `h${n++}`, 'path:Gone/Old song.mp3', 7000, 60000, 0) // no longer in the library
  return db
}

describe('built-in played lists', () => {
  const db = library()
  afterAll(() => db.close())

  it('most played: songs with plays, the most first, skips not counted', () => {
    const r = queryTracks(db, { played: 'most' })
    expect(r.rows.map((t) => [t.title, t.playCount])).toEqual([
      ['Alpha', 3],
      ['Bravo', 1],
    ])
    expect(r.total).toBe(2)
  })

  it('recently played: latest play first, from the main library unless asked', () => {
    expect(queryTracks(db, { played: 'recent' }).rows.map((t) => t.title)).toEqual(['Bravo', 'Alpha'])
    expect(queryTracks(db, { played: 'recent', collection: 'all' }).rows.map((t) => t.title)).toEqual(['Echo', 'Bravo', 'Alpha'])
  })

  it('not played: songs never played (a skip alone does not count), by title', () => {
    expect(queryTracks(db, { played: 'never' }).rows.map((t) => t.title)).toEqual(['Charlie', 'Delta'])
  })

  it('recently and most played stop at 100 songs', () => {
    const big = openDb(':memory:')
    const ix = new Indexer(big)
    const play = big.prepare("INSERT INTO plays (device_id, hlc, track_key, played_at, ms, completed, skipped) VALUES ('pc', ?, ?, ?, 1, 1, 0)")
    for (let i = 0; i < 130; i++) {
      const rel = `A/B/Song ${String(i).padStart(3, '0')}.mp3`
      ix.upsert(rel, { size: 1, mtimeMs: 1 }, probe({ title: `Song ${i}`, artist: 'A', albumartist: 'A', album: 'B' }))
      play.run(`h${i}`, `path:${rel}`, i)
    }
    ix.flushAlbums()
    expect(queryTracks(big, { played: 'recent' }).total).toBe(100)
    expect(queryTracks(big, { played: 'most', offset: 90, limit: 50 }).rows).toHaveLength(10)
    big.close()
  })

  it('history lists every play, newest first, with the device; skips and missing songs left out', () => {
    const h = listeningHistory(db)
    expect(h.map((e) => [e.track.title, e.playedAt, e.deviceId])).toEqual([
      ['Echo', 6000, 'pc'],
      ['Bravo', 5000, 'pc'],
      ['Alpha', 3000, 'phone'],
      ['Alpha', 2000, 'pc'],
      ['Alpha', 1000, 'pc'],
    ])
    expect(listeningHistory(db, 2)).toHaveLength(2)
  })
})
