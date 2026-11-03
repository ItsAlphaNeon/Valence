import { describe, expect, it } from 'vitest'
import type { BadgeQueryAlbum, BadgeQueryTrack, EnqueueRequest } from '@main/context'
import { BandcampClient, RateGate } from '@main/sources/bandcamp/client'
import { BandcampService } from '@main/sources/bandcamp/service'
import { BANDCAMP_CHANNELS } from '@shared/ipc/bandcamp'
import type { InLibraryBadge } from '@shared/types'
import { fakeTransport, fixture, fixtureJson, html, json } from '../fixtures/bandcamp/helpers'

function setup(opts: { inLibraryAlbums?: string[]; inLibraryTracks?: string[]; active?: [string, 'queued' | 'running'][] } = {}) {
  let page1 = fixtureJson('collection-1.json')
  const t = fakeTransport((url, call) => {
    if (url.pathname === '/') return html(fixture('homepage.html'))
    if (url.pathname.endsWith('/collection_items')) {
      const body = JSON.parse(call.body!)
      return json(body.older_than_token === '1700000000:2002:t::' ? fixtureJson('collection-2.json') : page1)
    }
    if (url.pathname.endsWith('/hidden_items')) return json(fixtureJson('hidden-1.json'))
    if (url.host === 'synthlabel.bandcamp.com') return html(fixture('album-page.html'))
  })
  const broadcasts: string[] = []
  const enqueued: EnqueueRequest[] = []
  const albumQueries: BadgeQueryAlbum[] = []
  const badge = (q: BadgeQueryAlbum): InLibraryBadge => {
    albumQueries.push(q)
    const total = q.trackCount ?? 0
    return opts.inLibraryAlbums?.includes(q.bandcampAlbumId!) ? { status: 'in-library', have: total, total } : { status: 'missing', have: 0, total }
  }
  let loggedIn = true
  const ctx = {
    library: {
      albumBadge: badge,
      albumBadges: (qs: BadgeQueryAlbum[]) => qs.map(badge),
      matchTracks: (ts: BadgeQueryTrack[]) => ts.map((x) => !!opts.inLibraryTracks?.includes(x.bandcampTrackId!)),
    },
    imports: {
      registerAcquirer: () => {},
      enqueue: (r: EnqueueRequest) => (enqueued.push(r), `job-${enqueued.length}`),
      activeKeys: () => new Map(opts.active ?? []),
      pauseSource: () => {},
      resumeSource: () => {},
    },
    broadcast: (ch: string) => void broadcasts.push(ch),
    log: { info: () => {}, warn: () => {}, error: () => {} },
  }
  const auth = {
    isLoggedIn: async () => loggedIn,
    login: async () => (loggedIn = true),
    logout: async () => void (loggedIn = false),
  }
  const service = new BandcampService({ ctx, client: new BandcampClient({ transport: t, gate: new RateGate() }), auth })
  return { service, t, broadcasts, enqueued, albumQueries, setPage1: (p: unknown) => (page1 = p), setLoggedIn: (v: boolean) => (loggedIn = v) }
}

const apiCalls = (t: { calls: { url: string }[] }) => t.calls.filter((c) => c.url.includes('/api/')).length

describe('BandcampService', () => {
  it('reports status from the cookie and homepage identity', async () => {
    const s = setup()
    expect(await s.service.status()).toEqual({ loggedIn: true, fanId: 5550001, username: 'synthfan' })
    s.setLoggedIn(false)
    expect(await s.service.status()).toEqual({ loggedIn: false, fanId: null })
  })

  it('lists all items with badges and caches for 10 minutes', async () => {
    const s = setup({ inLibraryAlbums: ['1001'], active: [['bc:track:2002', 'running']] })
    const c = await s.service.collection()
    expect(c.items.map((i) => i.key)).toEqual(['a9001', 't9002', 'p9003', 'p9004', 'a9005', 'a9006'])
    const byKey = Object.fromEntries(c.items.map((i) => [i.key, i]))
    expect(byKey.a9001).toMatchObject({ badge: { status: 'in-library', have: 3, total: 3 }, downloadable: true, artUrl: 'https://f4.bcbits.com/img/a111_2.jpg', trackCount: 3 })
    expect(byKey.t9002).toMatchObject({ tralbumType: 'track', queue: 'running' })
    expect(byKey.a9006.hidden).toBe(true)
    expect(byKey.p9003).toMatchObject({ physicalOnly: true, downloadable: false })
    expect(s.albumQueries.find((q) => q.bandcampAlbumId === '1001')).toMatchObject({ albumArtist: 'Synth Artist', title: 'Synthetic Album', trackCount: 3 })
    expect(s.albumQueries.find((q) => q.bandcampAlbumId === '1001')?.tracks?.map((x) => x.bandcampTrackId)).toEqual(['7001', '7002', '7003'])

    const n = apiCalls(s.t)
    await s.service.collection()
    expect(apiCalls(s.t)).toBe(n)
    await s.service.collection({ refresh: true })
    expect(apiCalls(s.t)).toBe(2 * n)
    expect(s.broadcasts).toEqual([])
  })

  it('broadcasts collection-updated when a refresh changes the list', async () => {
    const s = setup()
    await s.service.collection()
    const p1 = fixtureJson('collection-1.json')
    s.setPage1({ ...p1, items: p1.items.slice(0, 1) })
    await s.service.collection({ refresh: true })
    expect(s.broadcasts).toEqual([BANDCAMP_CHANNELS.collectionUpdated])
  })

  it('returns an item with per-track inLibrary from the album page', async () => {
    const s = setup({ inLibraryTracks: ['7002'] })
    const d = await s.service.item('a9001')
    expect(d).toMatchObject({ key: 'a9001', releaseDate: '2023-09-05', label: 'Synth Label', tags: ['electronic', 'ambient', 'Berlin'] })
    expect(d.tracks.map((x) => [x.trackNum, x.title, x.artist, x.inLibrary])).toEqual([
      [1, 'Opening & "Intro"', 'Synth Artist', false],
      [2, 'Café Noir', 'Guest Singer', true],
      [3, 'Closing Theme', 'Synth Artist', false],
    ])
  })

  it('enqueues a download with the acquirer payload', async () => {
    const s = setup()
    expect(await s.service.download('a9001')).toBe('job-1')
    expect(s.enqueued[0]).toEqual({
      source: 'bandcamp',
      title: 'Synth Artist — Synthetic Album',
      releaseKeys: ['bc:album:1001'],
      payload: {
        itemKey: 'a9001',
        saleItemType: 'a',
        saleItemId: 9001,
        redownloadUrl: 'https://bandcamp.com/download?from=collection&payment_id=1&sig=aaa&sitem_id=9001',
        itemUrl: 'https://synthlabel.bandcamp.com/album/synthetic-album',
        tralbumId: 1001,
        tralbumType: 'album',
      },
    })
    await expect(s.service.download('p9003')).rejects.toMatchObject({ kind: 'unavailable', message: expect.stringMatching(/no digital download/) })
    await expect(s.service.download('a9005')).rejects.toMatchObject({ kind: 'unavailable', message: expect.stringMatching(/pre-order/) })
    await expect(s.service.download('zzz')).rejects.toMatchObject({ kind: 'unavailable' })
  })

  it('downloadAllMissing skips in-library, queued, pre-order and physical-only items', async () => {
    const s = setup({ inLibraryAlbums: ['1001'], active: [['bc:track:2002', 'queued']] })
    expect(await s.service.downloadAllMissing()).toBe(2)
    expect(s.enqueued.map((e) => e.releaseKeys[0])).toEqual(['bc:album:4100', 'bc:album:6006'])
    expect(s.broadcasts).toEqual([BANDCAMP_CHANNELS.collectionUpdated])
  })

  it('refuses the collection when logged out, and logout clears state', async () => {
    const s = setup()
    await s.service.collection()
    expect(await s.service.logout()).toEqual({ loggedIn: false, fanId: null })
    expect(s.broadcasts).toEqual([BANDCAMP_CHANNELS.collectionUpdated])
    await expect(s.service.collection()).rejects.toMatchObject({ kind: 'auth' })
  })
})
