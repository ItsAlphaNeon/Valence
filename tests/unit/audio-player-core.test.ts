import { describe, expect, it } from 'vitest'
import { PlayerCore, type CoreEvent, type CoreOptions } from '@renderer/audio/worklet/player-core'
import type { PcmRequest } from '@main/audio/pcm-protocol'

const SR = 48000

function rng(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 2 ** 32
  }
}

function setup(opts: Partial<CoreOptions> = {}) {
  const host: CoreEvent[] = []
  const dec: PcmRequest[] = []
  const core = new PlayerCore({ sampleRate: SR, ...opts }, { host: (e) => host.push(e), decoder: (m) => dec.push(m) })
  return { core, host, dec }
}

/** Interleaved stereo from per-frame functions. */
function stereo(n: number, l: (i: number) => number, r: (i: number) => number = l): Float32Array {
  const a = new Float32Array(n * 2)
  for (let i = 0; i < n; i++) {
    a[i * 2] = l(i)
    a[i * 2 + 1] = r(i)
  }
  return a
}

function feed(core: PlayerCore, streamId: number, data: Float32Array, rand: () => number, gen = 0, eof = true) {
  let off = 0
  const frames = data.length / 2
  while (off < frames) {
    const n = Math.min(frames - off, 1 + Math.floor(rand() * 5000))
    core.onDecoder({ type: 'pcm', streamId, gen, data: data.slice(off * 2, (off + n) * 2) })
    off += n
  }
  if (eof) core.onDecoder({ type: 'eof', streamId, gen, frames })
}

function render(core: PlayerCore, frames: number, q = 128) {
  const L = new Float32Array(frames)
  const R = new Float32Array(frames)
  const l = new Float32Array(q)
  const r = new Float32Array(q)
  for (let i = 0; i < frames; i += q) {
    core.render(l, r, q)
    L.set(l.subarray(0, Math.min(q, frames - i)), i)
    R.set(r.subarray(0, Math.min(q, frames - i)), i)
  }
  return { L, R }
}

const load = (core: PlayerCore, streamId: number, play = true, extra: Partial<{ startFrame: number; durationFrames: number | null; gain: number }> = {}) =>
  core.command({ type: 'load', streamId, path: `/x/${streamId}.flac`, startFrame: 0, gain: 1, durationFrames: null, play, ...extra })

const next = (core: PlayerCore, streamId: number, crossfadeFrames = 0) =>
  core.command({ type: 'next', streamId, path: `/x/${streamId}.flac`, gain: 1, durationFrames: null, crossfadeFrames })

function zeroRuns(x: Float32Array, from: number, to: number, minRun = 32, eps = 1e-4) {
  let runs = 0
  let run = 0
  for (let i = from; i < to; i++) {
    if (Math.abs(x[i]) < eps) {
      if (++run === minRun) runs++
    } else run = 0
  }
  return runs
}

function maxDelta(x: Float32Array, from: number, to: number) {
  let m = 0
  for (let i = from + 1; i < to; i++) m = Math.max(m, Math.abs(x[i] - x[i - 1]))
  return m
}

describe('PlayerCore gapless', () => {
  it('joins two segments of one continuous sine sample-accurately at random offsets', () => {
    const rand = rng(42)
    const f = 997
    const A = 0.5
    const N = Math.round(SR * 0.6)
    const sine = stereo(N, (i) => A * Math.sin((2 * Math.PI * f * i) / SR), (i) => A * Math.cos((2 * Math.PI * f * i) / SR))
    const slope = (2 * Math.PI * f * A) / SR
    for (let trial = 0; trial < 25; trial++) {
      const b = 2000 + Math.floor(rand() * (N - 4000))
      const { core, host } = setup()
      load(core, 1)
      feed(core, 1, sine.slice(0, b * 2), rand)
      next(core, 2)
      feed(core, 2, sine.slice(b * 2), rand)
      const out = render(core, N + 2048)
      const ramp = Math.round(SR * 0.01)
      for (let i = ramp; i < N; i++) {
        if (out.L[i] !== sine[i * 2] || out.R[i] !== sine[i * 2 + 1]) throw new Error(`trial ${trial} b=${b}: mismatch at ${i}`)
      }
      expect(maxDelta(out.L, 0, N)).toBeLessThanOrEqual(slope * 1.0001)
      expect(maxDelta(out.R, 0, N)).toBeLessThanOrEqual(slope * 1.0001)
      expect(zeroRuns(out.L, 1, N)).toBe(0)
      for (let i = N; i < out.L.length; i++) expect(out.L[i]).toBe(0)
      const tr = host.filter((e) => e.type === 'transition')
      expect(tr).toEqual([{ type: 'transition', from: 1, to: 2, crossfade: false }])
      expect(host.some((e) => e.type === 'stall')).toBe(false)
      expect(host.some((e) => e.type === 'ended' && e.streamId === 2)).toBe(true)
      expect(core.playedFrames).toBe(N)
    }
  })

  it('streams through a small ring with flow-controlled feeding (ring wrap + pending queue)', () => {
    const rand = rng(7)
    const N = SR * 2
    const sig = stereo(N, (i) => Math.sin(i * 0.01) * 0.3)
    const { core, dec } = setup({ ringSec: 0.1, prebufferSec: 0.02 })
    load(core, 1)
    let sent = 0
    let acked = 0
    const pump = () => {
      while (sent < N && sent - acked < SR * 0.25) {
        const n = Math.min(N - sent, 1 + Math.floor(rand() * 3000))
        core.onDecoder({ type: 'pcm', streamId: 1, gen: 0, data: sig.slice(sent * 2, (sent + n) * 2) })
        sent += n
      }
      if (sent === N) core.onDecoder({ type: 'eof', streamId: 1, gen: 0, frames: N })
    }
    pump()
    const L = new Float32Array(N + 1024)
    const l = new Float32Array(128)
    const r = new Float32Array(128)
    let seen = 0
    for (let i = 0; i < L.length; i += 128) {
      core.render(l, r, 128)
      L.set(l.subarray(0, Math.min(128, L.length - i)), i)
      for (; seen < dec.length; seen++) {
        const m = dec[seen]
        if (m.type === 'ack') acked += m.frames
      }
      pump()
    }
    const ramp = SR * 0.01
    for (let i = ramp; i < N; i++) if (L[i] !== sig[i * 2]) throw new Error(`mismatch at ${i}`)
    expect(N - acked).toBeLessThan(4096)
  })
})

describe('PlayerCore crossfade', () => {
  it('uses an equal-power curve that starts N frames before the end', () => {
    const rand = rng(3)
    const len = SR
    const xf = Math.round(SR * 0.25)
    const { core, host } = setup()
    load(core, 1)
    feed(core, 1, stereo(len, () => 1, () => 0), rand)
    next(core, 2, xf)
    feed(core, 2, stereo(len, () => 0, () => 1), rand)
    const total = len * 2 - xf
    const out = render(core, total + 1024)
    const ramp = SR * 0.01
    const start = len - xf
    for (let i = ramp; i < start; i++) {
      expect(out.L[i]).toBe(1)
      expect(out.R[i]).toBe(0)
    }
    for (let i = start; i < start + xf; i++) {
      const p = out.L[i] ** 2 + out.R[i] ** 2
      if (Math.abs(p - 1) > 1e-5) throw new Error(`power ${p} at ${i}`)
    }
    expect(out.L[start + 1]).toBeGreaterThan(out.R[start + 1])
    expect(out.R[start + xf - 2]).toBeGreaterThan(out.L[start + xf - 2])
    for (let i = start + xf; i < total; i++) {
      expect(out.L[i]).toBeCloseTo(0, 6)
      expect(out.R[i]).toBe(1)
    }
    for (let i = total; i < out.L.length; i++) expect(out.R[i]).toBe(0)
    expect(host.filter((e) => e.type === 'transition')).toEqual([{ type: 'transition', from: 1, to: 2, crossfade: true }])
  })

  it('falls back to the duration estimate before EOF is known', () => {
    const { core, host } = setup()
    load(core, 1, true, { durationFrames: SR })
    core.onDecoder({ type: 'pcm', streamId: 1, gen: 0, data: stereo(SR, () => 1, () => 0) })
    next(core, 2, SR / 4)
    core.onDecoder({ type: 'pcm', streamId: 2, gen: 0, data: stereo(SR / 2, () => 0, () => 1) })
    render(core, SR - SR / 4 + 256)
    expect(host.some((e) => e.type === 'transition' && e.crossfade)).toBe(true)
  })

  it('applies per-voice gain', () => {
    const { core } = setup()
    load(core, 1, true, { gain: 0.5 })
    core.onDecoder({ type: 'pcm', streamId: 1, gen: 0, data: stereo(SR / 2, () => 1) })
    const out = render(core, SR / 4)
    expect(out.L[SR / 8]).toBeCloseTo(0.5, 6)
    core.command({ type: 'gain', streamId: 1, gain: 0.25 })
    const out2 = render(core, SR / 8)
    expect(out2.L[SR / 8 - 1]).toBeCloseTo(0.25, 4)
  })
})

describe('PlayerCore underrun, seek, pause', () => {
  it('outputs silence and emits a stall on underrun, then resumes with a ramp', () => {
    const { core, host } = setup()
    load(core, 1)
    const half = SR / 2
    core.onDecoder({ type: 'pcm', streamId: 1, gen: 0, data: stereo(half, () => 0.5) })
    const a = render(core, SR)
    expect(a.L[half - 10]).toBe(0.5)
    for (let i = half; i < SR; i++) expect(a.L[i]).toBe(0)
    expect(host.filter((e) => e.type === 'stall')).toHaveLength(1)
    const pos = host.filter((e) => e.type === 'pos').at(-1)
    expect(pos).toMatchObject({ buffering: true, frame: half })
    core.onDecoder({ type: 'pcm', streamId: 1, gen: 0, data: stereo(half, () => 0.5) })
    const b = render(core, 2048)
    expect(b.L[0]).toBeLessThan(0.01)
    expect(b.L[1000]).toBe(0.5)
    expect(host.filter((e) => e.type === 'buffering').at(-1)).toMatchObject({ buffering: false })
  })

  it('ramps down over 10 ms, flushes, drops stale chunks and restarts the decoder on seek', () => {
    const rand = rng(11)
    const { core, host, dec } = setup()
    load(core, 1)
    feed(core, 1, stereo(SR, () => 0.8), rand, 0, false)
    render(core, SR / 5)
    core.command({ type: 'seek', frame: 30000 })
    const ramp = render(core, 1024)
    const rampFrames = SR * 0.01
    expect(ramp.L[0]).toBeGreaterThan(0.7)
    for (let i = 1; i < rampFrames; i++) expect(ramp.L[i]).toBeLessThanOrEqual(ramp.L[i - 1])
    for (let i = rampFrames; i < 1024; i++) expect(ramp.L[i]).toBe(0)
    const seek = dec.find((m) => m.type === 'seek')
    expect(seek).toEqual({ type: 'seek', streamId: 1, gen: 1, startSec: 30000 / SR })
    core.onDecoder({ type: 'pcm', streamId: 1, gen: 0, data: stereo(SR, () => 0.8) })
    expect(render(core, 1024).L.every((x) => x === 0)).toBe(true)
    core.onDecoder({ type: 'pcm', streamId: 1, gen: 1, data: stereo(SR, () => -0.3) })
    const after = render(core, 2048)
    expect(Math.abs(after.L[0])).toBeLessThan(0.01)
    expect(after.L[1000]).toBeCloseTo(-0.3, 6)
    const pos = host.filter((e) => e.type === 'pos').at(-1) as Extract<CoreEvent, { type: 'pos' }> | undefined
    core.report()
    const last = host.at(-1) as Extract<CoreEvent, { type: 'pos' }>
    expect(last.frame).toBe(30000 + 2048)
    expect(pos).toBeDefined()
  })

  it('ramps 30 ms on pause/resume and freezes consumption while paused', () => {
    const { core, host } = setup()
    load(core, 1)
    core.onDecoder({ type: 'pcm', streamId: 1, gen: 0, data: stereo(SR * 2, () => 1) })
    render(core, SR / 10)
    core.command({ type: 'pause' })
    const p = render(core, 4096)
    const rampFrames = SR * 0.03
    expect(p.L[0]).toBeGreaterThan(0.99)
    expect(p.L[rampFrames / 2]).toBeCloseTo(0.5, 2)
    for (let i = rampFrames; i < 4096; i++) expect(p.L[i]).toBe(0)
    expect(host.filter((e) => e.type === 'paused')).toHaveLength(1)
    core.report()
    const f1 = (host.at(-1) as Extract<CoreEvent, { type: 'pos' }>).frame
    render(core, SR / 10)
    core.report()
    expect((host.at(-1) as Extract<CoreEvent, { type: 'pos' }>).frame).toBe(f1)
    core.command({ type: 'play' })
    const r = render(core, 4096)
    expect(r.L[0]).toBeLessThan(0.01)
    expect(r.L[rampFrames / 2]).toBeCloseTo(0.5, 2)
    expect(r.L[rampFrames + 10]).toBe(1)
  })

  it('defers commands behind a pending ramp (load then next)', () => {
    const { core, dec } = setup()
    load(core, 1)
    core.onDecoder({ type: 'pcm', streamId: 1, gen: 0, data: stereo(SR, () => 1) })
    render(core, 4096)
    load(core, 5)
    next(core, 6)
    expect(dec.filter((m) => m.type === 'open').map((m) => (m as { streamId: number }).streamId)).toEqual([1])
    render(core, 1024)
    const opens = dec.filter((m) => m.type === 'open').map((m) => (m as { streamId: number }).streamId)
    expect(opens).toEqual([1, 5, 6])
    expect(dec.some((m) => m.type === 'close' && m.streamId === 1)).toBe(true)
    expect(core.cur?.id).toBe(5)
    expect(core.nxt?.id).toBe(6)
  })
})

describe('PlayerCore credit accounting', () => {
  it('acks consumed frames per stream and generation', () => {
    const rand = rng(5)
    const { core, dec } = setup({ ackFrames: 4096 })
    load(core, 1)
    feed(core, 1, stereo(SR, () => 0.1), rand, 0, false)
    render(core, 20000)
    const acks = dec.filter((m) => m.type === 'ack') as Extract<PcmRequest, { type: 'ack' }>[]
    const sum = acks.reduce((s, a) => s + a.frames, 0)
    expect(acks.every((a) => a.streamId === 1 && a.gen === 0 && a.frames >= 4096)).toBe(true)
    expect(core.cur!.pos - sum).toBeLessThan(4096)
    expect(core.cur!.pos - sum).toBeGreaterThanOrEqual(0)
    core.command({ type: 'seek', frame: 1000 })
    render(core, 1024)
    core.onDecoder({ type: 'pcm', streamId: 1, gen: 1, data: stereo(SR, () => 0.1) })
    render(core, 10000)
    const acks1 = (dec.filter((m) => m.type === 'ack') as Extract<PcmRequest, { type: 'ack' }>[]).filter((a) => a.gen === 1)
    expect(acks1.length).toBeGreaterThan(0)
    const sum1 = acks1.reduce((s, a) => s + a.frames, 0)
    expect(core.cur!.pos - 1000 - sum1).toBeLessThan(4096)
  })

  it('ignores chunks for unknown streams or stale generations', () => {
    const { core } = setup()
    load(core, 1)
    core.onDecoder({ type: 'pcm', streamId: 9, gen: 0, data: stereo(1000, () => 1) })
    core.onDecoder({ type: 'pcm', streamId: 1, gen: 3, data: stereo(1000, () => 1) })
    expect(core.cur!.available()).toBe(0)
  })

  it('treats a decoder error as end of stream and moves on', () => {
    const { core, host } = setup()
    load(core, 1)
    next(core, 2)
    core.onDecoder({ type: 'error', streamId: 1, gen: 0, message: 'boom' })
    core.onDecoder({ type: 'pcm', streamId: 2, gen: 0, data: stereo(SR / 2, () => 0.2) })
    const out = render(core, 4096)
    expect(host.some((e) => e.type === 'error')).toBe(true)
    expect(host.some((e) => e.type === 'transition' && e.to === 2)).toBe(true)
    expect(out.L[2000]).toBeCloseTo(0.2, 6)
  })

  it('accepts stop and a new load after the queue ended', () => {
    const { core, host, dec } = setup()
    load(core, 1)
    core.onDecoder({ type: 'pcm', streamId: 1, gen: 0, data: stereo(2000, () => 0.3) })
    core.onDecoder({ type: 'eof', streamId: 1, gen: 0, frames: 2000 })
    render(core, 4096)
    expect(host.some((e) => e.type === 'ended')).toBe(true)
    core.command({ type: 'stop' })
    load(core, 2)
    expect(dec.filter((m) => m.type === 'open').map((m) => (m as { streamId: number }).streamId)).toEqual([1, 2])
    core.onDecoder({ type: 'pcm', streamId: 2, gen: 0, data: stereo(SR, () => 0.4) })
    const out = render(core, 8192)
    expect(core.cur?.id).toBe(2)
    expect(out.L[8000]).toBeCloseTo(0.4, 6)
  })
})

describe('PlayerCore configurable fades', () => {
  const playing = () => {
    const env = setup()
    load(env.core, 1)
    env.core.onDecoder({ type: 'pcm', streamId: 1, gen: 0, data: stereo(SR * 2, () => 1) })
    render(env.core, SR / 10)
    return env
  }
  const opens = (dec: PcmRequest[], id: number) => dec.filter((m) => m.type === 'open' && (m as { streamId: number }).streamId === id).length

  it("'ramps' sets the pause/resume ramp length", () => {
    const { core, host } = playing()
    const frames = Math.round(SR * 0.12)
    core.command({ type: 'ramps', pauseFrames: frames })
    core.command({ type: 'pause' })
    const p = render(core, 8192)
    expect(p.L[frames / 2]).toBeCloseTo(0.5, 2)
    expect(p.L[Math.round(SR * 0.03)]).toBeGreaterThan(0.7)
    for (let i = frames; i < 8192; i++) expect(p.L[i]).toBe(0)
    expect(host.filter((e) => e.type === 'paused')).toHaveLength(1)
    core.command({ type: 'play' })
    const r = render(core, 8192)
    expect(r.L[frames / 2]).toBeCloseTo(0.5, 2)
    expect(r.L[frames + 10]).toBe(1)
  })

  it('load with fadeOutFrames fades the old track over that long before switching', () => {
    const frames = Math.round(SR * 0.1)
    const { core, dec } = playing()
    core.command({ type: 'load', streamId: 2, path: '/x/2.flac', startFrame: 0, gain: 1, durationFrames: null, play: true, fadeOutFrames: frames })
    const out = render(core, 2048)
    expect(out.L[1024]).toBeCloseTo(1 - 1024 / frames, 2)
    expect(opens(dec, 2)).toBe(0)
    const rest = render(core, frames)
    expect(opens(dec, 2)).toBe(1)
    expect(rest.L[frames - 2048 - 1]).toBe(0)
    core.onDecoder({ type: 'pcm', streamId: 2, gen: 0, data: stereo(SR, () => 0.5) })
    const after = render(core, 4096)
    expect(after.L[4000]).toBeCloseTo(0.5, 6)
    expect(core.cur?.id).toBe(2)
  })

  it('a plain load still switches after the 10 ms ramp', () => {
    const { core, dec } = playing()
    load(core, 2)
    render(core, 256)
    expect(opens(dec, 2)).toBe(0)
    render(core, SR * 0.01)
    expect(opens(dec, 2)).toBe(1)
  })

  it('stop with fadeOutFrames ramps down, then reports paused; short values keep the 10 ms ramp', () => {
    const { core, host } = playing()
    const frames = Math.round(SR * 0.2)
    core.command({ type: 'stop', fadeOutFrames: frames })
    const out = render(core, frames + 1024)
    expect(out.L[frames / 2]).toBeCloseTo(0.5, 2)
    expect(out.L[frames + 512]).toBe(0)
    expect(host.filter((e) => e.type === 'paused')).toHaveLength(1)

    const s = playing()
    s.core.command({ type: 'stop', fadeOutFrames: 10 })
    const o = render(s.core, 1024)
    expect(o.L[Math.round(SR * 0.005)]).toBeCloseTo(0.5, 2)
    expect(o.L[Math.round(SR * 0.01) + 1]).toBe(0)
  })
})
