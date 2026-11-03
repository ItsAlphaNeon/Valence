// Rip album sources: page parsers (fixtures trimmed from the real highquality.rip / SGFR / Drive
// pages), the Drive client's error handling, the 'hqrip' acquirer and the catalog service.

import { afterAll, describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { sandbox } from '../helpers/sandbox'
import { genAudio, genImage } from '../helpers/audio'
import { classifyDriveHtml, driveFileKind, parseAlbumIndex, parseDriveFolder, parseSgfrList, parseSgfrPage, pickFormat } from '@main/sources/hqrip/parse'
import { DriveClient } from '@main/sources/hqrip/drive'
import { createAcquirer } from '@main/sources/hqrip/acquire'
import { HqripService, badgeFor } from '@main/sources/hqrip/service'
import type { AppContext, EnqueueRequest } from '@main/context'

const fx = (name: string) => readFileSync(join(__dirname, '../fixtures/hqrip', name), 'utf8')

describe('rip catalog parsers', () => {
  it('reads the highquality.rip album index', () => {
    const albums = parseAlbumIndex(fx('albums.html'))
    expect(albums[0]).toEqual({
      title: 'SiIvaGunner’s Highest Quality Rips: Volume 🔥'.replace('’', "'"),
      folders: { mp3: '1mTbfE4HSxtL2SiyCH8sVP1fpwonzUd4e', flac: '19YDA6vbIdd7VqEZKMFZnWw4PlSZTIUZC' },
    })
    // Three normal albums, one MP3+OGG+FLAC, one with a bonus image pack and one OGG only.
    expect(albums).toHaveLength(6)
    expect(albums.filter((a) => a.folders.ogg && a.folders.flac)).toHaveLength(1)
    const ogg = albums.find((a) => !a.folders.flac && !a.folders.mp3)!
    expect(Object.keys(ogg.folders)).toEqual(['ogg'])
    expect(pickFormat(ogg.folders)).toBe('ogg')
    expect(pickFormat(albums[0].folders)).toBe('flac')
    // A "Bonus Image SLAM! Pack" link is not an audio folder.
    expect(albums.every((a) => Object.keys(a.folders).every((k) => ['mp3', 'flac', 'ogg'].includes(k)))).toBe(true)
  })

  it('reads the SGFR release list with optional subtitles', () => {
    const list = parseSgfrList(fx('sgfr-albumpage.js'))
    expect(list.length).toBeGreaterThanOrEqual(25)
    expect(list[0]).toEqual({ id: 's0003', title: 'Remix Relay 10 (Single)', type: 'Single' })
    expect(list.find((x) => x.id === '0017-b')?.title).toBe('HIGH-QUALITY HARDCORE REMIX PACK [Side B]')
    expect(list.find((x) => x.id === 'c0003')).toEqual({ id: 'c0003', title: 'Eternal Katamari Original Soundtrack Vol. 1 ~ "Katamari Quality Damacy"', type: 'Soundtrack' })
    expect(list.find((x) => x.id === '0007')?.title).toBe('RIP²')
  })

  it('reads an SGFR release page', () => {
    expect(parseSgfrPage(fx('sgfr-0016.html'))).toEqual({
      title: 'SGFR Arrangement Series Vol. 16 - Mahjong Bangers',
      folders: { mp3: '1rCKLxKgvN9fyqlOXIdOj7WglRspE4dxB', flac: '1OAi7zx9SnzqO6RTdUBEZO9C5PG4bTRqg' },
      bandcampUrl: 'https://siivagunnerfusionrecords.bandcamp.com/album/sgfr-arrangement-series-vol-16-mahjong-bangers',
    })
    expect(parseSgfrPage(fx('sgfr-s0003.html')).folders).toEqual({ mp3: '1yxRv4_8lD04tRYf_rikQaEOjrSwMK2Dj', flac: '1nGL7DnBHdopry69OzoA5Ejyn0btiYYYD' })
  })

  it('reads a public Drive folder listing', () => {
    const l = parseDriveFolder(fx('drive-folder.html'))!
    expect(l.title).toBe("SiIvaGunner's Highest Quality Rips: Volume 🔥")
    expect(l.entries).toHaveLength(6)
    expect(l.entries[0]).toEqual({ id: '1RRundp1Uk-3p1DLL9AWUgvkmHrsfmxc5', name: "$quare Enix - SiIvaGunner's Highest Quality Rips- Volu - 14 Die Young in My Home Town.flac", folder: false })
    expect(l.entries.map((e) => driveFileKind(e.name))).toEqual(['audio', 'audio', 'audio', 'audio', 'image', 'skip'])
    expect(parseDriveFolder('<html>Sign in</html>')).toBeNull()
  })

  it('tells Drive error pages apart', () => {
    expect(classifyDriveHtml('<p>Sorry, you can&#39;t view or download this file at this time. Too many users have viewed or downloaded this file recently.</p>').kind).toBe('quota')
    expect(classifyDriveHtml('<p>Our systems have detected unusual traffic from your computer network. CAPTCHA</p>').kind).toBe('captcha')
    const form = classifyDriveHtml(
      '<form id="download-form" action="https://drive.usercontent.google.com/download" method="get"><input type="hidden" name="id" value="F1"><input type="hidden" name="confirm" value="t"><input type="hidden" name="uuid" value="u-1"></form>',
    )
    expect(form).toEqual({ kind: 'confirm', url: 'https://drive.usercontent.google.com/download?id=F1&confirm=t&uuid=u-1' })
    expect(classifyDriveHtml('<html>hello</html>').kind).toBe('unknown')
  })
})

// ---- Drive client + acquirer over a fake network ----

type Route = (url: URL) => Response | Promise<Response>
function fakeTransport(route: Route) {
  const seen: string[] = []
  const t = async (url: string) => {
    seen.push(url)
    return route(new URL(url))
  }
  return { t, seen }
}
const html = (s: string, status = 200) => new Response(s, { status, headers: { 'content-type': 'text/html; charset=utf-8' } })
const folderPage = (title: string, files: Array<[string, string]>) =>
  `<html><head><title>${title}</title></head><body><div class="flip-entries">${files
    .map(([id, name]) => `<div class="flip-entry" id="entry-${id}" tabindex="0"><div class="flip-entry-info"><a href="https://drive.google.com/file/d/${id}/view?usp=drive_web"><div class="flip-entry-title">${name}</div></a></div></div>`)
    .join('')}</div></body></html>`

describe('Drive client', () => {
  const sb = sandbox('drive')
  afterAll(() => sb.cleanup())
  const noWait = { gapMs: 0 }

  it('follows the large-file confirmation once and writes the file', async () => {
    const { t, seen } = fakeTransport((u) =>
      u.searchParams.get('uuid') ? new Response('fLaC-bytes', { headers: { 'content-type': 'application/octet-stream' } }) : html('<form id="download-form" action="/download"><input type="hidden" name="id" value="F1"><input type="hidden" name="uuid" value="u"></form>'),
    )
    const dest = join(sb.dir, 'a.flac')
    expect(await new DriveClient(t, noWait).download('F1', dest, new AbortController().signal)).toBe(10)
    expect(readFileSync(dest, 'utf8')).toBe('fLaC-bytes')
    expect(seen).toHaveLength(2)
  })

  it('maps quota, CAPTCHA and missing files to queue-friendly errors', async () => {
    const get = (body: string, status = 200) => new DriveClient(fakeTransport(() => html(body, status)).t, noWait).download('F', join(sb.dir, 'x'), new AbortController().signal)
    await expect(get('Too many users have viewed or downloaded this file recently')).rejects.toMatchObject({ kind: 'rate-limit' })
    await expect(get('unusual traffic captcha')).rejects.toMatchObject({ kind: 'abuse' })
    await expect(get('nope', 404)).rejects.toMatchObject({ kind: 'unavailable' })
    await expect(new DriveClient(fakeTransport(() => html('<html>Sign in to continue</html>')).t, noWait).listFolder('F')).rejects.toMatchObject({ kind: 'parse' })
  })

  it('flattens subfolders into paths', async () => {
    const { t } = fakeTransport((u) => {
      const id = u.searchParams.get('id')
      if (id === 'root') return html(folderPage('Root', [['f1', '01 A.flac']]).replace('</div></body>', `<div class="flip-entry" id="entry-sub"><a href="https://drive.google.com/drive/folders/sub123456789"><div class="flip-entry-title">Disc 2</div></a></div></div></body>`))
      return html(folderPage('Disc 2', [['f2', '01 B.flac']]))
    })
    const tree = await new DriveClient(t, noWait).listTree('root')
    expect(tree.files.map((f) => f.path)).toEqual(['01 A.flac', 'Disc 2/01 B.flac'])
  })
})

describe('hqrip acquirer', () => {
  const sb = sandbox('hqrip-acq')
  afterAll(() => sb.cleanup())

  it('stages a Drive album with cover and extras, marks it as a rip and skips lookups', async () => {
    const a = await genAudio(join(sb.dir, 'src', 'a.mp3'), 'mp3_128', { seconds: 1, metadata: { title: 'HOW TO MO BAMBA', artist: 'alan' } })
    const b = await genAudio(join(sb.dir, 'src', 'b.mp3'), 'mp3_128', { seconds: 1, freq: 550, metadata: { title: 'SICKO GLOW', artist: 'alan' } })
    const cover = await genImage(join(sb.dir, 'src', 'cover.png'), 64)
    const bytes: Record<string, string> = { A: a, B: b, C: cover, G: cover }
    const { t } = fakeTransport((u) => {
      if (u.hostname === 'drive.google.com')
        return html(folderPage('Volume', [['A', '01 HOW TO MO BAMBA.mp3'], ['B', '02 SICKO GLOW.mp3'], ['C', 'cover.png'], ['G', 'September Mystery.png'], ['D', 'desktop.ini']]))
      return new Response(readFileSync(bytes[u.searchParams.get('id')!]), { headers: { 'content-type': 'application/octet-stream' } })
    })
    const listed: unknown[] = []
    const acquire = createAcquirer({ drive: new DriveClient(t, { gapMs: 0 }), onListed: (id, info) => listed.push([id, info]) })
    const stagingDir = join(sb.dir, 'staging')
    const rel = await acquire(
      { releaseId: 'hqr:FOLDER', collection: 'SiIvaGunner', title: 'Volume 🔥', folderId: 'FOLDER' },
      { stagingDir, signal: new AbortController().signal, progress: () => {} },
    )
    expect(listed).toEqual([['hqr:FOLDER', { trackCount: 2, coverId: 'C' }]])
    expect(rel).toMatchObject({
      source: 'hqrip',
      releaseKeys: ['hqr:FOLDER'],
      skipLookups: true,
      // The test files have no album tags, so the catalog title and SiIvaGunner fill in.
      albumTags: { hq_rip: 'SiIvaGunner', hqr_release: 'hqr:FOLDER', album: 'Volume 🔥', albumartist: 'SiIvaGunner' },
      title: 'SiIvaGunner · Volume 🔥',
    })
    expect(rel.tracks.map((x) => x.tags.gdrive_file_id)).toEqual(['A', 'B'])
    expect(rel.tracks.every((x) => existsSync(x.file))).toBe(true)
    expect(rel.artwork?.file && existsSync(rel.artwork.file)).toBe(true)
    expect(rel.extras).toHaveLength(1)
  })
})

describe('hqrip catalog service', () => {
  const sb = sandbox('hqrip-svc')
  afterAll(() => sb.cleanup())

  it('builds the catalog from both sites, adds badges and queues downloads', async () => {
    const { t } = fakeTransport((u) => {
      if (u.hostname === 'highquality.rip') return html(fx('albums.html'))
      if (u.pathname === '/albumpage.js') return new Response(fx('sgfr-albumpage.js'))
      if (u.pathname === '/sgfr-0016/index.html') return html(fx('sgfr-0016.html'))
      if (u.pathname === '/sgfr-s0003/index.html') return html(fx('sgfr-s0003.html'))
      return html('missing', 404)
    })
    const enqueued: EnqueueRequest[] = []
    const ctx = {
      env: { dataDir: sb.dir },
      log: { info() {}, warn() {}, error() {} },
      broadcast() {},
      library: { ripReleaseCounts: () => new Map([['sgfr:0016', 12]]) },
      imports: {
        activeKeys: () => new Map(),
        enqueue: (r: EnqueueRequest) => (enqueued.push(r), `job${enqueued.length}`),
      },
    } as unknown as AppContext
    // A Drive that never answers keeps the background listing pass out of the way.
    const svc = new HqripService({ ctx, transport: t, drive: { listTree: () => new Promise(() => {}) } as never })
    const cat = await svc.catalog()
    expect(cat.releases.filter((r) => r.collection === 'SiIvaGunner')).toHaveLength(6)
    const sgfr = cat.releases.filter((r) => r.collection === 'SGFR')
    expect(sgfr.map((r) => r.id).sort()).toEqual(['sgfr:0016', 'sgfr:s0003'])
    expect(sgfr.find((r) => r.id === 'sgfr:0016')).toMatchObject({
      catalogNumber: 'SGFR-0016',
      cover: 'https://sgfr.highquality.rip/sgfr-0016/bc.jpg',
      format: 'flac',
      badge: { status: 'in-library', have: 12 },
    })
    svc.noteListed('sgfr:0016', { trackCount: 40, coverId: null })
    expect(svc.summaries().find((r) => r.id === 'sgfr:0016')?.badge).toEqual({ status: 'partial', have: 12, total: 40 })

    const r = svc.download('sgfr:s0003')
    expect(r.releaseKeys).toEqual(['sgfr:s0003'])
    expect(enqueued[0]).toMatchObject({ source: 'hqrip', payload: { releaseId: 'sgfr:s0003', collection: 'SGFR', folderId: '1nGL7DnBHdopry69OzoA5Ejyn0btiYYYD', catalogNumber: 'SGFR-S0003' } })
    const all = svc.downloadAllMissing('SiIvaGunner')
    expect(all.queued).toBe(6)
    expect(enqueued.slice(1).every((e) => e.payload && (e.payload as { collection: string }).collection === 'SiIvaGunner')).toBe(true)
    svc.stop()
  })

  it('badges count downloaded tracks against the listed total', () => {
    expect(badgeFor(0, 10)).toEqual({ status: 'missing', have: 0, total: 10 })
    expect(badgeFor(3, 10)).toEqual({ status: 'partial', have: 3, total: 10 })
    expect(badgeFor(10, 10).status).toBe('in-library')
    expect(badgeFor(4, null)).toEqual({ status: 'in-library', have: 4, total: 4 })
  })
})
