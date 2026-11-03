import { afterAll, describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { artUrl, mapRelease, releaseKey, sourceQuality, tralbumFromDigital } from '@main/sources/bandcamp/mapper'
import { parseTralbum, type BcTralbum } from '@main/sources/bandcamp/parse'
import { probeFile, type ProbeResult } from '@main/tags/read'
import { genAudio } from '../helpers/audio'
import { sandbox } from '../helpers/sandbox'
import { fixture } from '../fixtures/bandcamp/helpers'

const box = sandbox('bandcamp-map')
afterAll(() => box.cleanup())

const probe = (over: Partial<ProbeResult['tags']> = {}, bitDepth = 16, sampleRate = 44100): ProbeResult => ({
  tags: over,
  format: { container: 'flac', codec: 'flac', lossless: true, bitrate: 900_000, sampleRate, bitDepth, channels: 2, durationMs: 1234 },
  picture: null,
  tagTypes: ['vorbis'],
})

describe('mapper', () => {
  it('reads source_quality from the real FLAC (16 and 24 bit)', async () => {
    const f16 = await genAudio(join(box.dir, 'q16.flac'), 'flac16', { seconds: 1 })
    const f24 = await genAudio(join(box.dir, 'q24.flac'), 'flac24', { seconds: 1 })
    expect(sourceQuality(await probeFile(f16, { covers: false }))).toBe('lossless:16:44100')
    expect(sourceQuality(await probeFile(f24, { covers: false }))).toBe('lossless:24:96000')
  })

  it('maps a standalone track purchase', () => {
    const t = parseTralbum(fixture('track-page.html'))!
    const r = mapRelease({ tralbum: t, files: [{ file: '/s/Other Band - Lone Track.flac', probe: probe(), track: t.tracks[0] }] })
    expect(r.releaseKeys).toEqual(['bc:track:2002'])
    expect(r.albumTags).toMatchObject({ album: 'Lone Track', albumartist: 'Other Band', totaltracks: 1, bandcamp_item_id: '2002', bandcamp_url: 'https://otherband.bandcamp.com/track/lone-track', date: '2021-01-01' })
    expect(r.albumTags.label).toBeUndefined()
    expect(r.tracks[0].tags).toMatchObject({ title: 'Lone Track', artist: 'Other Band', tracknumber: 1, bandcamp_track_id: '2002', source_quality: 'lossless:16:44100' })
    expect(r.tracks[0].durationMs).toBe(1234)
    expect((r.raw as { tags: string[] }).tags).toEqual(['rock', 'indie'])
  })

  it('falls back to download-page metadata and file tags when the album page is unavailable', () => {
    const t = tralbumFromDigital({
      saleId: 1, itemId: 55, itemType: 'a', tralbumType: 'album', tralbumId: 55, title: 'Fallback', artist: 'Someone', artId: null,
      pageUrl: null, preorder: false, downloads: {}, flacUrl: null, releaseDate: '2020-02-02',
    })
    const r = mapRelease({
      tralbum: t,
      files: [
        { file: '/s/Someone - Fallback - 02 Second.flac', probe: probe({ tracknumber: 2 }) },
        { file: '/s/Someone - Fallback - 01 First.flac', probe: probe({ tracknumber: 1, title: 'First (tagged)' }) },
      ],
      coverFile: '/s/cover.jpg',
      extras: ['/s/cover.jpg'],
    })
    expect(r.tracks.map((x) => [x.tags.tracknumber, x.tags.title])).toEqual([[1, 'First (tagged)'], [2, 'Second']])
    expect(r.albumTags).toMatchObject({ album: 'Fallback', albumartist: 'Someone', totaltracks: 2, date: '2020-02-02' })
    expect(r.artwork).toEqual({ file: '/s/cover.jpg' })
    expect(r.extras).toEqual(['/s/cover.jpg'])
  })

  it('builds artwork urls and release keys', () => {
    expect(artUrl(123, 0)).toBe('https://f4.bcbits.com/img/a123_0.jpg')
    expect(releaseKey('album', 9)).toBe('bc:album:9')
    const t: BcTralbum = { id: 1, itemType: 'album', title: 'X', artist: 'Y', artId: 5, url: null, preorder: false, tracks: [], tags: [] }
    expect(mapRelease({ tralbum: t, files: [] }).artwork).toEqual({ url: artUrl(5, 0), fallbackUrls: [artUrl(5, 10)] })
  })
})
