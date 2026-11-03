import { describe, expect, it } from 'vitest'
import { SourceError } from '@main/import/source-types'
import { decodeManifest, isoDurationSeconds, parseBts, parseDash } from '@main/sources/tidal/manifest'
import { fixture, fixtureText } from '../fixtures/tidal/support'

const b64 = (s: string) => Buffer.from(s).toString('base64')

function expectKind(fn: () => unknown, kind: SourceError['kind']) {
  try {
    fn()
  } catch (e) {
    expect(e).toBeInstanceOf(SourceError)
    expect((e as SourceError).kind).toBe(kind)
    return
  }
  throw new Error(`expected SourceError(${kind})`)
}

describe('tidal manifest: BTS', () => {
  it('decodes a BTS FLAC manifest from playbackinfo', () => {
    const info = fixture('playbackinfo-bts-flac.json')
    const m = decodeManifest(info.manifestMimeType, info.manifest)
    expect(m).toEqual({ kind: 'bts', mimeType: 'audio/flac', codecs: 'flac', urls: ['__SERVER__/media/t1.flac'] })
  })

  it('refuses encryptionType other than NONE', () => {
    const info = fixture('playbackinfo-bts-drm.json')
    expectKind(() => decodeManifest(info.manifestMimeType, info.manifest), 'drm')
  })

  it('refuses a manifest carrying a keyId even if encryptionType is NONE', () => {
    const info = fixture('playbackinfo-bts-keyid.json')
    expectKind(() => decodeManifest(info.manifestMimeType, info.manifest), 'drm')
  })

  it('rejects malformed BTS JSON and empty url lists', () => {
    expectKind(() => parseBts('{nope'), 'parse')
    expectKind(() => parseBts(JSON.stringify({ mimeType: 'audio/flac', encryptionType: 'NONE', urls: [] })), 'parse')
  })

  it('treats unknown manifest types as unavailable', () => {
    expectKind(() => decodeManifest('application/vnd.tidal.emu', b64('xyz')), 'unavailable')
  })
})

describe('tidal manifest: DASH', () => {
  it('expands a TIDAL-style SegmentTimeline with r into Σ(r+1) segments', () => {
    const info = fixture('playbackinfo-dash.json')
    const m = decodeManifest(info.manifestMimeType, info.manifest)
    expect(m.kind).toBe('dash')
    expect(m.codecs).toBe('flac')
    expect(m.mimeType).toBe('audio/mp4')
    expect(m.sampleRate).toBe(44100)
    expect(m.init).toBe('https://cdn.example.test/mediatracks/AAAA/0.mp4?token=t')
    expect(m.segments).toHaveLength(52 + 1)
    expect(m.segments![0]).toBe('https://cdn.example.test/mediatracks/AAAA/1.mp4?token=t')
    expect(m.segments!.at(-1)).toBe('https://cdn.example.test/mediatracks/AAAA/53.mp4?token=t')
    expect(m.urls).toHaveLength(54)
    expect(m.urls[0]).toBe(m.init)
  })

  it('does not mistake a cenc namespace declaration for protection', () => {
    expect(fixtureText('dash-tidal.mpd')).toContain('xmlns:cenc')
    expect(() => parseDash(fixtureText('dash-tidal.mpd'))).not.toThrow()
  })

  it('refuses <ContentProtection>', () => {
    expectKind(() => parseDash(fixtureText('dash-protected.mpd')), 'drm')
    expectKind(() => decodeManifest('application/dash+xml', b64(fixtureText('dash-protected.mpd'))), 'drm')
  })

  it('refuses cenc:default_KID on a representation', () => {
    const xml = fixtureText('dash-tidal.mpd').replace('codecs="flac"', 'codecs="flac" cenc:default_KID="0123-4567"')
    expectKind(() => parseDash(xml), 'drm')
  })

  it('prefers group="main", resolves BaseURL, %0Nd widths, $RepresentationID$ and startNumber', () => {
    const xml = `<?xml version="1.0"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" mediaPresentationDuration="PT4S">
  <BaseURL>http://127.0.0.1:9/base/</BaseURL>
  <Period>
    <AdaptationSet id="0" contentType="audio" mimeType="audio/mp4">
      <Representation id="low" codecs="mp4a.40.2" bandwidth="96000">
        <SegmentTemplate timescale="1000" initialization="wrong-$RepresentationID$.mp4" media="wrong-$Number$.mp4">
          <SegmentTimeline><S d="1000" r="3"/></SegmentTimeline>
        </SegmentTemplate>
      </Representation>
    </AdaptationSet>
    <AdaptationSet id="1" group="main" contentType="audio" mimeType="audio/mp4">
      <SegmentTemplate timescale="44100" initialization="init-$RepresentationID$.m4s" media="chunk-$RepresentationID$-$Number%05d$.m4s" startNumber="7">
        <SegmentTimeline><S t="0" d="46080" r="2"/><S d="39456"/></SegmentTimeline>
      </SegmentTemplate>
      <Representation id="a" codecs="flac" bandwidth="800000" audioSamplingRate="44100"/>
      <Representation id="b" codecs="flac" bandwidth="900000" audioSamplingRate="48000"/>
    </AdaptationSet>
  </Period>
</MPD>`
    const m = parseDash(xml)
    expect(m.codecs).toBe('flac')
    expect(m.sampleRate).toBe(48000) // highest-bandwidth representation
    expect(m.init).toBe('http://127.0.0.1:9/base/init-b.m4s')
    expect(m.segments).toEqual([7, 8, 9, 10].map((n) => `http://127.0.0.1:9/base/chunk-b-${String(n).padStart(5, '0')}.m4s`))
  })

  it('supports $Time$ templates and r=-1 (repeat to the end of the period)', () => {
    const xml = `<MPD mediaPresentationDuration="PT10S"><Period><AdaptationSet mimeType="audio/mp4" codecs="flac">
      <SegmentTemplate timescale="10" media="https://x.test/s/$Time$.m4s"><SegmentTimeline><S t="0" d="40" r="-1"/></SegmentTimeline></SegmentTemplate>
      <Representation id="r"/></AdaptationSet></Period></MPD>`
    const m = parseDash(xml)
    expect(m.init).toBeUndefined()
    expect(m.segments).toEqual(['https://x.test/s/0.m4s', 'https://x.test/s/40.m4s', 'https://x.test/s/80.m4s'])
  })

  it('falls back to SegmentTemplate@duration without a timeline', () => {
    const xml = `<MPD mediaPresentationDuration="PT0M5.5S"><Period><AdaptationSet contentType="audio">
      <Representation id="r" codecs="flac"><SegmentTemplate timescale="1" duration="2" initialization="https://x.test/i.mp4" media="https://x.test/$Number$.mp4"/></Representation>
    </AdaptationSet></Period></MPD>`
    expect(parseDash(xml).segments).toEqual(['https://x.test/1.mp4', 'https://x.test/2.mp4', 'https://x.test/3.mp4'])
  })

  it('parses ISO durations', () => {
    expect(isoDurationSeconds('PT3M30.000S')).toBe(210)
    expect(isoDurationSeconds('PT1H2M3S')).toBe(3723)
    expect(isoDurationSeconds('garbage')).toBe(0)
  })

  it('rejects manifests without segments or MPD', () => {
    expectKind(() => parseDash('<root/>'), 'parse')
    expectKind(() => parseDash('<MPD><Period><AdaptationSet contentType="audio"><Representation id="x"/></AdaptationSet></Period></MPD>'), 'parse')
  })
})
