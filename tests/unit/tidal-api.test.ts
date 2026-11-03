import { describe, expect, it } from 'vitest'
import { TidalApi } from '@main/sources/tidal/api'
import { TidalClient } from '@main/sources/tidal/client'
import { resolveConfig } from '@main/sources/tidal/config'
import { fakeAuth, json, router, type Call } from '../fixtures/tidal/support'

const cfg = resolveConfig(undefined, { apiV1: 'https://api.test/v1', apiV2: 'https://api.test/v2' })
const mk = (...routes: Parameters<typeof router>) => {
  const t = router(...routes)
  return { t, api: new TidalApi(new TidalClient({ cfg, auth: fakeAuth(), transport: t }), () => '42') }
}
const pl = (n: number) => ({ uuid: `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`, title: `P${n}` })

describe('TidalApi favorites', () => {
  it('requests a page with limit, offset and DATE desc ordering', async () => {
    const { t, api } = mk((c) =>
      c.url.pathname === '/v1/users/42/favorites/albums'
        ? json({ limit: 2, offset: 4, totalNumberOfItems: 9, items: [{ created: 'x', item: { id: 1 } }, { created: 'y', item: { id: 2 } }] })
        : undefined,
    )
    const page = await api.favoriteAlbums(4, 2)
    expect(page.items.map((i) => i.item.id)).toEqual([1, 2])
    const q = Object.fromEntries(t.calls[0].url.searchParams)
    expect(q).toMatchObject({ limit: '2', offset: '4', order: 'DATE', orderDirection: 'DESC', countryCode: 'US' })
  })

  it('clamps limit to 100 and uses the right path per kind', async () => {
    const { t, api } = mk(() => json({ limit: 100, offset: 0, totalNumberOfItems: 0, items: [] }))
    await api.favoriteTracks(0, 500)
    await api.favoriteArtists()
    expect(t.calls[0].url.pathname).toBe('/v1/users/42/favorites/tracks')
    expect(t.calls[0].url.searchParams.get('limit')).toBe('100')
    expect(t.calls[1].url.pathname).toBe('/v1/users/42/favorites/artists')
  })
})

describe('TidalApi playlists', () => {
  it('pages the v2 folder endpoint by cursor (≤50) and dedupes by uuid', async () => {
    const pages: Record<string, unknown> = {
      '': { items: [1, 2, 3].map((n) => ({ itemType: 'PLAYLIST', data: pl(n) })), totalNumberOfItems: 5, cursor: 'c2' },
      c2: { items: [3, 4].map((n) => ({ itemType: 'PLAYLIST', data: pl(n) })), totalNumberOfItems: 5, cursor: 'c3' },
      c3: { items: [4, 5].map((n) => ({ itemType: 'PLAYLIST', data: pl(n) })), totalNumberOfItems: 5, cursor: null },
    }
    const { t, api } = mk((c: Call) =>
      c.url.pathname === '/v2/my-collection/playlists/folders' ? json(pages[c.url.searchParams.get('cursor') ?? '']) : undefined,
    )
    const all = await api.playlists()
    expect(all.map((p) => p.title)).toEqual(['P1', 'P2', 'P3', 'P4', 'P5'])
    expect(t.calls).toHaveLength(3)
    for (const c of t.calls) {
      expect(c.url.searchParams.get('folderId')).toBe('root')
      expect(c.url.searchParams.get('includeOnly')).toBe('PLAYLIST')
      expect(Number(c.url.searchParams.get('limit'))).toBeLessThanOrEqual(50)
    }
  })

  it('stops when a page adds nothing new (offset ignored, no cursor)', async () => {
    const { t, api } = mk(() => json({ items: Array.from({ length: 50 }, (_, i) => ({ data: pl(i) })) }))
    expect(await api.playlists()).toHaveLength(50)
    expect(t.calls).toHaveLength(2)
  })

  it('falls back to v1 playlistsAndFavoritePlaylists when v2 fails', async () => {
    const { t, api } = mk(
      (c) => (c.url.pathname.startsWith('/v2/') ? json({ status: 404 }, 404) : undefined),
      (c) =>
        c.url.pathname === '/v1/users/42/playlistsAndFavoritePlaylists'
          ? json(
              c.url.searchParams.get('offset') === '0'
                ? { limit: 50, offset: 0, totalNumberOfItems: 52, items: Array.from({ length: 50 }, (_, i) => ({ type: 'USER_CREATED', playlist: pl(i) })) }
                : { limit: 50, offset: 50, totalNumberOfItems: 52, items: [49, 50, 51].map((i) => ({ type: 'USER_FAVORITE', playlist: pl(i) })) },
            )
          : undefined,
    )
    const all = await api.playlists()
    expect(all).toHaveLength(52)
    expect(new Set(all.map((p) => p.uuid)).size).toBe(52)
    expect(t.calls.filter((c) => c.url.pathname.startsWith('/v1/'))).toHaveLength(2)
  })

  it('does not fall back on auth failures', async () => {
    const { api } = mk(() => new Response('', { status: 401 }))
    await expect(api.playlists()).rejects.toMatchObject({ kind: 'auth' })
  })
})

describe('TidalApi collections', () => {
  it('pages album tracks until totalNumberOfItems', async () => {
    const { t, api } = mk((c) => {
      if (c.url.pathname !== '/v1/albums/9/tracks') return undefined
      const offset = Number(c.url.searchParams.get('offset'))
      const n = Math.min(100, 150 - offset)
      return json({ limit: 100, offset, totalNumberOfItems: 150, items: Array.from({ length: n }, (_, i) => ({ id: offset + i })) })
    })
    const tracks = await api.albumTracks(9)
    expect(tracks).toHaveLength(150)
    expect(tracks.at(-1)!.id).toBe(149)
    expect(t.calls.map((c) => c.url.searchParams.get('offset'))).toEqual(['0', '100'])
  })

  it('passes artist album filters and search types', async () => {
    const { t, api } = mk(() => json({ limit: 100, offset: 0, totalNumberOfItems: 0, items: [] }))
    await api.artistAlbums(5, 'EPSANDSINGLES')
    await api.artistAlbums(5, 'COMPILATIONS')
    await api.search('daft punk', ['ALBUMS', 'TRACKS'], 10)
    expect(t.calls[0].url.searchParams.get('filter')).toBe('EPSANDSINGLES')
    expect(t.calls[1].url.searchParams.get('filter')).toBe('COMPILATIONS')
    expect(Object.fromEntries(t.calls[2].url.searchParams)).toMatchObject({ query: 'daft punk', types: 'ALBUMS,TRACKS', limit: '10' })
  })

  it('requests playbackinfo with the stream parameters and never caches it', async () => {
    const { t, api } = mk(() => json({ trackId: 1, manifestMimeType: 'x', manifest: '' }))
    await api.playbackInfo(1)
    await api.playbackInfo(1)
    expect(t.calls).toHaveLength(2)
    expect(t.calls[0].url.pathname).toBe('/v1/tracks/1/playbackinfopostpaywall')
    expect(Object.fromEntries(t.calls[0].url.searchParams)).toMatchObject({ playbackmode: 'STREAM', audioquality: 'LOSSLESS', assetpresentation: 'FULL' })
  })

  it('returns null lyrics on 404', async () => {
    const { api } = mk(() => json({ status: 404, userMessage: 'Lyrics not found' }, 404))
    expect(await api.lyrics(1)).toBeNull()
  })
})
