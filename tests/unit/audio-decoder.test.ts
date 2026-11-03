import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { genAudio } from '../helpers/audio'
import { sandbox } from '../helpers/sandbox'
import { DecodeSession } from '@main/audio/decoder'
import { createAudioAccess, isUnder } from '@main/audio/access'
import { decodeMediaUrl, parseRange } from '@main/audio/media-url'
import { probeDurationSec } from '@main/audio/decoder'
import { ffmpegPath } from '@main/platform/binaries'
import type { PcmEvent } from '@main/audio/pcm-protocol'

const sb = sandbox('audio-decoder')
const lib = join(sb.dir, 'lib')
let flac = ''
let mp3 = ''

beforeAll(async () => {
  flac = await genAudio(join(lib, 'a.flac'), 'flac16', { seconds: 12, freq: 440 })
  mp3 = await genAudio(join(lib, 'b.mp3'), 'mp3_320', { seconds: 3, freq: 440 })
})
afterAll(() => sb.cleanup())

function session(opts: { maxBufferedSec?: number } = {}) {
  const events: PcmEvent[] = []
  const access = createAudioAccess(() => [lib])
  const s = new DecodeSession((m) => events.push(m), { ffmpeg: ffmpegPath(), resolve: (p) => access.resolve(p), durationOf: probeDurationSec, ...opts })
  const waitFor = (pred: () => boolean, ms = 20000) =>
    new Promise<void>((res, rej) => {
      const t0 = Date.now()
      const iv = setInterval(() => {
        if (pred()) {
          clearInterval(iv)
          res()
        } else if (Date.now() - t0 > ms) {
          clearInterval(iv)
          rej(new Error('timeout'))
        }
      }, 10)
    })
  return { s, events, waitFor }
}

const framesOf = (ev: PcmEvent[], id: number, gen = 0) =>
  ev.filter((e): e is Extract<PcmEvent, { type: 'pcm' }> => e.type === 'pcm' && e.streamId === id && e.gen === gen).reduce((n, e) => n + e.data.length / 2, 0)

describe('DecodeSession', () => {
  it('decodes to interleaved float at the requested rate with exact frame count and a duration', async () => {
    const { s, events, waitFor } = session({ maxBufferedSec: 60 })
    s.handle({ type: 'open', streamId: 1, gen: 0, path: flac, startSec: 0, sampleRate: 48000 })
    await waitFor(() => events.some((e) => e.type === 'eof'))
    await waitFor(() => events.some((e) => e.type === 'format'))
    const eof = events.find((e) => e.type === 'eof') as Extract<PcmEvent, { type: 'eof' }>
    expect(eof.frames).toBe(12 * 48000)
    expect(framesOf(events, 1)).toBe(12 * 48000)
    const first = events.find((e) => e.type === 'pcm') as Extract<PcmEvent, { type: 'pcm' }>
    expect(first.data).toBeInstanceOf(Float32Array)
    expect(first.data.length).toBe(4096 * 2)
    const peak = Math.max(...Array.from(first.data).map(Math.abs))
    expect(peak).toBeGreaterThan(0.05)
    expect((events.find((e) => e.type === 'format') as Extract<PcmEvent, { type: 'format' }>).durationSec).toBeCloseTo(12, 1)
    s.closeAll()
  })

  it('pauses the decoder at ~8 s unacknowledged and resumes on acks', async () => {
    const { s, events, waitFor } = session()
    s.handle({ type: 'open', streamId: 2, gen: 0, path: flac, startSec: 0, sampleRate: 44100 })
    await waitFor(() => s.isPaused(2))
    await new Promise((r) => setTimeout(r, 300))
    const sent = framesOf(events, 2)
    expect(sent).toBeGreaterThan(8 * 44100)
    expect(sent).toBeLessThan(8 * 44100 + 70000)
    expect(events.some((e) => e.type === 'eof')).toBe(false)
    s.handle({ type: 'ack', streamId: 2, gen: 0, frames: sent })
    await waitFor(() => events.some((e) => e.type === 'eof' && e.streamId === 2))
    expect(framesOf(events, 2)).toBe(12 * 44100)
    s.closeAll()
  })

  it('restarts at an offset on seek with a new generation', async () => {
    const { s, events, waitFor } = session({ maxBufferedSec: 60 })
    s.handle({ type: 'open', streamId: 3, gen: 0, path: flac, startSec: 0, sampleRate: 48000 })
    await waitFor(() => framesOf(events, 3) > 0)
    s.handle({ type: 'seek', streamId: 3, gen: 1, startSec: 10 })
    await waitFor(() => events.some((e) => e.type === 'eof' && e.gen === 1))
    expect(framesOf(events, 3, 1)).toBe(2 * 48000)
    s.closeAll()
  })

  it('applies MP3 gapless trimming (LAME tag) so the frame count matches the source', async () => {
    const { s, events, waitFor } = session({ maxBufferedSec: 60 })
    s.handle({ type: 'open', streamId: 4, gen: 0, path: mp3, startSec: 0, sampleRate: 48000 })
    await waitFor(() => events.some((e) => e.type === 'eof'))
    expect(Math.abs(framesOf(events, 4) - 3 * 48000)).toBeLessThanOrEqual(1152)
    s.closeAll()
  })

  it('refuses paths outside the allowed roots', async () => {
    const { s, events, waitFor } = session()
    s.handle({ type: 'open', streamId: 5, gen: 0, path: join(sb.dir, '..', 'nope.flac'), startSec: 0, sampleRate: 48000 })
    s.handle({ type: 'open', streamId: 6, gen: 0, path: join(lib, '..', '..', 'x.flac'), startSec: 0, sampleRate: 48000 })
    await waitFor(() => events.filter((e) => e.type === 'error').length === 2)
    expect(s.size).toBe(0)
  })
})

describe('access + media protocol helpers', () => {
  it('checks containment', () => {
    expect(isUnder('/a/b', '/a/b/c.flac')).toBe(true)
    expect(isUnder('/a/b', '/a/bc/c.flac')).toBe(false)
    expect(isUnder('/a/b', '/a/b/../x')).toBe(false)
    const acc = createAudioAccess(() => [lib, null])
    expect(acc.resolve(flac)).toBeTruthy()
    expect(acc.resolve('relative.flac')).toBeNull()
    const other = createAudioAccess(() => [])
    expect(other.resolve(flac)).toBeNull()
    other.allowPaths([flac])
    expect(other.resolve(flac)).toBeTruthy()
  })

  it('round-trips media URLs and parses ranges', () => {
    const p = 'C:\\Música\\Ünï #1?.flac'
    const url = `valence-media://file/${Buffer.from(p, 'utf8').toString('base64url')}.flac`
    expect(decodeMediaUrl(url)).toBe(p)
    expect(decodeMediaUrl('https://file/abc')).toBeNull()
    expect(parseRange('bytes=0-99', 1000)).toEqual({ start: 0, end: 99 })
    expect(parseRange('bytes=900-', 1000)).toEqual({ start: 900, end: 999 })
    expect(parseRange('bytes=-100', 1000)).toEqual({ start: 900, end: 999 })
    expect(parseRange('bytes=5-2000', 1000)).toEqual({ start: 5, end: 999 })
    expect(parseRange('bytes=1000-', 1000)).toBe('invalid')
    expect(parseRange(null, 1000)).toBeNull()
  })
})
