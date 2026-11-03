import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { BandcampClient, RateGate } from '@main/sources/bandcamp/client'
import {
  asciiName,
  dispositionFilename,
  downloadRelease,
  extractZip,
  isZipMagic,
  matchTracks,
  readMagic,
  safeEntryPath,
} from '@main/sources/bandcamp/downloader'
import type { BcTrack } from '@main/sources/bandcamp/parse'
import type { AcquireProgress } from '@main/import/source-types'
import { sandbox } from '../helpers/sandbox'
import { downloadPageHtml, fakeTransport, makeZip, statJsonp } from '../fixtures/bandcamp/helpers'

const box = sandbox('bandcamp-dl')
afterAll(() => box.cleanup())

describe('file names', () => {
  it('converts to safe ASCII and keeps the extension', () => {
    expect(asciiName('Sigur Rós - Ágætis byrjun - 01 Intro.flac')).toBe('Sigur Ros - Agaetis byrjun - 01 Intro.flac')
    expect(asciiName('Straße “Quoted”: Part 1?.FLAC')).toBe("Strasse 'Quoted' - Part 1.flac")
    expect(asciiName('日本語.pdf')).toBe('___.pdf')
    expect(asciiName('con.txt')).toBe('_con.txt')
  })

  it('reads Content-Disposition names', () => {
    expect(dispositionFilename(`attachment; filename="Artist - Track.flac"; filename*=UTF-8''Artist%20-%20Tr%C3%A4ck.flac`)).toBe('Artist - Träck.flac')
    expect(dispositionFilename('attachment; filename="Plain.flac"')).toBe('Plain.flac')
    expect(dispositionFilename(null)).toBeUndefined()
  })

  it('rejects zip-slip entry names and skips junk', () => {
    expect(safeEntryPath('a/b.flac')).toBe('a/b.flac')
    expect(safeEntryPath('dir/')).toBeNull()
    expect(safeEntryPath('__MACOSX/._x.flac')).toBeNull()
    expect(safeEntryPath('.DS_Store')).toBeNull()
    expect(() => safeEntryPath('../evil.flac')).toThrow(/Unsafe/)
    expect(() => safeEntryPath('a/../../evil.flac')).toThrow(/Unsafe/)
    expect(() => safeEntryPath('..\\evil.flac')).toThrow(/Unsafe/)
    expect(() => safeEntryPath('/etc/passwd')).toThrow(/Unsafe/)
    expect(() => safeEntryPath('C:/x.flac')).toThrow(/Unsafe/)
  })
})

describe('zip handling', () => {
  it('detects zip vs single-file downloads by magic bytes', async () => {
    const zip = join(box.dir, 'magic.zip')
    const flac = join(box.dir, 'magic.flac')
    writeFileSync(zip, makeZip([{ name: 'a.txt', data: 'x' }]))
    writeFileSync(flac, Buffer.concat([Buffer.from('fLaC'), Buffer.alloc(10)]))
    expect(isZipMagic(await readMagic(zip))).toBe(true)
    expect(isZipMagic(await readMagic(flac))).toBe(false)
  })

  it('extracts with ASCII names', async () => {
    const zip = join(box.dir, 'release.zip')
    writeFileSync(
      zip,
      makeZip([
        { name: 'Bjørk - Début - 01 Human Behaviour.flac', data: 'one' },
        { name: 'Bjørk - Début - 02 Crying.flac', data: 'two' },
        { name: 'cover.jpg', data: 'img' },
        { name: 'extras/', data: '' },
        { name: 'extras/Booklet – Ünïcode.pdf', data: '%PDF-1.4' },
        { name: '__MACOSX/._cover.jpg', data: 'junk' },
      ]),
    )
    const dest = join(box.dir, 'out')
    const files = await extractZip(zip, dest)
    expect(files.map((f) => f.slice(dest.length + 1).replace(/\\/g, '/')).sort()).toEqual([
      'Bjork - Debut - 01 Human Behaviour.flac',
      'Bjork - Debut - 02 Crying.flac',
      'cover.jpg',
      'extras/Booklet - Unicode.pdf',
    ])
    expect(readFileSync(join(dest, 'Bjork - Debut - 02 Crying.flac'), 'utf8')).toBe('two')
  })

  it('rejects zip-slip archives without writing outside the destination', async () => {
    const zip = join(box.dir, 'evil.zip')
    writeFileSync(zip, makeZip([{ name: 'ok.flac', data: 'fine' }, { name: '../evil.txt', data: 'pwned' }]))
    const dest = join(box.dir, 'evil-out')
    await expect(extractZip(zip, dest)).rejects.toMatchObject({ kind: 'parse', message: expect.stringMatching(/Unsafe path/) })
    expect(existsSync(join(box.dir, 'evil.txt'))).toBe(false)
  })

  it('rejects a corrupt zip as a parse error', async () => {
    const zip = join(box.dir, 'corrupt.zip')
    writeFileSync(zip, Buffer.concat([Buffer.from('PK\x03\x04'), Buffer.alloc(40)]))
    await expect(extractZip(zip, join(box.dir, 'corrupt-out'))).rejects.toMatchObject({ kind: 'parse' })
  })
})

describe('track matching', () => {
  const tracks: BcTrack[] = [
    { trackId: 1, trackNum: 1, title: 'Opening & "Intro"', durationMs: 0 },
    { trackId: 2, trackNum: 2, title: 'Café Noir', durationMs: 0 },
    { trackId: 3, trackNum: 3, title: 'Closing Theme', durationMs: 0 },
  ]
  const ids = (m: Map<string, BcTrack>) => Object.fromEntries([...m].map(([f, t]) => [basename(f), t.trackId]))

  it('prefers the TRACKNUMBER tag over the file name', () => {
    const m = matchTracks(
      [
        { file: '/s/A - B - 03 Opening.flac', tagTrackNo: 1 },
        { file: '/s/A - B - 01 Closing Theme.flac', tagTrackNo: 3 },
      ],
      tracks,
    )
    expect(ids(m)).toEqual({ 'A - B - 03 Opening.flac': 1, 'A - B - 01 Closing Theme.flac': 3 })
  })

  it('uses the Bandcamp file name pattern, then title similarity', () => {
    const m = matchTracks(
      [
        { file: '/s/Artist - Album - 02 Cafe Noir.flac' },
        { file: '/s/closing.flac', tagTitle: 'Closing Theme (Remastered)' },
        { file: '/s/x.flac', tagTitle: 'Opening & Intro' },
      ],
      tracks,
    )
    expect(ids(m)).toEqual({ 'Artist - Album - 02 Cafe Noir.flac': 2, 'closing.flac': 3, 'x.flac': 1 })
  })

  it('leaves unrelated files unmatched and never assigns a track twice', () => {
    const m = matchTracks(
      [
        { file: '/s/a.flac', tagTrackNo: 2 },
        { file: '/s/b.flac', tagTrackNo: 2 },
        { file: '/s/zzz.flac', tagTitle: 'Totally Different Song' },
      ],
      tracks,
    )
    expect(ids(m)).toEqual({ 'a.flac': 2 })
  })

  it('matches a single-track release without evidence', () => {
    expect(ids(matchTracks([{ file: '/s/whatever.flac' }], [tracks[0]]))).toEqual({ 'whatever.flac': 1 })
  })
})

describe('encoding backoff', () => {
  afterEach(() => vi.useRealTimers())

  const FILE = 'https://popplers5.bandcamp.com/download/album?enc=flac&id=1001&sig=abc&sitem_id=9001'
  const page = downloadPageHtml([{ sale_id: 9001, item_id: 1001, item_type: 'a', download_type: 'a', tralbum_id: 1001, title: 'T', artist: 'A', downloads: { flac: { url: FILE } } }])

  function setup(fileStatuses: number[], statBodies: string[] = []) {
    const at: Record<string, number[]> = {}
    let fileHits = 0
    let statHits = 0
    const t = fakeTransport((url, call) => {
      ;(at[url.pathname] ??= []).push(Date.now())
      if (url.pathname === '/download' && url.host === 'bandcamp.com') return new Response(page, { headers: { 'content-type': 'text/html' } })
      if (url.pathname === '/statdownload/album') return new Response(statBodies[statHits++] ?? statJsonp({ result: 'ok' }))
      if (url.pathname === '/download/album') {
        const status = fileStatuses[Math.min(fileHits++, fileStatuses.length - 1)]
        if (status !== 200) return new Response('encoding', { status })
        const body = call.headers.range ? Buffer.from('f') : Buffer.concat([Buffer.from('fLaC'), Buffer.alloc(64)])
        return new Response(body, { status: call.headers.range ? 206 : 200, headers: { 'content-type': 'audio/flac', 'content-disposition': 'attachment; filename="A - T.flac"' } })
      }
    })
    return { t, at, client: new BandcampClient({ transport: t, gate: new RateGate() }) }
  }

  async function drive<T>(p: Promise<T>): Promise<T> {
    let settled = false
    p.then(() => (settled = true), () => (settled = true))
    for (let i = 0; i < 2000 && !settled; i++) {
      await vi.advanceTimersByTimeAsync(1000)
      await new Promise((r) => setImmediate(r))
    }
    return p
  }

  it('waits 5, 10, 20 s… on retry_url and 503, reporting phase "waiting"', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const t0 = Date.now()
    const retry = FILE.replace('sig=abc', 'sig=retry')
    const { at, client } = setup([503, 503, 200], [statJsonp({ result: 'err', retry_url: retry, errortype: 'NotReady' })])
    const events: AcquireProgress[] = []
    const dir = join(box.dir, 'backoff')
    const res = await drive(
      downloadRelease({ client, redownloadUrl: 'https://bandcamp.com/download?sitem_id=9001', want: { saleItemId: 9001 }, stagingDir: dir, signal: new AbortController().signal, progress: (p) => events.push(p) }),
    )
    const rel = (xs: number[]) => xs.map((x) => Math.round((x - t0) / 1000))
    expect(rel(at['/statdownload/album'])).toEqual([0, 5, 15, 35])
    // probe, probe, probe(ready) + full GET
    expect(rel(at['/download/album'])).toEqual([5, 15, 35, 35])
    expect(events.filter((e) => e.phase === 'waiting').map((e) => e.message)).toEqual([
      'Bandcamp is preparing the download (retrying in 5 s)',
      'Bandcamp is encoding the FLAC files (retrying in 10 s)',
      'Bandcamp is encoding the FLAC files (retrying in 20 s)',
    ])
    expect(res.audio.map((f) => basename(f))).toEqual(['A - T.flac'])
    expect(readdirSync(dir).filter((f) => f.endsWith('.part'))).toEqual([])
  })

  it('gives up after about 10 minutes of encoding', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const t0 = Date.now()
    const { client } = setup([503])
    const waits: string[] = []
    const err = await drive(
      downloadRelease({
        client,
        redownloadUrl: 'https://bandcamp.com/download?sitem_id=9001',
        stagingDir: join(box.dir, 'giveup'),
        signal: new AbortController().signal,
        progress: (p) => p.phase === 'waiting' && waits.push(p.message!),
      }).catch((e) => e),
    )
    expect(err).toMatchObject({ kind: 'network', message: expect.stringMatching(/still preparing/) })
    expect(waits.map((m) => Number(/in (\d+) s/.exec(m)![1]))).toEqual([5, 10, 20, 40, 80, 120, 120, 120, 85])
    expect(Date.now() - t0).toBeGreaterThanOrEqual(600_000)
    expect(Date.now() - t0).toBeLessThan(605_000)
  })

  it('stops waiting when aborted', async () => {
    const { client } = setup([503])
    const ac = new AbortController()
    const err = await downloadRelease({
      client,
      redownloadUrl: 'https://bandcamp.com/download?sitem_id=9001',
      stagingDir: join(box.dir, 'abort'),
      signal: ac.signal,
      progress: (p) => p.phase === 'waiting' && ac.abort(),
    }).catch((e) => e)
    expect(err).toMatchObject({ kind: 'cancelled' })
  })

  it('reports missing FLAC and email re-confirmation clearly', async () => {
    const noFlac = downloadPageHtml([{ sale_id: 9001, item_id: 1001, downloads: { 'mp3-320': { url: FILE.replace('flac', 'mp3-320') } } }])
    const t = fakeTransport(() => new Response(noFlac, { headers: { 'content-type': 'text/html' } }))
    const opts = { redownloadUrl: 'https://bandcamp.com/download?x', stagingDir: join(box.dir, 'nf'), signal: new AbortController().signal, progress: () => {} }
    await expect(downloadRelease({ ...opts, client: new BandcampClient({ transport: t, gate: new RateGate() }) })).rejects.toMatchObject({ kind: 'unavailable', message: expect.stringMatching(/mp3-320/) })
    const reauth = noFlac.replace('style="display:none"', '')
    const t2 = fakeTransport(() => new Response(reauth, { headers: { 'content-type': 'text/html' } }))
    await expect(downloadRelease({ ...opts, client: new BandcampClient({ transport: t2, gate: new RateGate() }) })).rejects.toMatchObject({ kind: 'auth', message: expect.stringMatching(/re-confirm/) })
  })
})
