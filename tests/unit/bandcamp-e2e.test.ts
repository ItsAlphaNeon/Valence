// End-to-end acquirer run against a local 127.0.0.1 server standing in for Bandcamp (SYNTHETIC).

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { createAcquirer } from '@main/sources/bandcamp/acquire'
import { BandcampClient, RateGate } from '@main/sources/bandcamp/client'
import type { BandcampPayload } from '@main/sources/bandcamp/acquire'
import type { AcquireProgress } from '@main/import/source-types'
import { genAudio, genImage } from '../helpers/audio'
import { sandbox } from '../helpers/sandbox'
import { downloadPageHtml, makeZip, startServer, statJsonp, tralbumPageHtml, type LocalServer } from '../fixtures/bandcamp/helpers'

const box = sandbox('bandcamp-e2e')
let zip: Buffer

beforeAll(async () => {
  const src = join(box.dir, 'src')
  const a = await genAudio(join(src, 'a.flac'), 'flac16', { seconds: 1, freq: 330, metadata: { track: 2, title: 'Café Noir', artist: 'Guest Singer' } })
  const b = await genAudio(join(src, 'b.flac'), 'flac16', { seconds: 1, freq: 440 })
  const c = await genAudio(join(src, 'c.flac'), 'flac16', { seconds: 1, freq: 550, metadata: { title: 'Closing Theme' } })
  const cover = await genImage(join(src, 'cover.jpg'), 64)
  zip = makeZip([
    { name: 'Synth Artist - Synthetic Album - 02 Café Noir.flac', data: readFileSync(a) },
    { name: 'Synth Artist - Synthetic Album - 01 Opening & Intro.flac', data: readFileSync(b) },
    { name: 'closing.flac', data: readFileSync(c) },
    { name: 'cover.jpg', data: readFileSync(cover) },
    { name: 'Digital Booklet.pdf', data: '%PDF-1.4\n% synthetic\n' },
  ])
})
afterAll(() => box.cleanup())

interface Variant {
  /** First download-page visit hands out a link whose file URL answers text/html. */
  expiredFirst?: boolean
  /** First statdownload answers with retry_url. */
  retryOnce?: boolean
  /** Number of 503s from the file URL before it serves the zip. */
  encoding503?: number
}

function bandcampStandIn(v: Variant): Promise<LocalServer> {
  let fileHits = 0
  return startServer((req, res, url, hit) => {
    const base = `http://${req.headers.host}`
    const fileUrl = (sig: string) => `${base}/download/album?enc=flac&id=1001&sig=${sig}&sitem_id=9001`
    const htmlOut = (s: string) => {
      res.setHeader('content-type', 'text/html; charset=utf-8')
      res.end(s)
    }
    switch (url.pathname) {
      case '/download':
        return htmlOut(
          downloadPageHtml([
            {
              sale_id: 9001, item_type: 'a', item_id: 1001, download_type: 'a', download_id: 1001, tralbum_id: 1001,
              title: 'Synthetic Album', artist: 'Synth Artist', art_id: 111, release_date: '05 Sep 2023 00:00:00 GMT',
              page_url: `${base}/album/synthetic-album`,
              downloads: {
                'mp3-320': { size_mb: '1MB', url: fileUrl('mp3').replace('enc=flac', 'enc=mp3-320') },
                flac: { size_mb: '1MB', url: fileUrl(v.expiredFirst && hit === 1 ? 'expired' : 'fresh') },
              },
            },
          ]),
        )
      case '/statdownload/album':
        res.setHeader('content-type', 'text/javascript')
        if (url.searchParams.get('.vrs') !== '1' || !url.searchParams.get('.rand')) return res.end('bad stat request')
        return res.end(v.retryOnce && hit === 1 ? statJsonp({ result: 'err', retry_url: fileUrl('retry'), errortype: 'EncodingNotReady' }) : statJsonp({ result: 'ok' }))
      case '/download/album': {
        if (url.searchParams.get('sig') === 'expired') return htmlOut('<html><body>This download link has expired.</body></html>')
        if (++fileHits <= (v.encoding503 ?? 0)) {
          res.statusCode = 503
          return res.end('encoding')
        }
        res.setHeader('content-type', 'application/zip')
        res.setHeader('content-disposition', 'attachment; filename="Synth Artist - Synthetic Album.zip"')
        if (req.headers.range === 'bytes=0-0') {
          res.statusCode = 206
          res.setHeader('content-range', `bytes 0-0/${zip.length}`)
          return res.end(zip.subarray(0, 1))
        }
        res.setHeader('content-length', String(zip.length))
        return res.end(zip)
      }
      case '/album/synthetic-album':
        return htmlOut(
          tralbumPageHtml(
            {
              current: { title: 'Synthetic Album', type: 'album', id: 1001, art_id: 111, release_date: '05 Sep 2023 00:00:00 GMT', upc: '0123456789012' },
              artist: 'Synth Artist', item_type: 'album', id: 1001, art_id: 111, url: `${base}/album/synthetic-album`,
              trackinfo: [
                { track_id: 7001, track_num: 1, title: 'Opening & "Intro"', artist: null, duration: 1 },
                { track_id: 7002, track_num: 2, title: 'Café Noir', artist: 'Guest Singer', duration: 1 },
                { track_id: 7003, track_num: 3, title: 'Closing Theme', artist: null, duration: 1 },
              ],
            },
            { band: { id: 42, name: 'Synth Label' }, ld: { '@type': 'MusicAlbum', name: 'Synthetic Album', keywords: ['electronic', 'ambient'], publisher: { '@type': 'MusicGroup', name: 'Synth Label' } } },
          ),
        )
      default:
        res.statusCode = 404
        res.end('not found')
    }
  })
}

async function run(server: LocalServer, name: string) {
  const sleeps: number[] = []
  const events: AcquireProgress[] = []
  const client = new BandcampClient({ transport: (u, init) => fetch(u, init), gate: new RateGate(), baseUrl: server.base })
  const acquire = createAcquirer({ client, sleep: async (ms) => void sleeps.push(ms) })
  const payload: BandcampPayload = {
    itemKey: 'a9001',
    saleItemType: 'a',
    saleItemId: 9001,
    redownloadUrl: `${server.base}/download?from=collection&payment_id=1&sig=aaa&sitem_id=9001`,
    itemUrl: `${server.base}/album/synthetic-album`,
    tralbumId: 1001,
    tralbumType: 'album',
  }
  const stagingDir = join(box.dir, name)
  const release = await acquire(payload, { stagingDir, progress: (p) => events.push(p), signal: new AbortController().signal })
  return { release, sleeps, events, stagingDir }
}

describe('bandcamp acquirer end-to-end', () => {
  it('waits through retry_url and 503s, unzips, matches and maps the release', async () => {
    const server = await bandcampStandIn({ retryOnce: true, encoding503: 2 })
    try {
      const { release, sleeps, events, stagingDir } = await run(server, 'main')

      expect(sleeps).toEqual([5000, 10000, 20000])
      expect(events.some((e) => e.phase === 'waiting')).toBe(true)
      expect(events.some((e) => e.phase === 'downloading' && e.fraction === 1)).toBe(true)
      expect(server.hits.get('/statdownload/album')).toBe(4)
      expect(server.hits.get('/download')).toBe(1)

      expect(release.source).toBe('bandcamp')
      expect(release.releaseKeys).toEqual(['bc:album:1001', 'upc:0123456789012'])
      expect(release.title).toBe('Bandcamp · Synth Artist — Synthetic Album')
      expect(release.albumTags).toEqual({
        album: 'Synthetic Album',
        albumartist: 'Synth Artist',
        source: 'bandcamp',
        bandcamp_item_id: '1001',
        bandcamp_url: `${server.base}/album/synthetic-album`,
        date: '2023-09-05',
        label: 'Synth Label',
        barcode: '0123456789012',
        totaltracks: 3,
      })
      expect(release.artwork).toEqual({ url: 'https://f4.bcbits.com/img/a111_0.jpg', fallbackUrls: ['https://f4.bcbits.com/img/a111_10.jpg'] })
      expect((release.raw as { tags: string[] }).tags).toEqual(['electronic', 'ambient'])

      expect(release.tracks.map((t) => [t.tags.tracknumber, t.tags.title, t.tags.artist, t.tags.bandcamp_track_id])).toEqual([
        [1, 'Opening & "Intro"', 'Synth Artist', '7001'],
        [2, 'Café Noir', 'Guest Singer', '7002'],
        [3, 'Closing Theme', 'Synth Artist', '7003'],
      ])
      expect(release.tracks.map((t) => basename(t.file))).toEqual([
        'Synth Artist - Synthetic Album - 01 Opening & Intro.flac',
        'Synth Artist - Synthetic Album - 02 Cafe Noir.flac',
        'closing.flac',
      ])
      for (const t of release.tracks) {
        expect(existsSync(t.file)).toBe(true)
        expect(t.file.startsWith(stagingDir)).toBe(true)
        expect(t.tags).toMatchObject({ album: 'Synthetic Album', albumartist: 'Synth Artist', totaltracks: 3, date: '2023-09-05', source: 'bandcamp', source_quality: 'lossless:16:44100', bandcamp_item_id: '1001' })
        expect(t.durationMs).toBeGreaterThan(900)
        expect(basename(t.file)).toMatch(/^[\x20-\x7e]+$/)
      }

      expect(release.extras?.map((f) => basename(f))).toEqual(['Digital Booklet.pdf', 'cover.jpg'])
      for (const f of release.extras!) expect(existsSync(f)).toBe(true)
      expect(readFileSync(release.extras![0], 'utf8')).toContain('%PDF')
      expect(readdirSync(stagingDir).some((f) => f.endsWith('.part'))).toBe(false)
    } finally {
      await server.close()
    }
  })

  it('re-fetches the download page once when the file link answers text/html', async () => {
    const server = await bandcampStandIn({ expiredFirst: true })
    try {
      const { release, sleeps } = await run(server, 'expired')
      expect(server.hits.get('/download')).toBe(2)
      expect(sleeps).toEqual([])
      expect(release.tracks).toHaveLength(3)
      expect(release.tracks.every((t) => existsSync(t.file))).toBe(true)
      expect(release.extras?.map((f) => basename(f))).toContain('Digital Booklet.pdf')
    } finally {
      await server.close()
    }
  })

  it('fails as unavailable when the refreshed link is still dead', async () => {
    let pageHits = 0
    const server = await startServer((req, res, url) => {
      res.setHeader('content-type', 'text/html')
      if (url.pathname === '/download') {
        pageHits++
        return res.end(downloadPageHtml([{ sale_id: 9001, item_id: 1001, downloads: { flac: { url: `http://${req.headers.host}/download/album?enc=flac&sig=expired` } } }]))
      }
      if (url.pathname === '/statdownload/album') return res.end(statJsonp({ result: 'ok' }))
      res.end('<html>expired</html>')
    })
    try {
      const err = await run(server, 'dead').catch((e) => e)
      expect(err).toMatchObject({ kind: 'unavailable', message: expect.stringMatching(/expired/) })
      expect(pageHits).toBe(2)
    } finally {
      await server.close()
    }
  })
})
