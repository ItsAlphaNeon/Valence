import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { genAudio, genImage, type GenFormat } from '../helpers/audio'
import { sandbox } from '../helpers/sandbox'
import { writeRating, writeTags } from '@main/tags/write'
import { probeFile } from '@main/tags/read'
import type { TrackTags } from '@shared/types'

const FULL: TrackTags = {
  title: 'Ünïcødé Title: Part 2',
  artist: 'Kaos & Ethos feat. Someone',
  artists: ['Kaos & Ethos', 'Someone'],
  album: 'Test Album (Deluxe)',
  albumartist: 'Kaos & Ethos',
  albumartistsort: 'Kaos & Ethos',
  tracknumber: 3,
  totaltracks: 12,
  discnumber: 1,
  totaldiscs: 2,
  date: '2021-05-14',
  originaldate: '2020-01-01',
  genre: 'Electronic',
  isrc: 'USABC2100001',
  barcode: '0123456789012',
  label: 'Test Label',
  catalognumber: 'TL-001',
  copyright: '℗ 2021 Test',
  bpm: 128,
  key: 'Am',
  comment: 'A comment',
  musicbrainz_recordingid: '11111111-1111-1111-1111-111111111111',
  musicbrainz_trackid: '22222222-2222-2222-2222-222222222222',
  musicbrainz_albumid: '33333333-3333-3333-3333-333333333333',
  musicbrainz_releasegroupid: '44444444-4444-4444-4444-444444444444',
  musicbrainz_artistid: ['55555555-5555-5555-5555-555555555555', '66666666-6666-6666-6666-666666666666'],
  musicbrainz_albumartistid: ['55555555-5555-5555-5555-555555555555'],
  releasetype: 'album',
  releasestatus: 'official',
  releasecountry: 'XW',
  acoustid_id: '77777777-7777-7777-7777-777777777777',
  replaygain_track_gain: -6.52,
  replaygain_track_peak: 0.988547,
  replaygain_album_gain: -7.1,
  replaygain_album_peak: 1.0,
  lyrics: '[00:01.00]First line\n[00:02.50]Second line',
  rating: 4,
  explicit: true,
  valence_id: '0193f0c2-aaaa-7bbb-8ccc-dddddddddddd',
  tidal_track_id: '123456789',
  tidal_album_id: '98765432',
  source: 'tidal',
  source_quality: 'lossless:16:44100',
}

const CORE_KEYS: Array<keyof TrackTags> = [
  'title', 'artist', 'album', 'albumartist', 'tracknumber', 'totaltracks', 'discnumber', 'totaldiscs',
  'genre', 'isrc', 'label', 'copyright', 'musicbrainz_recordingid', 'musicbrainz_albumid',
  'musicbrainz_releasegroupid', 'acoustid_id', 'lyrics', 'rating', 'valence_id', 'tidal_track_id',
  'tidal_album_id', 'source', 'source_quality', 'explicit', 'comment',
]

describe('tag round-trip', () => {
  const sb = sandbox('tags')
  let art: Buffer
  beforeAll(async () => {
    art = readFileSync(await genImage(join(sb.dir, 'art.jpg'), 600))
  })
  afterAll(() => sb.cleanup())

  const formats: Array<[GenFormat, string]> = [
    ['mp3_320', 'mp3'],
    ['flac16', 'flac'],
    ['aac', 'm4a'],
    ['opus', 'opus'],
  ]

  for (const [fmt, ext] of formats) {
    it(`${ext}: writes and reads back every field`, async () => {
      const path = await genAudio(join(sb.dir, `rt.${ext}`), fmt, { metadata: { title: 'junk', artist: 'junk' } })
      writeTags(path, FULL, { artwork: { data: art, mime: 'image/jpeg' } })
      const r = await probeFile(path)
      for (const k of CORE_KEYS) expect.soft(r.tags[k], `${ext}:${k}`).toEqual(FULL[k])
      expect(r.tags.artists).toEqual(FULL.artists)
      expect(r.tags.replaygain_track_gain).toBeCloseTo(-6.52, 2)
      expect(r.tags.replaygain_album_peak).toBeCloseTo(1.0, 4)
      expect(r.tags.date?.slice(0, 4)).toBe('2021')
      expect(r.tags.originaldate?.slice(0, 4)).toBe('2020')
      expect(r.picture?.data.length).toBe(art.length)
      if (ext === 'mp3') {
        expect(r.tagTypes).toContain('ID3v2.3')
        expect(r.tags.date).toBe('2021-05-14')
        expect(r.tags.musicbrainz_artistid).toEqual(FULL.musicbrainz_artistid)
      }
    })
  }

  it('mp3: rating rewrite keeps file size (fits padding)', async () => {
    const path = await genAudio(join(sb.dir, 'rate.mp3'), 'mp3_320')
    writeTags(path, { ...FULL, rating: 2 })
    const before = statSync(path).size
    writeRating(path, 5)
    expect(statSync(path).size).toBe(before)
    expect((await probeFile(path)).tags.rating).toBe(5)
    writeRating(path, 0)
    expect((await probeFile(path)).tags.rating).toBeUndefined()
  })

  it('mp3: no ID3v1 / APE after write', async () => {
    const path = await genAudio(join(sb.dir, 'v1.mp3'), 'mp3_128')
    writeTags(path, { title: 'x' })
    const r = await probeFile(path)
    expect(r.tagTypes).toEqual(['ID3v2.3'])
    const buf = readFileSync(path)
    expect(buf.subarray(buf.length - 128, buf.length - 125).toString('latin1')).not.toBe('TAG')
  })
})
