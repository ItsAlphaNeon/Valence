// Get Info's MusicBrainz lookup: release ordering, album-level hints, and the per-track diff.

import { describe, expect, it, vi } from 'vitest'
import type { IdentifyInput, IdentifyResult, MetadataService } from '@main/metadata'
import { lookupTracks, proposeChanges, type LookupTrack } from '@main/import/lookup'

const release = { releaseId: 'rel-1', title: 'Album', artist: 'Band', trackCount: 2, score: 0.92 }

function ident(over: Partial<IdentifyResult> = {}): IdentifyResult {
  return {
    status: 'auto',
    score: 0.92,
    release,
    candidates: [release, { ...release, releaseId: 'rel-2', title: 'Album (Deluxe)', trackCount: 4, score: 0.6 }],
    albumTags: { album: 'Album', albumartist: 'Band', date: '2020-05-01', genre: 'Electronic; House', musicbrainz_albumid: 'rel-1', totaltracks: 2 },
    trackTags: [
      { title: 'One', artist: 'Band', tracknumber: 1, musicbrainz_recordingid: 'rec-1' },
      { title: 'Two', artist: 'Band', tracknumber: 2, musicbrainz_recordingid: 'rec-2' },
    ],
    coverArtUrls: [],
    ...over,
  }
}

describe('proposeChanges', () => {
  it('lists only differing fields, with a single genre', () => {
    const [a, b] = proposeChanges(
      [
        { title: 'One', artist: 'Band', album: 'album', tracknumber: 1, rating: 4, lyrics: 'x' },
        { title: 'two (live)', artist: 'Band', album: 'Album', albumartist: 'Band', date: '2020-05-01', genre: 'Electronic', tracknumber: 2, totaltracks: 2, musicbrainz_albumid: 'rel-1', musicbrainz_recordingid: 'rec-2' },
      ],
      ident(),
    )
    expect(a).toEqual({ album: 'Album', albumartist: 'Band', date: '2020-05-01', genre: 'Electronic', musicbrainz_albumid: 'rel-1', totaltracks: 2, musicbrainz_recordingid: 'rec-1' })
    expect(b).toEqual({ title: 'Two' })
  })

  it('keeps per-track fields of tracks the release has no slot for', () => {
    const [, b] = proposeChanges([{ title: 'One' }, { title: 'Bonus', tracknumber: 9 }], ident({ trackTags: [{ title: 'One', tracknumber: 1 }, null] }))
    expect(b.title).toBeUndefined()
    expect(b.tracknumber).toBeUndefined()
    expect(b.album).toBe('Album')
  })

  it('proposes nothing when unmatched', () => {
    expect(proposeChanges([{ title: 'x' }], ident({ status: 'unmatched', release: undefined }))).toEqual([{}])
  })
})

describe('lookupTracks', () => {
  const tracks: LookupTrack[] = [
    { id: 12, relPath: 'Band/Album (2020)/Two.mp3', file: '/x/Two.mp3', durationMs: 200_000, tags: { title: 'Two', album: 'Album', albumartist: 'Band', tracknumber: 2 } },
    { id: 11, relPath: 'Band/Album (2020)/One.mp3', file: '/x/One.mp3', durationMs: 180_000, tags: { title: 'One', album: 'Album', albumartist: 'Band', tracknumber: 1, label: 'L' } },
  ]

  it('identifies in release order and returns changes keyed by track id', async () => {
    let seen: IdentifyInput | null = null
    const md = { identify: vi.fn(async (input: IdentifyInput) => ((seen = input), ident())), applyRelease: vi.fn() } as unknown as MetadataService
    const r = await lookupTracks(md, tracks)
    expect(seen!.tracks.map((t) => t.tags.title)).toEqual(['One', 'Two'])
    expect(seen!.albumTags).toEqual({ album: 'Album', albumartist: 'Band' })
    expect(r.status).toBe('auto')
    expect(r.changes.map((c) => c.id)).toEqual([11, 12])
    expect(r.changes[0].patch).toMatchObject({ date: '2020-05-01', musicbrainz_recordingid: 'rec-1' })
  })

  it('uses applyRelease when the user picked a release', async () => {
    const md = { identify: vi.fn(), applyRelease: vi.fn(async () => ident({ status: 'review', score: 0.5 })) } as unknown as MetadataService
    const r = await lookupTracks(md, tracks, 'rel-2')
    expect(md.applyRelease).toHaveBeenCalledWith('rel-2', expect.objectContaining({ source: 'import' }))
    expect(md.identify).not.toHaveBeenCalled()
    expect(r.status).toBe('auto')
  })
})
