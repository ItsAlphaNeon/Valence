import { describe, expect, it } from 'vitest'
import {
  bcDate,
  chromeUserAgent,
  dataBlob,
  decodeEntities,
  findAttr,
  parseCollectionPage,
  parseDownloadPage,
  parseIdentity,
  parseStatResponse,
  parseTralbum,
  pickDigitalItem,
  toCollectionItem,
  toStatUrl,
} from '@main/sources/bandcamp/parse'
import { SourceError } from '@main/import/source-types'
import { fixture, fixtureJson, statJsonp } from '../fixtures/bandcamp/helpers'

describe('HTML data blobs', () => {
  it('decodes named and numeric entities in a single pass', () => {
    expect(decodeEntities('a &amp; b &lt;c&gt; &quot;d&quot; &#39;e&#39; &#x2019; &#8212;')).toBe(`a & b <c> "d" 'e' ’ —`)
    expect(decodeEntities('&amp;quot; stays &quot;')).toBe('&quot; stays "')
    expect(decodeEntities('&bogus; &#0; &')).toBe('&bogus; &#0; &')
  })

  it('reads attributes whose quoted value contains > and entities', () => {
    const page = `<div class="x" data-vars="{&quot;x&quot;:&quot;a &gt; b&quot;}"></div><div id='pagedata' data-blob='{"ok":true}'>`
    expect(findAttr(page, 'data-vars')).toBe('{"x":"a > b"}')
    expect(dataBlob(page, 'data-vars')).toEqual({ x: 'a > b' })
    expect(dataBlob(page, 'data-blob', 'pagedata')).toEqual({ ok: true })
    expect(dataBlob(page, 'data-blob', 'missing')).toBeNull()
  })

  it('returns null for invalid JSON instead of throwing', () => {
    expect(dataBlob('<div id="pagedata" data-blob="{nope"></div>', 'data-blob', 'pagedata')).toBeNull()
  })

  it('extracts data-tralbum with entity-encoded quotes and ampersands', () => {
    const t = dataBlob(fixture('album-page.html'), 'data-tralbum')
    expect(t.trackinfo[0].title).toBe('Opening & "Intro"')
    expect(t.trackinfo[1].title).toBe('Café Noir')
  })
})

describe('fan identity', () => {
  it('reads fan_id from the #HomepageApp blob', () => {
    expect(parseIdentity(fixture('homepage.html'))).toEqual({ fanId: 5550001, username: 'synthfan', verified: true })
  })

  it('falls back to #pagedata identities.fan', () => {
    expect(parseIdentity(fixture('homepage-pagedata.html'))).toMatchObject({ fanId: 5550001, username: 'synthfan', fanUrl: 'https://bandcamp.com/synthfan' })
  })

  it('falls back to the fan page fan_data', () => {
    expect(parseIdentity(fixture('fan-page.html'))).toMatchObject({ fanId: 5550001, username: 'synthfan' })
  })

  it('returns null when logged out', () => {
    expect(parseIdentity(fixture('homepage-logged-out.html'))).toBeNull()
  })
})

describe('collection API', () => {
  it('parses a page and flags item kinds', () => {
    const p1 = parseCollectionPage(fixtureJson('collection-1.json'))
    const p2 = parseCollectionPage(fixtureJson('collection-2.json'))
    expect(p1.moreAvailable).toBe(true)
    expect(p1.lastToken).toBe('1700000000:2002:t::')
    const urls = { ...p1.redownloadUrls, ...p2.redownloadUrls }
    const tracklists = { ...p1.tracklists, ...p2.tracklists }
    const items = [...p1.items, ...p2.items].map((r) => toCollectionItem(r, { redownloadUrls: urls, tracklists })!)
    const byKey = Object.fromEntries(items.map((i) => [i.key, i]))
    expect(Object.keys(byKey)).toEqual(['a9001', 't9002', 'p9003', 'p9004', 'a9005'])
    expect(byKey.a9001).toMatchObject({ itemType: 'album', tralbumType: 'album', tralbumId: 1001, downloadable: true, artId: 111, trackCount: 3 })
    expect(byKey.a9001.tracks?.map((t) => t.trackId)).toEqual([7001, 7002, 7003])
    expect(byKey.a9001.redownloadUrl).toContain('sitem_id=9001')
    expect(byKey.t9002).toMatchObject({ itemType: 'track', tralbumType: 'track', tralbumId: 2002, downloadable: true })
    expect(byKey.p9003).toMatchObject({ itemType: 'package', physicalOnly: true, downloadable: false, tralbumId: 3100 })
    expect(byKey.p9004).toMatchObject({ itemType: 'package', physicalOnly: false, downloadable: true, tralbumId: 4100, trackCount: 2 })
    expect(byKey.a9005).toMatchObject({ preorder: true, downloadable: false })
    expect(byKey.a9001.purchased).toBe('2023-07-07T01:34:59.000Z')
  })

  it('surfaces API errors', () => {
    expect(() => parseCollectionPage({ error: true, error_message: 'No such fan' })).toThrow(SourceError)
    expect(() => parseCollectionPage('nope')).toThrow(/not JSON/)
  })
})

describe('download page', () => {
  it('finds the purchase and its FLAC url', () => {
    const page = parseDownloadPage(fixture('download-page.html'))!
    expect(page.emailReauth).toBe(false)
    expect(page.fanVerified).toBe(true)
    expect(page.items).toHaveLength(2)
    const d = pickDigitalItem(page, { saleItemId: 9001 })!
    expect(d).toMatchObject({ itemId: 1001, tralbumId: 1001, tralbumType: 'album', title: 'Synthetic Album', artist: 'Synth Artist', artId: 111, releaseDate: '2023-09-05' })
    expect(d.flacUrl).toBe('https://popplers5.bandcamp.com/download/album?enc=flac&id=1001&sig=abc&sitem_id=9001')
    expect(Object.keys(d.downloads)).toContain('mp3-320')
    expect(pickDigitalItem(page, { tralbumId: 1001 })?.itemId).toBe(1001)
  })

  it('maps a package to its album download', () => {
    const d = pickDigitalItem(parseDownloadPage(fixture('download-page-package.html'))!, { saleItemId: 9004 })!
    expect(d).toMatchObject({ itemType: 'p', itemId: 4004, tralbumId: 4100, tralbumType: 'album' })
    expect(d.flacUrl).toContain('id=4100')
  })

  it('detects the email re-confirmation block', () => {
    const page = parseDownloadPage(fixture('download-reauth.html'))!
    expect(page.emailReauth).toBe(true)
    expect(page.items[0].flacUrl).toBeNull()
  })

  it('returns null without #pagedata', () => {
    expect(parseDownloadPage('<html><body>Log in</body></html>')).toBeNull()
  })
})

describe('statdownload', () => {
  const url = 'https://popplers5.bandcamp.com/download/album?enc=flac&id=1&sig=abc&sitem_id=2'

  it('builds the stat url with cache busting', () => {
    const u = new URL(toStatUrl(url, () => 0.5)!)
    expect(u.pathname).toBe('/statdownload/album')
    expect(u.searchParams.get('.rand')).toBe('500000000000')
    expect(u.searchParams.get('.vrs')).toBe('1')
    expect(u.searchParams.get('sig')).toBe('abc')
    expect(toStatUrl('https://p4.bcbits.com/stream/x')).toBeNull()
    expect(toStatUrl('not a url')).toBeNull()
  })

  it('parses ok / retry / error JSONP', () => {
    expect(parseStatResponse(statJsonp({ result: 'ok', download_url: 'https://p4.bcbits.com/x' }))).toEqual({ result: 'ok', downloadUrl: 'https://p4.bcbits.com/x', retryUrl: undefined, errorType: undefined })
    expect(parseStatResponse(statJsonp({ result: 'err', retry_url: 'https://popplers5.bandcamp.com/download/album?x=1', errortype: 'NotReady' }))).toMatchObject({ result: 'err', retryUrl: 'https://popplers5.bandcamp.com/download/album?x=1', errorType: 'NotReady' })
    expect(parseStatResponse(statJsonp({ result: 'err', errortype: 'ExpirationError', retry_url: '' }))).toMatchObject({ result: 'err', retryUrl: undefined, errorType: 'ExpirationError' })
  })

  it('parses the legacy JS-object form and escaped slashes', () => {
    expect(parseStatResponse("var _statDL_result = { result: 'ok'};")).toMatchObject({ result: 'ok' })
    expect(parseStatResponse(`var _statDL_result = { result: 'ok', "download_url":"https:\\/\\/p4.bcbits.com\\/y" };`)).toMatchObject({ result: 'ok', downloadUrl: 'https://p4.bcbits.com/y' })
    expect(parseStatResponse('<html>oops</html>')).toBeNull()
  })
})

describe('album / track page', () => {
  it('parses a label-owned album page', () => {
    const t = parseTralbum(fixture('album-page.html'))!
    expect(t).toMatchObject({
      id: 1001,
      itemType: 'album',
      title: 'Synthetic Album',
      artist: 'Synth Artist',
      artId: 111,
      releaseDate: '2023-09-05',
      upc: '0123456789012',
      bandName: 'Synth Label',
      label: 'Synth Label',
      url: 'https://synthlabel.bandcamp.com/album/synthetic-album',
      tags: ['electronic', 'ambient', 'Berlin'],
      preorder: false,
    })
    expect(t.tracks).toEqual([
      { trackId: 7001, trackNum: 1, title: 'Opening & "Intro"', artist: undefined, durationMs: 2000 },
      { trackId: 7002, trackNum: 2, title: 'Café Noir', artist: 'Guest Singer', durationMs: 2000 },
      { trackId: 7003, trackNum: 3, title: 'Closing Theme', artist: undefined, durationMs: 2000 },
    ])
  })

  it('parses an artist-owned track page', () => {
    const t = parseTralbum(fixture('track-page.html'))!
    expect(t).toMatchObject({ id: 2002, itemType: 'track', title: 'Lone Track', artist: 'Other Band', label: undefined, tags: ['rock', 'indie'] })
    expect(t.tracks).toEqual([{ trackId: 2002, trackNum: 1, title: 'Lone Track', artist: undefined, durationMs: 3500 }])
  })

  it('returns null without data-tralbum', () => {
    expect(parseTralbum(fixture('homepage.html'))).toBeNull()
  })
})

describe('misc', () => {
  it('normalizes Bandcamp dates', () => {
    expect(bcDate('05 Sep 2023 00:00:00 GMT')).toBe('2023-09-05')
    expect(bcDate('Tue, 5 Sep 2023 10:00:00 GMT')).toBe('2023-09-05')
    expect(bcDate('2021-02-03T00:00:00Z')).toBe('2021-02-03')
    expect(bcDate('')).toBeUndefined()
    expect(bcDate(null)).toBeUndefined()
  })

  it('strips Electron and app tokens from the UA', () => {
    const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) valence/0.1.0 Chrome/156.0.7712.31 Electron/45.2.1 Safari/537.36'
    expect(chromeUserAgent(ua)).toBe('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36')
  })
})
