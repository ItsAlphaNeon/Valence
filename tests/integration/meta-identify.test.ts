// Identify flow over recorded MusicBrainz responses (tests/fixtures/meta/mb). Re-record with
// VALENCE_RECORD=1 (live, 1 req / 1.1 s); otherwise runs fully offline.

import { describe, expect, it } from 'vitest'
import { resolve } from 'node:path'
import { createMetadataService, globalLimiters, memoryCache, RateLimiter, type IdentifyInput } from '@main/metadata'
import { createMbClient, type MbRelease } from '@main/metadata/musicbrainz'
import { fixtureTransport } from '../fixtures/meta/transport'
import type { TrackTags } from '@shared/types'

const RECORD = !!process.env.VALENCE_RECORD
const fx = fixtureTransport(resolve('tests/fixtures/meta/mb'))
const limiters = RECORD ? undefined : { musicbrainz: new RateLimiter(0), acoustid: new RateLimiter(0), lrclib: new RateLimiter(0) }
const cache = memoryCache()
const svc = createMetadataService({ transport: fx.transport, cache, contact: () => '', appVersion: '0.1', acoustidKey: () => null, fpcalcPath: () => null, limiters })
const mb = createMbClient({ transport: fx.transport, cache, limiter: limiters?.musicbrainz ?? globalLimiters.musicbrainz, userAgent: () => 'Valence/0.1 ( https://github.com/valence-music-app )' })

const HT_DIGITAL = '69b7b91a-43fc-483f-b8cf-22cdc8f69079'
const HT_DELUXE = '1c495250-80a0-482a-b34d-5f93f5459e19'

async function release(id: string): Promise<MbRelease> {
  const r = await mb.release(id)
  if (!r) throw new Error(`release ${id} not recorded`)
  return r
}

/** Builds an input from a release's own track list (durations jittered by +0.8 s). */
function inputFrom(r: MbRelease, albumTags: TrackTags, extra: (t: TrackTags, i: number) => TrackTags = (t) => t): IdentifyInput {
  const tracks = (r.media ?? []).flatMap((m) => (m.tracks ?? []).map((t) => ({ t, disc: m.position })))
  return {
    source: 'import',
    albumTags,
    tracks: tracks.map(({ t, disc }, i) => ({
      index: i,
      durationMs: (t.length ?? 200_000) + 800,
      tags: extra({ title: t.title, artist: 'Linkin Park', tracknumber: t.position, discnumber: disc }, i),
    })),
  }
}

const real = (rows: Array<[number, string, string, string, number]>, albumTags: TrackTags): IdentifyInput => ({
  source: 'import',
  albumTags,
  tracks: rows.map(([no, title, artist, isrc, dur], i) => ({ index: i, durationMs: dur * 1000, tags: { title, artist, tracknumber: no, isrc } })),
})

describe('identify on recorded MusicBrainz data', { timeout: RECORD ? 600_000 : 30_000 }, () => {
  it('picks a matching 12-track edition of an album with many editions', async () => {
    const r = await release(HT_DIGITAL)
    const res = await svc.identify(inputFrom(r, { album: 'Hybrid Theory', albumartist: 'Linkin Park', date: '2000' }))
    expect(res.status).toBe('auto')
    expect(res.release).toMatchObject({ title: 'Hybrid Theory', trackCount: 12, status: 'Official' })
    expect(res.candidates.length).toBeGreaterThan(2)
    expect(res.trackTags.map((t) => t?.tracknumber)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])
    expect(res.trackTags[0]).toMatchObject({ title: 'Papercut', artist: 'Linkin Park', totaltracks: 12, discnumber: 1 })
    expect(res.albumTags).toMatchObject({ album: 'Hybrid Theory', albumartist: 'Linkin Park', originaldate: '2000-05-07', releasestatus: 'official', releasetype: 'album', genre: 'Nu Metal' })
    expect(res.coverArtUrls[0]).toBe(`https://coverartarchive.org/release/${res.release!.releaseId}/front`)
    expect(res.coverArtUrls[1]).toMatch(/release-group\/b5b4bb4b-8ba5-3acf-88cb-4cae2699d8da\/front$/)
  })

  it('chooses the deluxe edition when the track list says so', async () => {
    const r = await release(HT_DELUXE)
    const res = await svc.identify(inputFrom(r, { album: 'Hybrid Theory (Deluxe Version)', albumartist: 'Linkin Park', date: '2013' }))
    expect(res.status).toBe('auto')
    expect(res.release?.releaseId).toBe(HT_DELUXE)
    expect(res.trackTags.every(Boolean)).toBe(true)
  })

  it('uses MBIDs from the tags with a single lookup', async () => {
    const r = await release(HT_DIGITAL)
    const before = fx.requests.length
    const res = await svc.identify(inputFrom(r, { album: 'Hybrid Theory', albumartist: 'Linkin Park', musicbrainz_albumid: HT_DIGITAL }))
    expect(res.status).toBe('auto')
    expect(res.release?.releaseId).toBe(HT_DIGITAL)
    expect(fx.requests.length - before).toBeLessThanOrEqual(1)
  })

  it('identifies by ISRC intersection (real sample tags, no album search needed)', async () => {
    const input = real(
      [[1, 'Gravity Falls Main Title Theme', 'Brad Breeck', 'USWD12432505', 148], [2, "Let's Rewind", 'Brad Breeck', 'USWD12432506', 130], [3, 'Fiddleford Hadron McGucket', 'Brad Breeck', 'USWD12432507', 138], [4, "Let's Do This", 'Brad Breeck', 'USWD12432508', 172], [5, 'Stan Wrong Song', 'Brad Breeck', 'USWD12432509', 124], [6, "Takin' Over 2 Nite", 'Brad Breeck', 'USWD12432510', 131], [7, "Gideon's Theme", 'Brad Breeck', 'USWD12432511', 119], [8, 'Gideon Rises - End Credits', 'Brad Breeck', 'USWD12432512', 162], [9, 'Weirdmageddon Pt.1B - Outro', 'Brad Breeck', 'USWD12432513', 230], [10, 'Weirdmageddon Pt. 1A', 'Brad Breeck', 'USWD12432514', 183], [11, 'Weirdmageddon Pt. 4 - End Credits', 'Brad Breeck', 'USWD12432515', 168], [12, 'Saying Goodbye to Gravity Falls', 'Brad Breeck', 'USWD12432516', 183]],
      { album: 'Lofi: Gravity Falls', albumartist: 'Brad Breeck', date: '2024' },
    )
    const res = await svc.identify(input)
    expect(res.status).toBe('auto')
    expect(res.release?.title).toMatch(/Lofi:? Gravity Falls/)
    expect(res.trackTags.every((t) => !!t?.musicbrainz_recordingid)).toBe(true)
    expect(res.trackTags[2]).toMatchObject({ title: 'Fiddleford Hadron McGucket', isrc: 'USWD12432507', tracknumber: 3 })
  })

  it('identifies a partial deluxe album by barcode', async () => {
    const input = real(
      [[2, 'Curtain Call', 'Fox Stevenson', 'GB2LD2510063', 208], [3, 'Give Me Some Space', 'Fox Stevenson', 'GB2LD2510125', 258], [4, 'Exile Is A Habit (Original Acoustic Demo)', 'Fox Stevenson', 'GB2LD2520659', 227], [4, 'Exile Is A Habit', 'Fox Stevenson', 'GB2LD2510088', 261], [5, 'Memories (Original Acoustic Demo)', 'Fox Stevenson', 'GB2LD2520660', 196], [5, 'Road To Nothing', 'Fox Stevenson', 'GB2LD2510126', 209], [6, 'One Horse Town (Original Acoustic Demo)', 'Fox Stevenson', 'GB2LD2520661', 192], [8, 'Interlude Canyon', 'Fox Stevenson', 'GB2LD2510128', 141], [9, 'One Horse Town', 'Fox Stevenson', 'GB2LD2510129', 275], [10, 'Memories', 'Fox Stevenson', 'GB2LD2510120', 251], [13, "Movin' On", 'Fox Stevenson', 'GB2LD2510132', 277], [14, 'Sunk Cost Fallacy', 'Fox Stevenson', 'GB2LD2510133', 379]],
      { album: 'Sunk Cost Fallacy Deluxe', albumartist: 'Fox Stevenson', date: '2026', barcode: '5055199581583' },
    )
    const res = await svc.identify(input)
    expect(res.status).toBe('auto')
    expect(res.release).toMatchObject({ title: 'Sunk Cost Fallacy Deluxe', trackCount: 20 })
    expect(res.albumTags.barcode).toBe('5055199581583')
    const demo = res.trackTags[2]!
    // MB style guidelines lowercase the version suffix
    expect(demo.title).toBe('Exile Is A Habit (original acoustic demo)')
    expect(res.trackTags[3]?.title).toBe('Exile Is A Habit')
    expect(new Set(res.trackTags.map((t) => t?.musicbrainz_trackid)).size).toBe(12)
  })

  it('singleton prefers the official album over singles and compilations', async () => {
    const res = await svc.identify({
      source: 'import',
      albumTags: {},
      tracks: [{ index: 0, durationMs: 219_000, tags: { title: 'Get Your Wish', artist: 'Porter Robinson', album: 'Porter Robinson - Singles', albumartist: 'Porter Robinson', tracknumber: 1, date: '2020-01-29' } }],
    })
    expect(res.status).toBe('auto')
    expect(res.release?.title).toBe('Nurture')
    expect(res.release?.type).toBe('Album')
    expect(res.albumTags).toMatchObject({ album: 'Nurture', albumartist: 'Porter Robinson', releasetype: 'album' })
    expect(res.trackTags[0]).toMatchObject({ title: 'Get Your Wish', artist: 'Porter Robinson' })
  })

  it('singleton picks a compilation only when the tags name it', async () => {
    const tags: TrackTags = { title: 'Isolation', artist: 'Hayve; Protostar', tracknumber: 16 }
    const comp = await svc.identify({ source: 'import', albumTags: {}, tracks: [{ index: 0, durationMs: 273_000, tags: { ...tags, album: 'Monstercat Uncaged Vol. 8', albumartist: 'Monstercat', date: '2020-01-13' } }] })
    expect(comp.status).toBe('auto')
    expect(comp.release?.title).toBe('Monstercat Uncaged, Vol. 8')
    expect(comp.albumTags.compilation).toBe(true)
    const bare = await svc.identify({ source: 'import', albumTags: {}, tracks: [{ index: 0, durationMs: 273_000, tags }] })
    expect(bare.status).toBe('auto')
    expect(bare.release?.title).not.toMatch(/Uncaged/)
    expect(bare.release?.type).not.toMatch(/Compilation/)
  })

  it('applyRelease maps a user-picked candidate', async () => {
    const r = await release(HT_DIGITAL)
    const res = await svc.applyRelease(HT_DELUXE, inputFrom(r, { album: 'Hybrid Theory' }))
    expect(res.status).toBe('auto')
    expect(res.release?.releaseId).toBe(HT_DELUXE)
    expect(res.trackTags.filter(Boolean).length).toBe(12)
  })

  it('searchReleases by barcode and by text', async () => {
    const byBarcode = await svc.searchReleases({ barcode: '5055199581583' })
    expect(byBarcode.length).toBeGreaterThan(0)
    expect(byBarcode[0]).toMatchObject({ title: 'Sunk Cost Fallacy Deluxe', trackCount: 20 })
    const byText = await svc.searchReleases({ artist: 'Linkin Park', album: 'Hybrid Theory' })
    expect(byText.some((c) => c.releaseId === HT_DIGITAL)).toBe(true)
  })

  it('is unmatched for nonsense input and made no unrecorded requests', async () => {
    const res = await svc.identify({ source: 'import', albumTags: { album: 'Qzxv Wqpl Nonexistent', albumartist: 'Zzyzx Nobody' }, tracks: [{ index: 0, durationMs: 1000, tags: { title: 'Qqq' } }, { index: 1, durationMs: 1000, tags: { title: 'Www' } }] })
    expect(res.status).toBe('unmatched')
    expect(res.trackTags).toEqual([null, null])
    if (!RECORD) expect(fx.misses).toEqual([])
  })
})
