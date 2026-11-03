import { describe, expect, it } from 'vitest'
import { TidalApi } from '@main/sources/tidal/api'
import { TidalClient } from '@main/sources/tidal/client'
import { resolveConfig } from '@main/sources/tidal/config'
import { createTidalService } from '@main/sources/tidal/service'
import type { TidalTrack } from '@main/sources/tidal/types'
import { fakeAuth, fakeContext, fixture, json, router } from '../fixtures/tidal/support'

const cfg = resolveConfig(undefined, { apiV1: 'https://api.test/v1', apiV2: 'https://api.test/v2' })
const album = fixture('album-multidisc.json')
const tracks = fixture<{ items: TidalTrack[] }>('album-multidisc-tracks.json').items
const UUID = '0f0b1c2d-3e4f-5a6b-7c8d-9e0fa1b2c3d4'

function setup(inLibrary: string[] = [], active = new Map<string, 'queued' | 'running'>()) {
  const t = router((c) => {
    const p = c.url.pathname
    if (p === '/v1/albums/100') return json(album)
    if (p === '/v1/albums/100/tracks') return json({ limit: 100, offset: 0, totalNumberOfItems: tracks.length, items: tracks })
    if (p === '/v1/tracks/1002') return json(tracks[1])
    if (p === `/v1/playlists/${UUID}`) return json({ uuid: UUID, title: 'Road Trip', numberOfTracks: 5, duration: 900, squareImage: 'aaaa-bbbb' })
    if (p === `/v1/playlists/${UUID}/tracks`) {
      const items = [tracks[0], tracks[1], tracks[1], tracks[4], tracks[2]]
      return json({ limit: 100, offset: 0, totalNumberOfItems: items.length, items })
    }
    if (p === '/v1/users/42/favorites/albums') return json({ limit: 50, offset: 0, totalNumberOfItems: 1, items: [{ created: 'x', item: album }] })
    if (p === '/v1/search')
      return json({ albums: { items: [album] }, tracks: { items: [tracks[0]] }, artists: { items: [{ id: 7, name: 'Kaos & Ethos' }] }, playlists: { items: [] }, topHit: { type: 'ALBUMS', value: { id: 100 } } })
    return undefined
  })
  const ctx = fakeContext((q) => inLibrary.includes(q.tidalTrackId ?? ''), active)
  const api = new TidalApi(new TidalClient({ cfg, auth: fakeAuth(), transport: t }), () => '42')
  const svc = createTidalService({ ctx, api, auth: { status: () => ({ loggedIn: true, userId: '42', countryCode: 'US' }), login: async () => ({ loggedIn: true, userId: '42', countryCode: 'US' }), logout: () => {} } })
  return { t, ctx, svc }
}

describe('tidal service', () => {
  it('album(): per-track inLibrary, album badge and queue state', async () => {
    const { svc } = setup(['1001', '1003'], new Map([['tidal:album:100', 'running']]))
    const d = await svc.album('100')
    expect(d.album).toMatchObject({ id: '100', title: 'Test Album (Deluxe Edition)', artist: 'Kaos & Ethos', numberOfVolumes: 2, queue: 'running', year: 2021 })
    expect(d.album.badge).toEqual({ status: 'partial', have: 2, total: 5 })
    expect(d.tracks.map((t) => t.inLibrary)).toEqual([true, false, true, false, false])
    expect(d.tracks[4].streamable).toBe(false)
    expect(d.tracks[1]).toMatchObject({ title: 'Second Song (Club Mix)', artist: 'Kaos & Ethos & Partner', queue: 'running' })
  })

  it('favorites(albums) and search() return summaries with badges', async () => {
    const { svc } = setup()
    const fav = await svc.favorites('albums', 0, 50)
    expect(fav.total).toBe(1)
    expect((fav.items[0] as any).badge).toEqual({ status: 'missing', have: 0, total: 5 })
    const s = await svc.search('kaos')
    expect(s.topHit).toEqual({ kind: 'album', id: '100' })
    expect(s.albums[0].cover).toMatch(/640x640\.jpg$/)
    expect(s.artists[0]).toMatchObject({ id: '7', inLibrary: false })
    expect(await svc.search('  ')).toEqual({ artists: [], albums: [], tracks: [], playlists: [], topHit: null })
  })

  it('download(): enqueues album and track jobs with the right keys and payloads', async () => {
    const { ctx, svc } = setup()
    const a = await svc.download({ kind: 'album', id: '100', onlyMissing: true })
    const t = await svc.download({ kind: 'track', id: '1002' })
    expect(a.jobId).toBe('job-1')
    expect(ctx.enqueued[0]).toEqual({
      source: 'tidal',
      title: 'TIDAL · Kaos & Ethos — Test Album (Deluxe Edition) (missing tracks)',
      releaseKeys: ['tidal:album:100', 'upc:0123456789012'],
      payload: { kind: 'album', id: '100', onlyMissing: true },
    })
    expect(t.releaseKeys).toEqual(['tidal:track:1002'])
    expect(ctx.enqueued[1].payload).toEqual({ kind: 'track', id: '1002' })
    await expect(svc.download({ kind: 'album', id: '../users/1' })).rejects.toMatchObject({ kind: 'parse' })
  })

  it('downloadPlaylist(): queues missing streamable tracks once each, then mirrors the playlist', async () => {
    const { ctx, svc } = setup(['1001'], new Map([['tidal:track:1003', 'queued']]))
    const r = await svc.downloadPlaylist(UUID)
    expect(r).toEqual({ queued: 1, alreadyInLibrary: 1, alreadyQueued: 1, unavailable: 1, jobIds: ['job-1'] })
    expect(ctx.enqueued.map((e) => [e.payload, e.releaseKeys])).toEqual([[{ kind: 'track', id: '1002' }, ['tidal:track:1002']]])
    expect(ctx.mirrored).toHaveLength(1)
    expect(ctx.mirrored[0].name).toBe('Road Trip')
    expect(ctx.mirrored[0].sourceKey).toBe(`tidal:playlist:${UUID}`)
    expect(ctx.mirrored[0].tracks.map((q) => q.tidalTrackId)).toEqual(['1001', '1002', '1002', '1005', '1003'])
  })

  it('playlist(): badge counts tracks in the library', async () => {
    const { svc } = setup(['1001', '1002'])
    const d = await svc.playlist(UUID.toUpperCase())
    expect(d.playlist.badge).toEqual({ status: 'partial', have: 3, total: 5 })
    expect(d.playlist.image).toMatch(/aaaa\/bbbb\/640x640\.jpg$/)
  })

  it('track(): summary with library badge for pasted track links', async () => {
    const { svc } = setup(['1002'], new Map([['tidal:track:1002', 'queued']]))
    const t = await svc.track('1002')
    expect(t).toMatchObject({ id: '1002', title: 'Second Song (Club Mix)', inLibrary: true, queue: 'queued', url: 'https://tidal.com/browse/track/1002' })
    await expect(svc.track('abc')).rejects.toThrow(/Invalid TIDAL track id/)
  })

  it('resolveLink() delegates to the link parser', () => {
    const { svc } = setup()
    expect(svc.resolveLink('https://tidal.com/browse/track/1002?u')).toEqual({ kind: 'track', id: '1002' })
    expect(svc.resolveLink('https://example.com')).toBeNull()
  })
})
