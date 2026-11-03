import { describe, expect, it } from 'vitest'
import {
  artwork,
  fullTitle,
  mapAlbumTags,
  mapRelease,
  mapTrackTags,
  musicalKey,
  releaseKeys,
  sourceQuality,
  toBadgeQueryAlbum,
  toBadgeQueryTrack,
} from '@main/sources/tidal/mapper'
import type { TidalAlbum, TidalTrack } from '@main/sources/tidal/types'
import { fixture } from '../fixtures/tidal/support'

const album = fixture<TidalAlbum>('album-multidisc.json')
const tracks = fixture<{ items: TidalTrack[] }>('album-multidisc-tracks.json').items
const va = fixture<TidalAlbum>('album-va.json')
const vaTracks = fixture<{ items: TidalTrack[] }>('album-va-tracks.json').items
const lyrics = fixture('lyrics.json')

describe('tidal mapper', () => {
  it('appends the version unless the title already has it', () => {
    expect(fullTitle('Second Song', 'Club Mix')).toBe('Second Song (Club Mix)')
    expect(fullTitle('Third (Live)', 'Live')).toBe('Third (Live)')
    expect(fullTitle('Plain', null)).toBe('Plain')
    expect(fullTitle('Plain', '')).toBe('Plain')
    expect(mapTrackTags(tracks[1], album, tracks).title).toBe('Second Song (Club Mix)')
    expect(mapTrackTags(tracks[2], album, tracks).title).toBe('Third (Live)')
    expect(mapAlbumTags(album).album).toBe('Test Album (Deluxe Edition)')
  })

  it('joins MAIN artists for artist and adds FEATURED to artists', () => {
    const t = mapTrackTags(tracks[1], album, tracks)
    expect(t.artist).toBe('Kaos & Ethos & Partner')
    expect(t.artists).toEqual(['Kaos & Ethos', 'Partner', 'Guest Singer'])
    expect(t.albumartist).toBe('Kaos & Ethos')
    expect(t.albumartists).toEqual(['Kaos & Ethos'])
  })

  it('computes per-disc totaltracks and totaldiscs', () => {
    const d1 = mapTrackTags(tracks[0], album, tracks)
    const d2 = mapTrackTags(tracks[3], album, tracks)
    expect([d1.tracknumber, d1.discnumber, d1.totaltracks, d1.totaldiscs]).toEqual([1, 1, 3, 2])
    expect([d2.tracknumber, d2.discnumber, d2.totaltracks, d2.totaldiscs]).toEqual([1, 2, 2, 2])
  })

  it('maps identifiers, key, bpm, explicit, copyright, date and lyrics', () => {
    const t = mapTrackTags(tracks[0], album, tracks, { quality: 'lossless:16:44100', lyrics })
    expect(t).toMatchObject({
      isrc: 'USABC2100001',
      barcode: '0123456789012',
      date: '2021-05-14',
      copyright: '℗ 2021 Test Label',
      bpm: 128,
      key: 'Am',
      explicit: false,
      tidal_track_id: '1001',
      tidal_album_id: '100',
      source: 'tidal',
      source_quality: 'lossless:16:44100',
      compilation: false,
      releasetype: 'album',
    })
    expect(t.lyrics).toBe('[00:01.00] First line\n[00:02.50] Second line')
    expect(mapTrackTags(tracks[0], album, tracks, { lyrics: { ...lyrics, subtitles: '' } }).lyrics).toBe('First line\nSecond line')
    const t2 = mapTrackTags(tracks[1], album, tracks)
    expect(t2.key).toBe('F#')
    expect(t2.bpm).toBeUndefined()
    expect(t2.explicit).toBe(true)
    expect(t2.copyright).toBe('℗ 2021 Test Label') // falls back to the album copyright
    expect(mapTrackTags(tracks[3], album, tracks).key).toBe('Ebm')
    expect(mapTrackTags(tracks[3], album, tracks).bpm).toBe(90)
    expect(mapTrackTags(tracks[2], album, tracks).key).toBeUndefined()
  })

  it('parses musical keys', () => {
    expect(musicalKey('A', 'MINOR')).toBe('Am')
    expect(musicalKey('CSharp', 'MINOR')).toBe('C#m')
    expect(musicalKey('BFlat', 'MAJOR')).toBe('Bb')
    expect(musicalKey('UNKNOWN', 'MAJOR')).toBeUndefined()
    expect(musicalKey(null, null)).toBeUndefined()
  })

  it('marks Various Artists releases as compilations', () => {
    const tags = mapAlbumTags(va, vaTracks)
    expect(tags.compilation).toBe(true)
    expect(tags.albumartist).toBe('Various Artists')
    const t = mapTrackTags(vaTracks[1], va, vaTracks)
    expect(t.artist).toBe('Artist Two')
    expect(t.artists).toEqual(['Artist Two', 'MC Three'])
    expect(t.albumartist).toBe('Various Artists')
    expect(t.totaltracks).toBe(2)
    expect(t.totaldiscs).toBe(1)
  })

  it('marks type=COMPILATION as a compilation while keeping a real album artist', () => {
    const tags = mapAlbumTags({ ...album, type: 'COMPILATION' })
    expect(tags.compilation).toBe(true)
    expect(tags.albumartist).toBe('Kaos & Ethos')
    expect(tags.releasetype).toBe('compilation')
  })

  it('builds artwork URLs with slashes and a 1280 fallback', () => {
    expect(artwork(album.cover)).toEqual({
      url: 'https://resources.tidal.com/images/aabbccdd/1122/3344/5566/77889900aabb/origin.jpg',
      fallbackUrls: ['https://resources.tidal.com/images/aabbccdd/1122/3344/5566/77889900aabb/1280x1280.jpg'],
    })
    expect(artwork(null)).toBeUndefined()
  })

  it('encodes source quality from what was delivered', () => {
    expect(sourceQuality({ audioQuality: 'LOSSLESS', bitDepth: 16, sampleRate: 44100 })).toBe('lossless:16:44100')
    expect(sourceQuality({ audioQuality: 'HI_RES_LOSSLESS', bitDepth: 24, sampleRate: 96000 })).toBe('lossless:24:96000')
    expect(sourceQuality({ audioQuality: 'LOSSLESS' }, { lossless: false, codec: 'aac', bitrateKbps: 320 })).toBe('lossy:aac:320')
    expect(sourceQuality({ audioQuality: 'HIGH' })).toBe('lossy:aac:320')
    expect(sourceQuality({ audioQuality: 'LOW' })).toBe('lossy:aac:96')
  })

  it('builds release keys and a SourceRelease', () => {
    expect(releaseKeys(album)).toEqual(['tidal:album:100', 'upc:0123456789012'])
    expect(releaseKeys(album, 1002)).toEqual(['tidal:album:100', 'upc:0123456789012', 'tidal:track:1002'])
    const rel = mapRelease({
      album,
      albumTracks: tracks,
      acquired: [{ track: tracks[1], file: '/staging/t002-1002.flac', quality: 'lossless:16:44100' }],
      skipped: [{ id: '1005', title: 'Bonus Two', reason: 'unavailable', message: 'x' }],
      trackId: '1002',
    })
    expect(rel.source).toBe('tidal')
    expect(rel.releaseKeys).toContain('tidal:track:1002')
    expect(rel.title).toBe('TIDAL · Kaos & Ethos & Partner — Second Song (Club Mix)')
    expect(rel.albumTags).toMatchObject({ album: 'Test Album (Deluxe Edition)', albumartist: 'Kaos & Ethos', totaldiscs: 2 })
    expect(rel.tracks[0]).toMatchObject({ file: '/staging/t002-1002.flac', durationMs: 245_000 })
    expect(rel.tracks[0].tags.totaltracks).toBe(3)
    expect((rel.raw as any).skipped).toHaveLength(1)
    expect((rel.raw as any).album.id).toBe(100)
    expect(rel.artwork?.url).toMatch(/origin\.jpg$/)
  })

  it('builds badge queries', () => {
    expect(toBadgeQueryTrack(tracks[1], album)).toEqual({
      tidalTrackId: '1002',
      isrc: 'USABC2100002',
      artist: 'Kaos & Ethos & Partner',
      albumArtist: 'Kaos & Ethos',
      title: 'Second Song (Club Mix)',
      album: 'Test Album (Deluxe Edition)',
      durationMs: 245_000,
    })
    const q = toBadgeQueryAlbum(album, tracks)
    expect(q).toMatchObject({ tidalAlbumId: '100', upc: '0123456789012', albumArtist: 'Kaos & Ethos', title: 'Test Album (Deluxe Edition)', trackCount: 5 })
    expect(q.tracks).toHaveLength(5)
  })
})
