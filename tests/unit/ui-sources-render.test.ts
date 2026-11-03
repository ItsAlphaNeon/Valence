// Server-render smoke test for the TIDAL / Bandcamp views: every render path with realistic data must
// render without throwing or logging React errors. (No DOM here, so effects don't run; zustand's
// server snapshot is the store's initial state, which the tests mutate in place.)

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement as h } from 'react'
import { renderToString } from 'react-dom/server'
import type { TidalAlbumDetail, TidalAlbumSummary, TidalPlaylistDetail, TidalSearchResult, TidalTrackSummary } from '@shared/ipc/tidal'
import type { BandcampItemDetail, BandcampItemSummary } from '@shared/ipc/bandcamp'

vi.hoisted(() => {
  const g = globalThis as unknown as { window?: unknown }
  g.window ??= { valence: { platform: 'win32', invoke: async () => null, on: () => () => {}, send: () => {} } }
  // In-memory localStorage (defined without touching Node's experimental getter, which warns).
  const mem = new Map<string, string>()
  const storage = {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => void mem.set(k, String(v)),
    removeItem: (k: string) => void mem.delete(k),
    clear: () => mem.clear(),
  }
  try {
    Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true, writable: true })
  } catch {
    /* keep the runtime's */
  }
})

// TrackTable pulls in the audio engine; the views only need its scroll context.
vi.mock('../../src/renderer/components/TrackTable', async () => {
  const { createContext } = await import('react')
  return { ScrollParent: createContext(null) }
})

const { TidalView } = await import('../../src/renderer/views/tidal/TidalView')
const { AlbumBody } = await import('../../src/renderer/views/tidal/AlbumPage')
const { PlaylistBody } = await import('../../src/renderer/views/tidal/PlaylistPage')
const { SearchResults } = await import('../../src/renderer/views/tidal/Search')
const { useTidalSession } = await import('../../src/renderer/views/tidal/tidal-state')
const { DownloadControl, ErrorState } = await import('../../src/renderer/views/tidal/source-kit')
const { BandcampView } = await import('../../src/renderer/views/bandcamp/BandcampView')
const { CollectionGrid, CollectionHeader } = await import('../../src/renderer/views/bandcamp/Collection')
const { ItemBody } = await import('../../src/renderer/views/bandcamp/ItemPage')
const { useBandcampSession } = await import('../../src/renderer/views/bandcamp/bandcamp-state')
const { useLib } = await import('../../src/renderer/state/library')

const album = (p: Partial<TidalAlbumSummary> = {}): TidalAlbumSummary => ({
  id: '100',
  title: 'Discovery',
  artist: 'Daft Punk',
  artists: [{ id: '8', name: 'Daft Punk' }],
  cover: 'https://resources.tidal.com/images/a/b/c/640x640.jpg',
  releaseDate: '2001-03-12',
  year: 2001,
  numberOfTracks: 3,
  numberOfVolumes: 2,
  durationSec: 600,
  type: 'ALBUM',
  explicit: true,
  quality: 'HI_RES_LOSSLESS',
  mediaTags: ['LOSSLESS', 'HIRES_LOSSLESS'],
  upc: '724384960650',
  url: 'https://tidal.com/browse/album/100',
  badge: { status: 'partial', have: 1, total: 3 },
  ...p,
})

const track = (n: number, p: Partial<TidalTrackSummary> = {}): TidalTrackSummary => ({
  id: String(1000 + n),
  title: `Track ${n}`,
  artist: 'Daft Punk',
  artists: [{ id: '8', name: 'Daft Punk' }],
  album: { id: '100', title: 'Discovery', cover: null },
  trackNumber: n,
  volumeNumber: n > 2 ? 2 : 1,
  durationSec: 200,
  explicit: false,
  isrc: null,
  quality: 'LOSSLESS',
  streamable: true,
  url: `https://tidal.com/browse/track/${1000 + n}`,
  inLibrary: n === 1,
  ...p,
})

const purchase = (n: number, p: Partial<BandcampItemSummary> = {}): BandcampItemSummary => ({
  key: `a${n}`,
  itemType: 'album',
  tralbumType: 'album',
  tralbumId: n,
  title: `Record ${n}`,
  artist: 'Some Band',
  itemUrl: `https://someband.bandcamp.com/album/r${n}`,
  artUrl: `https://f4.bcbits.com/img/a${n}_2.jpg`,
  purchased: '2024-05-01T10:00:00Z',
  hidden: false,
  preorder: false,
  physicalOnly: false,
  downloadable: true,
  trackCount: 8,
  badge: { status: 'missing', have: 0, total: 8 },
  ...p,
})

/** SSR output without React's text separators (`<!-- -->`). */
const render = (el: Parameters<typeof renderToString>[0]) => renderToString(el).replace(/<!-- -->/g, '')
let errors: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  errors = vi.spyOn(console, 'error').mockImplementation(() => {})
  Object.assign(useLib.getInitialState(), { jobs: [], pausedSources: {} })
})

afterEach(() => {
  expect(errors.mock.calls.map((c: unknown[]) => String(c[0]))).toEqual([])
  errors.mockRestore()
})

describe('TidalView', () => {
  it('shows the login prompt with the lossless note when logged out', () => {
    Object.assign(useTidalSession.getInitialState(), { status: { loggedIn: false, userId: null, countryCode: null } })
    const html = render(h(TidalView, {}))
    expect(html).toContain('Log in to TIDAL')
    expect(html).toContain('LOSSLESS 16-bit/44.1 kHz FLAC')
    expect(html).toContain('master archived')
  })

  it.each([
    [undefined, undefined],
    ['tracks', undefined],
    ['playlists', undefined],
    ['artists', undefined],
    ['search', 'daft punk'],
    ['album', '100'],
    ['artist', '8'],
    ['playlist', '3f0c5b1e-1111-2222-3333-444455556666'],
  ])('renders tab %s when logged in', (tab, id) => {
    Object.assign(useTidalSession.getInitialState(), { status: { loggedIn: true, userId: '1', countryCode: 'US' } })
    const html = render(h(TidalView, { tab, id }))
    expect(html).toContain('Paste a TIDAL link')
    expect(html).not.toMatch(/Download all/i)
  })

  it('shows the abuse banner while TIDAL is paused', () => {
    Object.assign(useTidalSession.getInitialState(), { status: { loggedIn: true, userId: '1', countryCode: 'US' } })
    Object.assign(useLib.getInitialState(), { pausedSources: { tidal: 'TIDAL reported unusual activity' } })
    const html = render(h(TidalView, {}))
    expect(html).toContain('possible account flag')
    expect(html).toContain('resume from Import')
  })

  it('renders an album with partial badge, missing-tracks action, discs and unavailable tracks', () => {
    const d: TidalAlbumDetail = { album: album(), tracks: [track(1), track(2, { streamable: false }), track(3, { artist: 'Romanthony', artists: [{ id: '9', name: 'Romanthony' }] })] }
    const html = render(h(AlbumBody, { d }))
    expect(html).toContain('◐ 1/3')
    expect(html).toContain('Download Album')
    expect(html).toContain('Download 2 Missing')
    expect(html).toContain('Lossless')
    expect(html).toContain('Disc 2')
    expect(html).toContain('Unavailable')
    expect(html).toContain('Romanthony')
  })

  it('renders a playlist with the .m3u8 explanation', () => {
    const d: TidalPlaylistDetail = {
      playlist: {
        uuid: '3f0c5b1e-1111-2222-3333-444455556666',
        title: 'Mix',
        description: 'Things',
        numberOfTracks: 2,
        durationSec: 400,
        image: null,
        creator: 'Me',
        url: 'https://tidal.com/browse/playlist/x',
        badge: { status: 'partial', have: 1, total: 2 },
      },
      tracks: [track(1), track(2)],
    }
    const html = render(h(PlaylistBody, { d, onDone: () => {} }))
    expect(html).toContain('Download Playlist')
    expect(html).toContain('.m3u8')
  })

  it('renders search sections with a top result', () => {
    const d: TidalSearchResult = {
      artists: [{ id: '8', name: 'Daft Punk', picture: null, url: 'https://tidal.com/browse/artist/8', inLibrary: false }],
      albums: [album(), album({ id: '101', title: 'One More Time', type: 'SINGLE', badge: { status: 'in-library', have: 1, total: 1 } })],
      tracks: Array.from({ length: 12 }, (_, i) => track(i + 1)),
      playlists: [
        { uuid: 'u', title: 'PL', description: null, numberOfTracks: 4, durationSec: 0, image: null, creator: null, url: 'https://tidal.com/browse/playlist/u', badge: null },
      ],
      topHit: { kind: 'album', id: '100' },
    }
    const html = render(h(SearchResults, { d, query: 'daft' }))
    for (const s of ['Top Result', 'Artists', 'Albums, EPs', 'Tracks', 'Playlists', 'Show All 12', 'In Library', 'Single']) expect(html).toContain(s)
  })
})

describe('shared kit', () => {
  it('replaces the download button with the queued badge', () => {
    const running = render(h(DownloadControl, { badge: { status: 'missing', have: 0, total: 3 }, queue: 'running', onDownload: () => {} }))
    expect(running).toContain('Downloading')
    expect(running).not.toContain('icon-btn')
    const idle = render(h(DownloadControl, { badge: { status: 'in-library', have: 3, total: 3 }, queue: null, onDownload: () => {} }))
    expect(idle).toContain('In Library')
    expect(idle).toContain('again')
  })

  it('renders error states by kind', () => {
    expect(render(h(ErrorState, { source: 'tidal', error: new Error('[abuse] flagged'), onRetry: () => {} }))).toContain('Open Import')
    expect(render(h(ErrorState, { source: 'tidal', error: new Error('[auth] expired'), onLogin: () => {} }))).toContain('Log in to TIDAL')
    expect(render(h(ErrorState, { source: 'bandcamp', error: new Error('[rate-limit] slow'), onRetry: () => {} }))).toContain('rate limiting')
  })
})

describe('BandcampView', () => {
  it('shows the login prompt when logged out', () => {
    Object.assign(useBandcampSession.getInitialState(), { status: { loggedIn: false, fanId: null } })
    expect(render(h(BandcampView, {}))).toContain('Log in to Bandcamp')
  })

  it('renders collection and item routes when logged in', () => {
    Object.assign(useBandcampSession.getInitialState(), { status: { loggedIn: true, fanId: 1, username: 'me' } })
    expect(render(h(BandcampView, {}))).toContain('Loading your Bandcamp collection')
    expect(render(h(BandcampView, { id: 'a1' }))).toContain('spinner')
  })

  it('renders the collection header, filters and tiles with explanatory chips', () => {
    const items = [
      purchase(1),
      purchase(2, { badge: { status: 'in-library', have: 8, total: 8 } }),
      purchase(3, { preorder: true, downloadable: false }),
      purchase(4, { itemType: 'package', physicalOnly: true, downloadable: false }),
      purchase(5, { hidden: true, badge: { status: 'partial', have: 2, total: 8 } }),
    ]
    const head = render(h(CollectionHeader, { status: { loggedIn: true, fanId: 1 }, items, fetchedAt: Date.now(), loading: false, onRefresh: () => {} }))
    expect(head).toContain('Download All Missing (2)')
    expect(head).toContain('5 purchases')
    const grid = render(h(CollectionGrid, { items }))
    for (const s of ['Filter by title or artist', 'Purchase Date', 'Show hidden', 'Pre-order', 'Physical only', 'In Library', '◐ 2/8', 'Hidden']) expect(grid).toContain(s)
  })

  it('renders an item detail', () => {
    const i: BandcampItemDetail = {
      ...purchase(1, { badge: { status: 'partial', have: 1, total: 2 } }),
      tracks: [
        { trackId: 1, trackNum: 1, title: 'Intro', artist: 'Some Band', durationMs: 60_000, inLibrary: true },
        { trackId: 2, trackNum: 2, title: 'Song', artist: 'Guest', durationMs: 180_000, inLibrary: false },
      ],
      releaseDate: '2023-02-03',
      label: 'Label',
      tags: ['ambient', 'drone'],
    }
    const html = render(h(ItemBody, { i }))
    for (const s of ['Record 1', 'Download', 'Intro', 'Guest', 'ambient', 'Label', 'a1_16.jpg']) expect(html).toContain(s)
  })
})
