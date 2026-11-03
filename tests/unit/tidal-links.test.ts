import { describe, expect, it } from 'vitest'
import { parseTidalLink } from '@main/sources/tidal/links'

const UUID = '0f0b1c2d-3e4f-5a6b-7c8d-9e0fa1b2c3d4'

describe('parseTidalLink', () => {
  const cases: Array<[string, ReturnType<typeof parseTidalLink>]> = [
    ['https://tidal.com/browse/album/12345', { kind: 'album', id: '12345' }],
    ['https://tidal.com/browse/album/12345?u', { kind: 'album', id: '12345' }],
    ['https://tidal.com/browse/track/67890/u', { kind: 'track', id: '67890' }],
    ['https://tidal.com/browse/track/67890?u=1&utm_source=x', { kind: 'track', id: '67890' }],
    ['http://www.tidal.com/browse/artist/7804#top', { kind: 'artist', id: '7804' }],
    ['https://listen.tidal.com/album/12345', { kind: 'album', id: '12345' }],
    ['https://listen.tidal.com/album/12345/track/67890', { kind: 'track', id: '67890' }],
    ['https://listen.tidal.com/artist/7804/albums', { kind: 'artist', id: '7804' }],
    ['https://tidal.com/album/12345', { kind: 'album', id: '12345' }],
    ['https://tidal.com/track/67890/', { kind: 'track', id: '67890' }],
    [`https://tidal.com/browse/playlist/${UUID}`, { kind: 'playlist', id: UUID }],
    [`https://listen.tidal.com/playlist/${UUID.toUpperCase()}?u`, { kind: 'playlist', id: UUID }],
    ['https://tidal.com/browse/mix/0123456789abcdef0123456789abcd', { kind: 'mix', id: '0123456789abcdef0123456789abcd' }],
    ['https://embed.tidal.com/tracks/67890', { kind: 'track', id: '67890' }],
    ['https://tidal.com/browse/video/555', { kind: 'video', id: '555' }],
    ['tidal.com/browse/album/12345', { kind: 'album', id: '12345' }],
    ['  https://tidal.com/browse/album/12345  ', { kind: 'album', id: '12345' }],
    ['tidal://album/12345', { kind: 'album', id: '12345' }],
    ['tidal:track:67890', { kind: 'track', id: '67890' }],
    ['album:12345', { kind: 'album', id: '12345' }],
    ['12345', { kind: 'album', id: '12345' }],
    [UUID, { kind: 'playlist', id: UUID }],
  ]
  for (const [input, expected] of cases) {
    it(`parses ${input.trim()}`, () => expect(parseTidalLink(input)).toEqual(expected))
  }

  it('honours bareKind for numeric ids', () => {
    expect(parseTidalLink('67890', 'track')).toEqual({ kind: 'track', id: '67890' })
  })

  const rejects = [
    '',
    'https://example.com/browse/album/12345',
    'https://bandcamp.com/album/123',
    'https://tidal.com/browse/album/not-a-number',
    'https://tidal.com/browse/playlist/12345',
    'https://tidal.com/browse',
    'https://link.tidal.com/AbCdE',
    'ftp://tidal.com/album/1',
    'hello world',
    'https://evil.tidal.com.example.net/album/1',
  ]
  for (const input of rejects) {
    it(`rejects ${JSON.stringify(input)}`, () => expect(parseTidalLink(input)).toBeNull())
  }
})
