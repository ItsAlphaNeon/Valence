// End-to-end acquire against a local 127.0.0.1 server: BTS FLAC, a real ffmpeg-made DASH FLAC
// stream, BTS AAC, and a DRM track that must be skipped. No TIDAL traffic.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ffmpegOrThrow, pcmMd5 } from '@main/media/ffmpeg'
import type { AcquireProgress } from '@main/import/source-types'
import { acquire, type AcquirerDeps } from '@main/sources/tidal/acquirer'
import { TidalApi } from '@main/sources/tidal/api'
import { TidalClient } from '@main/sources/tidal/client'
import { resolveConfig } from '@main/sources/tidal/config'
import { downloadStream } from '@main/sources/tidal/downloader'
import { parseDash } from '@main/sources/tidal/manifest'
import { Pacer } from '@main/sources/tidal/pacing'
import { genAudio } from '../helpers/audio'
import { sandbox } from '../helpers/sandbox'
import { fakeAuth, fakeContext, fixture } from '../fixtures/tidal/support'

const sb = sandbox('tidal-e2e')
const SRC = join(sb.dir, 'src')
const DASH = join(sb.dir, 'dash')
let server: Server
let origin = ''
let mpd = ''
const hits: Array<{ path: string; query: URLSearchParams; auth?: string }> = []

const album = fixture('album-multidisc.json')
const tracksPage = fixture('album-multidisc-tracks.json')
const b64 = (s: string) => Buffer.from(s).toString('base64')

function playbackInfo(id: string): unknown {
  const pointAtServer = (name: string) => {
    const info = fixture(name)
    return { ...info, manifest: b64(Buffer.from(info.manifest, 'base64').toString('utf8').replaceAll('__SERVER__', origin)) }
  }
  if (id === '1001') return pointAtServer('playbackinfo-bts-flac.json')
  if (id === '1002') return { ...fixture<Record<string, unknown>>('playbackinfo-dash.json'), manifest: b64(mpd) }
  if (id === '1003') return pointAtServer('playbackinfo-bts-aac.json')
  if (id === '1004') return pointAtServer('playbackinfo-bts-drm.json')
  return null
}

function handler(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? '/', origin)
  hits.push({ path: url.pathname, query: url.searchParams, auth: req.headers.authorization })
  const send = (status: number, body: string | Buffer, type = 'application/json') => {
    res.writeHead(status, { 'content-type': type, 'content-length': Buffer.byteLength(body) })
    res.end(body)
  }
  const p = url.pathname
  const notFound = () => send(404, JSON.stringify({ status: 404, subStatus: 2001, userMessage: 'Not found' }))
  if (p === '/v1/albums/100') return send(200, JSON.stringify(album))
  if (p === '/v1/albums/100/tracks') return send(200, JSON.stringify(tracksPage))
  let m = /^\/v1\/tracks\/(\d+)$/.exec(p)
  if (m) {
    const t = tracksPage.items.find((x: { id: number }) => String(x.id) === m![1])
    return t ? send(200, JSON.stringify(t)) : notFound()
  }
  if ((m = /^\/v1\/tracks\/(\d+)\/playbackinfopostpaywall$/.exec(p))) {
    const info = playbackInfo(m[1])
    return info ? send(200, JSON.stringify(info)) : notFound()
  }
  if ((m = /^\/v1\/tracks\/(\d+)\/lyrics$/.exec(p))) return m[1] === '1001' ? send(200, JSON.stringify(fixture('lyrics.json'))) : notFound()
  const file = p.startsWith('/media/') ? join(SRC, basename(p)) : p.startsWith('/dash/') ? join(DASH, basename(p)) : ''
  if (file && existsSync(file)) return send(200, readFileSync(file), 'application/octet-stream')
  notFound()
}

const transport = (url: string, init?: RequestInit) => fetch(url, init)
const instant = { now: () => 0, sleep: async () => {}, random: () => 0 }

function deps(inLibrary: (id?: string) => boolean = () => false): AcquirerDeps {
  const cfg = resolveConfig(undefined, { apiV1: `${origin}/v1`, apiV2: `${origin}/v2` })
  const client = new TidalClient({ cfg, auth: fakeAuth('local-token', 'US'), transport, sleep: async () => {} })
  const ctx = fakeContext((q) => inLibrary(q.tidalTrackId))
  return { api: new TidalApi(client, () => '42'), transport, pacer: new Pacer({ clock: instant }), library: () => ctx.library }
}

function actx(name: string, onProgress?: (p: AcquireProgress, ctrl: AbortController) => void) {
  const ctrl = new AbortController()
  const events: AcquireProgress[] = []
  const stagingDir = join(sb.dir, 'staging', name)
  mkdirSync(stagingDir, { recursive: true })
  return { events, ctrl, ctx: { stagingDir, signal: ctrl.signal, progress: (p: AcquireProgress) => (events.push(p), onProgress?.(p, ctrl)) } }
}

beforeAll(async () => {
  await genAudio(join(SRC, 't1.flac'), 'flac16', { seconds: 3, freq: 440 })
  await genAudio(join(SRC, 't2.flac'), 'flac16', { seconds: 4, freq: 660 })
  await genAudio(join(SRC, 't3.m4a'), 'aac', { seconds: 2, freq: 550 })
  mkdirSync(DASH, { recursive: true })
  // The dash muxer derives the segment directory by splitting on '/', so pass a forward-slash path.
  const mpdPath = join(DASH, 'out.mpd').replace(/\\/g, '/')
  await ffmpegOrThrow(['-y', '-i', join(SRC, 't2.flac'), '-c:a', 'flac', '-f', 'dash', '-use_template', '1', '-use_timeline', '1', '-seg_duration', '1', mpdPath])
  expect(existsSync(join(DASH, 'init-stream0.m4s'))).toBe(true)
  server = createServer(handler)
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  mpd = readFileSync(join(DASH, 'out.mpd'), 'utf8').replace(/\b(initialization|media)="([^"]+)"/g, (_, a: string, v: string) => `${a}="${origin}/dash/${v}"`)
})

afterAll(async () => {
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()))
  sb.cleanup()
})

describe('tidal end-to-end download (local server)', () => {
  it('the generated DASH stream is a real multi-segment SegmentTimeline pointing at the server', () => {
    const m = parseDash(mpd)
    expect(m.codecs).toBe('flac')
    expect(m.segments!.length).toBeGreaterThanOrEqual(3)
    expect(m.urls.every((u) => u.startsWith(`${origin}/dash/`))).toBe(true)
  })

  it('acquires an album: BTS FLAC + DASH FLAC verified bit-exact, AAC remuxed, DRM and non-streamable skipped', async () => {
    const a = actx('album')
    const rel = await acquire({ kind: 'album', id: '100' }, a.ctx, deps())

    expect(rel.source).toBe('tidal')
    expect(rel.releaseKeys).toEqual(['tidal:album:100', 'upc:0123456789012'])
    expect(rel.tracks.map((t) => t.tags.tidal_track_id)).toEqual(['1001', '1002', '1003'])
    const [t1, t2, t3] = rel.tracks
    expect(t1.file.endsWith('.flac') && t2.file.endsWith('.flac') && t3.file.endsWith('.m4a')).toBe(true)
    for (const t of rel.tracks) expect(basename(t.file)).toMatch(/^[\x21-\x7e]+$/)

    expect(await pcmMd5(t1.file)).toBe(await pcmMd5(join(SRC, 't1.flac')))
    expect(await pcmMd5(t2.file)).toBe(await pcmMd5(join(SRC, 't2.flac')))
    expect(await pcmMd5(t3.file)).toBe(await pcmMd5(join(SRC, 't3.m4a')))

    expect(t1.tags).toMatchObject({ source_quality: 'lossless:16:44100', key: 'Am', totaltracks: 3, totaldiscs: 2, album: 'Test Album (Deluxe Edition)' })
    expect(t1.tags.lyrics).toContain('[00:01.00]')
    expect(t2.tags.title).toBe('Second Song (Club Mix)')
    expect(t2.tags.source_quality).toBe('lossless:16:44100')
    expect(t3.tags.source_quality).toMatch(/^lossy:aac:\d+$/)

    const skipped = (rel.raw as any).skipped
    expect(skipped.map((s: any) => [s.id, s.reason])).toEqual([
      ['1004', 'drm'],
      ['1005', 'unavailable'],
    ])
    // The DRM track's media was never requested; the non-streamable one never hit playbackinfo.
    expect(hits.some((h) => h.path === '/media/t4.m4a')).toBe(false)
    expect(hits.some((h) => h.path === '/v1/tracks/1005/playbackinfopostpaywall')).toBe(false)
    for (const h of hits.filter((x) => x.path.startsWith('/v1/'))) {
      expect(h.auth).toBe('Bearer local-token')
      expect(h.query.get('countryCode')).toBe('US')
    }
    expect(a.events.filter((e) => e.phase === 'waiting')).toHaveLength(3)
    expect(a.events.at(-1)?.phase).toBe('done')
    expect(readdirSync(a.ctx.stagingDir).filter((f) => f.includes('.src.'))).toEqual([])
  })

  it('acquires a single DASH track with album context and track release key', async () => {
    const a = actx('track')
    const rel = await acquire({ kind: 'track', id: '1002' }, a.ctx, deps())
    expect(rel.tracks).toHaveLength(1)
    expect(rel.releaseKeys).toEqual(['tidal:album:100', 'upc:0123456789012', 'tidal:track:1002'])
    expect(rel.tracks[0].tags).toMatchObject({ tracknumber: 2, discnumber: 1, totaltracks: 3, totaldiscs: 2, albumartist: 'Kaos & Ethos' })
    expect(rel.artwork?.url).toMatch(/\/origin\.jpg$/)
    expect(await pcmMd5(rel.tracks[0].file)).toBe(await pcmMd5(join(SRC, 't2.flac')))
  })

  it('onlyMissing downloads only tracks the library lacks', async () => {
    const a = actx('missing')
    const rel = await acquire({ kind: 'album', id: '100', onlyMissing: true }, a.ctx, deps((id) => id !== '1001' && id !== '1005'))
    expect(rel.tracks.map((t) => t.tags.tidal_track_id)).toEqual(['1001'])
    expect((rel.raw as any).skipped.map((s: any) => s.id)).toEqual(['1005'])
  })

  it('fails with drm when the only requested track is protected', async () => {
    const a = actx('drm')
    await expect(acquire({ kind: 'track', id: '1004' }, a.ctx, deps())).rejects.toMatchObject({ kind: 'drm' })
  })

  it('honours the AbortSignal mid-job', async () => {
    const a = actx('abort', (p, ctrl) => {
      if (p.phase === 'downloading' && p.trackIndex === 1) ctrl.abort()
    })
    await expect(acquire({ kind: 'album', id: '100' }, a.ctx, deps())).rejects.toMatchObject({ kind: 'cancelled' })
    expect(readdirSync(a.ctx.stagingDir).filter((f) => f.includes('.src.'))).toEqual([])
  })

  it('downloadStream reports progress and refuses an unsupported codec', async () => {
    const fractions: number[] = []
    const out = await downloadStream(
      { kind: 'bts', mimeType: 'audio/flac', codecs: 'flac', urls: [`${origin}/media/t1.flac`] },
      { dir: join(sb.dir, 'staging', 'direct'), baseName: 'x', transport, onProgress: (f) => fractions.push(f) },
    )
    expect(out).toMatchObject({ lossless: true, codec: 'flac', sampleRate: 44100, bitDepth: 16 })
    expect(fractions.at(-1)).toBe(1)
    expect(fractions.every((f, i) => i === 0 || f >= fractions[i - 1])).toBe(true)

    await genAudio(join(SRC, 't5.wav'), 'wav', { seconds: 1 })
    await expect(
      downloadStream({ kind: 'bts', mimeType: 'audio/wav', codecs: 'pcm', urls: [`${origin}/media/t5.wav`] }, { dir: join(sb.dir, 'staging', 'direct'), baseName: 'y', transport }),
    ).rejects.toMatchObject({ kind: 'unavailable' })
  })
})
