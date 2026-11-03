import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createMetadataService, memoryCache, RateLimiter } from '@main/metadata'
import { fetchLyrics, lyricsFromRecord, pickSearchResult, type LrclibRecord } from '@main/metadata/lyrics'
import { lookupAcoustid, runFpcalc } from '@main/metadata/acoustid'
import { VA_ID, type MbRelease } from '@main/metadata/musicbrainz'
import { fpcalcPath } from '@main/platform/binaries'
import { fixtureTransport } from '../fixtures/meta/transport'

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } })
const lim = () => new RateLimiter(0)
const UA = 'Valence/0.1 ( https://github.com/valence-music-app )'

describe('LRCLIB', () => {
  afterEach(() => vi.useRealTimers())
  const synced = '[00:01.00] line one\r\n[00:04.50] line two'

  it('normalises records', () => {
    expect(lyricsFromRecord({ syncedLyrics: synced, plainLyrics: 'line one\r\nline two' })).toEqual({ synced: '[00:01.00] line one\n[00:04.50] line two', plain: 'line one\nline two' })
    expect(lyricsFromRecord({ syncedLyrics: '  ', plainLyrics: 'x' })).toEqual({ plain: 'x' })
    expect(lyricsFromRecord({ syncedLyrics: null, plainLyrics: null, instrumental: true })).toBeNull()
    expect(lyricsFromRecord(null)).toBeNull()
  })

  it('search fallback takes the closest duration within ±2 s, synced breaking ties', () => {
    const rs: LrclibRecord[] = [
      { id: 1, duration: 223, plainLyrics: 'far' },
      { id: 2, duration: 218.6, plainLyrics: 'plain' },
      { id: 3, duration: 219.4, syncedLyrics: '[00:00.00] s', plainLyrics: 's' },
      { id: 4, duration: 219, plainLyrics: null, syncedLyrics: null },
    ]
    expect(pickSearchResult(rs, 219)?.id).toBe(3)
    expect(pickSearchResult(rs, 230)).toBeNull()
    expect(pickSearchResult([{ id: 5, duration: 221, plainLyrics: 'p' }, { id: 6, duration: 217, syncedLyrics: '[00:00.00] s' }], 219)?.id).toBe(6)
  })

  it('get hit, 404 → search fallback, instrumental → null', async () => {
    const urls: string[] = []
    let mode: 'hit' | 'miss' | 'instrumental' = 'hit'
    const transport = async (url: string) => {
      urls.push(url)
      if (url.includes('/api/get?')) {
        if (mode === 'hit') return json({ id: 9, trackName: 'T', duration: 200, syncedLyrics: synced, plainLyrics: 'a' })
        if (mode === 'instrumental') return json({ id: 10, instrumental: true, plainLyrics: null, syncedLyrics: null })
        return json({ code: 404, name: 'TrackNotFound' }, 404)
      }
      return json([{ id: 11, duration: 260, plainLyrics: 'wrong' }, { id: 12, duration: 201, plainLyrics: 'right' }])
    }
    const deps = { transport, cache: memoryCache(), limiter: lim(), userAgent: UA }
    const q = { artist: 'Ärtist', title: 'Song & Dance', album: 'LP', durationMs: 200_400 }
    expect((await fetchLyrics(deps, q))?.synced).toContain('line two')
    expect(urls[0]).toBe('https://lrclib.net/api/get?artist_name=%C3%84rtist&track_name=Song+%26+Dance&album_name=LP&duration=200')
    mode = 'miss'
    expect(await fetchLyrics({ ...deps, cache: memoryCache() }, q)).toEqual({ plain: 'right' })
    expect(urls.at(-1)).toBe('https://lrclib.net/api/search?track_name=Song+%26+Dance&artist_name=%C3%84rtist')
    mode = 'instrumental'
    const n = urls.length
    expect(await fetchLyrics({ ...deps, cache: memoryCache() }, q)).toBeNull()
    expect(urls.length - n).toBe(1)
  })

  it('an overloaded get endpoint (503) retries, then falls back to search', async () => {
    vi.useFakeTimers()
    let gets = 0
    const transport = async (url: string) => (url.includes('/get?') ? (gets++, new Response('busy', { status: 503, headers: { 'Retry-After': '1' } })) : json([{ duration: 100, plainLyrics: 'ok' }]))
    const p = fetchLyrics({ transport, limiter: lim(), userAgent: UA }, { artist: 'a', title: 't', durationMs: 100_000 })
    await vi.advanceTimersByTimeAsync(10_000)
    expect(await p).toEqual({ plain: 'ok' })
    expect(gets).toBe(4)
  })

  it('replays recorded LRCLIB responses (lyric text replaced by placeholders)', async () => {
    const fx = fixtureTransport(resolve('tests/fixtures/meta/lrclib'))
    const svc = createMetadataService({ transport: fx.transport, contact: () => '', appVersion: '0.1', acoustidKey: () => null, limiters: { lrclib: process.env.VALENCE_RECORD ? new RateLimiter(1100) : lim() } })
    const exact = await svc.lyrics({ artist: 'Porter Robinson', title: 'Get Your Wish', album: 'Nurture', durationMs: 219_000 })
    expect(exact?.synced).toMatch(/^\[\d\d:\d\d\.\d\d\]/)
    expect(exact?.plain).toBeTruthy()
    const fallback = await svc.lyrics({ artist: 'Porter Robinson', title: 'Get Your Wish', album: 'Porter Robinson - Singles', durationMs: 219_500 })
    expect(fallback?.synced ?? fallback?.plain).toBeTruthy()
    expect(await svc.lyrics({ artist: 'Zzyzx Nobody', title: 'Qqq Nonexistent Song', durationMs: 100_000 })).toBeNull()
    if (!process.env.VALENCE_RECORD) expect(fx.misses).toEqual([])
  })
})

// ---------- AcoustID (synthetic: no API key exists for recording) ----------

const REC = 'cccccccc-1111-4000-8000-000000000001'
const ALBUM = 'bbbbbbbb-1111-4000-8000-000000000001'
const COMP = 'bbbbbbbb-1111-4000-8000-000000000002'
const ARTIST = [{ name: 'Neon Coast', artist: { id: 'aaaaaaaa-1111-4000-8000-000000000001', name: 'Neon Coast', 'sort-name': 'Neon Coast' } }]

const TITLES = ['Night Drive', 'Glass Hours', 'Tidewater']
const recFor = (i: number) => (i === 1 ? REC : `cccccccc-1111-4000-8000-00000000009${i}`)

const lookupBody = (score = 0.93, i = 1) => ({
  status: 'ok',
  results: [
    {
      id: 'acoustid-1',
      score,
      recordings: [
        {
          id: recFor(i),
          title: TITLES[i],
          duration: 187,
          artists: [{ id: 'aaaaaaaa-1111-4000-8000-000000000001', name: 'Neon Coast' }],
          releasegroups: [
            { id: 'dddddddd-1111-4000-8000-000000000001', type: 'Album', title: 'Night Drive', releases: [{ id: ALBUM, title: 'Night Drive', country: 'XW', date: { year: 2020, month: 3, day: 6 }, track_count: 3 }] },
            { id: 'dddddddd-1111-4000-8000-000000000002', type: 'Album', secondarytypes: ['Compilation'], title: 'Synthwave Summer', releases: [{ id: COMP, title: 'Synthwave Summer', date: { year: 2019 }, track_count: 20 }] },
          ],
        },
        { id: 'cccccccc-1111-4000-8000-000000000002', title: 'Too Long Edit', duration: 240 },
      ],
    },
    { id: 'acoustid-2', score: 0.41, recordings: [{ id: 'cccccccc-1111-4000-8000-000000000003', title: 'Weak', duration: 187 }] },
  ],
})

const album = (): MbRelease => ({
  id: ALBUM,
  title: 'Night Drive',
  status: 'Official',
  date: '2020-03-06',
  country: 'XW',
  'artist-credit': ARTIST,
  'release-group': { id: 'dddddddd-1111-4000-8000-000000000001', 'primary-type': 'Album', 'first-release-date': '2020-03-06', genres: [{ name: 'synthwave', count: 3 }] },
  media: [{ position: 1, format: 'Digital Media', 'track-count': 3, tracks: TITLES.map((title, i) => ({ id: `eeeeeeee-1111-4000-8000-00000000000${i}`, position: i + 1, number: String(i + 1), title, length: 187_000, 'artist-credit': ARTIST, recording: { id: recFor(i), title, length: 187_000 } })) }],
})

function acoustidWorld(score = 0.93) {
  const seen: Array<{ url: string; body?: string }> = []
  const transport = async (url: string, init?: RequestInit) => {
    seen.push({ url, body: typeof init?.body === 'string' ? init.body : undefined })
    if (url.startsWith('https://api.acoustid.org/')) {
      const m = /^AQAAfp([0-9])$/.exec(new URLSearchParams(String(init?.body)).get('fingerprint') ?? '')
      return json(lookupBody(score, m ? Number(m[1]) : 1))
    }
    if (url.includes(`/release/${ALBUM}`)) return json(album())
    if (url.includes(`/release/${COMP}`)) return json({ ...album(), id: COMP, title: 'Synthwave Summer', 'artist-credit': [{ name: 'Various Artists', artist: { id: VA_ID, name: 'Various Artists' } }] })
    return json({ releases: [], recordings: [] })
  }
  return { seen, transport }
}

describe('AcoustID', () => {
  it('parses lookups: score ≥ 0.80, duration ±7 s, releases in MB shape; POST body and cache', async () => {
    const { seen, transport } = acoustidWorld()
    const cache = memoryCache()
    const fp = { fingerprint: 'AQAAfake', duration: 186.6 }
    const ms = await lookupAcoustid({ transport, cache, limiter: lim() }, 'k3y', fp)
    expect(ms).toHaveLength(1)
    expect(ms[0]).toMatchObject({ acoustid: 'acoustid-1', score: 0.93, recordingId: REC, title: 'Glass Hours', artist: 'Neon Coast' })
    expect(ms[0].releases.map((r) => [r.id, r.date, r['release-group']?.['primary-type'], r['release-group']?.['secondary-types']])).toEqual([
      [ALBUM, '2020-03-06', 'Album', undefined],
      [COMP, '2019', 'Album', ['Compilation']],
    ])
    const body = new URLSearchParams(seen[0].body)
    expect(Object.fromEntries(body)).toEqual({ client: 'k3y', format: 'json', meta: 'recordings releasegroups releases', duration: '187', fingerprint: 'AQAAfake' })
    await lookupAcoustid({ transport, cache, limiter: lim() }, 'k3y', fp)
    expect(seen).toHaveLength(1)
  })

  it('identifies a tagless singleton by fingerprint and prefers the album over the compilation', async () => {
    const { seen, transport } = acoustidWorld()
    const svc = createMetadataService({ transport, cache: memoryCache(), contact: () => '', appVersion: '0.1', acoustidKey: () => 'k3y', limiters: { musicbrainz: lim(), acoustid: lim() } })
    const res = await svc.identify({ source: 'import', albumTags: {}, tracks: [{ index: 0, durationMs: 187_300, tags: {}, fingerprint: { fingerprint: 'AQAAfake', duration: 187 } }] })
    expect(res.status).toBe('auto')
    expect(res.release?.releaseId).toBe(ALBUM)
    expect(res.trackTags[0]).toMatchObject({ title: 'Glass Hours', tracknumber: 2, musicbrainz_recordingid: REC })
    expect(seen.some((s) => s.url.includes('acoustid'))).toBe(true)
  })

  it('a 0.80–0.85 singleton match is only proposed for review', async () => {
    const { transport } = acoustidWorld(0.82)
    const svc = createMetadataService({ transport, cache: memoryCache(), contact: () => '', appVersion: '0.1', acoustidKey: () => 'k3y', limiters: { musicbrainz: lim(), acoustid: lim() } })
    const res = await svc.identify({ source: 'import', albumTags: {}, tracks: [{ index: 0, durationMs: 187_000, tags: {}, fingerprint: { fingerprint: 'AQAAfake', duration: 187 } }] })
    expect(res.status).toBe('review')
  })

  it('tagless album: fingerprints find the release and count as recording-id evidence', async () => {
    const { transport } = acoustidWorld()
    const svc = createMetadataService({ transport, cache: memoryCache(), contact: () => '', appVersion: '0.1', acoustidKey: () => 'k3y', limiters: { musicbrainz: lim(), acoustid: lim() } })
    const tracks = TITLES.map((_, i) => ({ index: i, durationMs: 187_000, tags: {}, fingerprint: { fingerprint: `AQAAfp${i}`, duration: 187 } }))
    const res = await svc.identify({ source: 'import', albumTags: {}, tracks })
    expect(res.release?.releaseId).toBe(ALBUM)
    expect(res.status).toBe('auto')
    expect(res.trackTags.map((t) => t?.title)).toEqual(TITLES)
  })

  it('without a key AcoustID is never called', async () => {
    const { seen, transport } = acoustidWorld()
    const svc = createMetadataService({ transport, cache: memoryCache(), contact: () => '', appVersion: '0.1', acoustidKey: () => '  ', fpcalcPath: () => { throw new Error('fpcalc must not run') }, limiters: { musicbrainz: lim() } })
    const res = await svc.identify({ source: 'import', albumTags: {}, tracks: [{ index: 0, durationMs: 187_000, tags: {}, file: 'x.mp3' }] })
    expect(res.status).toBe('unmatched')
    expect(seen.some((s) => s.url.includes('acoustid'))).toBe(false)
  })

  const bin = fpcalcPath()
  const realDir = resolve('test-data/real')
  const mp3 = existsSync(realDir) ? readdirSync(realDir, { recursive: true, encoding: 'utf8' }).find((f) => f.endsWith('.mp3')) : undefined
  it.skipIf(!bin || !mp3)('fpcalc fingerprints a real file (read-only)', async () => {
    const fp = await runFpcalc(bin!, join(realDir, mp3!))
    expect(fp?.fingerprint).toMatch(/^AQA/)
    expect(fp?.duration).toBeGreaterThan(10)
    expect(await runFpcalc(bin!, join(realDir, 'does-not-exist.mp3'))).toBeNull()
  })
})
