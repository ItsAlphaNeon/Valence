// Pure render core of the worklet engine (no DOM, no worklet globals; unit-tested).
// Voices: `cur` (playing), `nxt` (prefetched), `out` (fading out during a crossfade). Each voice
// is a ~4 s stereo ring plus a pending chunk queue fed by the decode host. Gapless joins are
// sample-accurate: when `cur` drains mid-quantum the rest of the quantum comes from `nxt`.
// A single output envelope implements the seek/load (10 ms) and pause/resume (30 ms) ramps.

import type { PcmEvent, PcmRequest } from '@main/audio/pcm-protocol'

export type CoreCommand =
  | { type: 'load'; streamId: number; path: string; startFrame: number; gain: number; durationFrames: number | null; play: boolean }
  | { type: 'next'; streamId: number; path: string; gain: number; durationFrames: number | null; crossfadeFrames: number }
  | { type: 'clearNext' }
  | { type: 'crossfade'; streamId: number; frames: number }
  | { type: 'seek'; frame: number }
  | { type: 'play' }
  | { type: 'pause' }
  | { type: 'stop' }
  | { type: 'gain'; streamId: number; gain: number }

export type CoreEvent =
  | { type: 'pos'; streamId: number | null; frame: number; playing: boolean; buffering: boolean; outFrames: number; playedFrames: number }
  | { type: 'buffering'; streamId: number; buffering: boolean }
  | { type: 'stall'; streamId: number; frame: number }
  | { type: 'transition'; from: number; to: number; crossfade: boolean }
  | { type: 'ended'; streamId: number }
  | { type: 'paused' }
  | { type: 'playing' }
  | { type: 'format'; streamId: number; durationSec: number | null }
  | { type: 'eof'; streamId: number; endFrame: number }
  | { type: 'error'; streamId: number; message: string }

export interface CoreOptions {
  sampleRate: number
  ringSec?: number
  prebufferSec?: number
  reportSec?: number
  ackFrames?: number
  seekRampSec?: number
  pauseRampSec?: number
}

export interface CoreSinks {
  host(ev: CoreEvent): void
  decoder(msg: PcmRequest): void
}

export class Voice {
  r = 0
  w = 0
  count = 0
  pending: Float32Array[] = []
  pOff = 0
  pendingFrames = 0
  gen = 0
  genStart: number
  pos: number
  eof = false
  endFrame: number | null = null
  waiting = true
  started = false
  g: number
  unacked = 0
  xfFrames = 0
  closed = false

  constructor(
    readonly id: number,
    readonly path: string,
    readonly ring: Float32Array,
    startFrame: number,
    public gain: number,
    public durationFrames: number | null,
  ) {
    this.genStart = this.pos = startFrame
    this.g = gain
  }

  get cap(): number {
    return this.ring.length >> 1
  }
  available(): number {
    return this.count + this.pendingFrames
  }
  drained(): boolean {
    return this.eof && this.available() === 0
  }
  ready(pre: number): boolean {
    return this.eof || this.available() >= pre
  }
  end(): number | null {
    return this.endFrame ?? this.durationFrames
  }

  push(data: Float32Array): void {
    const f = data.length >> 1
    if (!f) return
    this.pending.push(data)
    this.pendingFrames += f
    this.fill()
  }

  fill(): void {
    const cap = this.cap
    while (this.pending.length && this.count < cap) {
      const c = this.pending[0]
      const n = Math.min((c.length - this.pOff) >> 1, cap - this.count)
      let src = this.pOff
      let left = n
      while (left > 0) {
        const run = Math.min(left, cap - this.w)
        this.ring.set(c.subarray(src, src + run * 2), this.w * 2)
        this.w = (this.w + run) % cap
        src += run * 2
        left -= run
      }
      this.count += n
      this.pendingFrames -= n
      this.pOff += n * 2
      if (this.pOff >= c.length - 1) {
        this.pending.shift()
        this.pOff = 0
      }
    }
  }

  /** Reads up to n frames into L/R starting at 0; returns frames read. */
  read(L: Float32Array, R: Float32Array, n: number): number {
    if (this.count < n) this.fill()
    const m = Math.min(n, this.count)
    const ring = this.ring
    const cap = this.cap
    let r = this.r
    for (let k = 0; k < m; k++) {
      L[k] = ring[r * 2]
      R[k] = ring[r * 2 + 1]
      if (++r === cap) r = 0
    }
    this.r = r
    this.count -= m
    this.pos += m
    this.unacked += m
    if (this.pending.length) this.fill()
    return m
  }

  flush(): void {
    this.r = this.w = this.count = 0
    this.pending = []
    this.pOff = this.pendingFrames = 0
    this.eof = false
    this.endFrame = null
    this.unacked = 0
  }
}

const HALF_PI = Math.PI / 2

export class PlayerCore {
  readonly sampleRate: number
  cur: Voice | null = null
  nxt: Voice | null = null
  out: Voice | null = null
  paused = true
  env = 0
  envTarget = 0
  envStep: number
  outFrames = 0
  playedFrames = 0
  private fadeLen = 0
  private fadePos = 0
  private pendingAction: (() => void) | null = null
  private deferred: CoreCommand[] = []
  private pausedSent = true
  private sinceReport = 0
  private readonly ringFrames: number
  private readonly prebuffer: number
  private readonly reportFrames: number
  private readonly ackFrames: number
  private readonly seekStep: number
  private readonly pauseStep: number
  private readonly gk: number
  private pool: Float32Array[] = []
  private aL = new Float32Array(128)
  private aR = new Float32Array(128)
  private bL = new Float32Array(128)
  private bR = new Float32Array(128)

  constructor(
    opts: CoreOptions,
    private sinks: CoreSinks,
  ) {
    const sr = (this.sampleRate = opts.sampleRate)
    this.ringFrames = Math.max(1024, Math.round((opts.ringSec ?? 4) * sr))
    this.prebuffer = Math.min(this.ringFrames, Math.round((opts.prebufferSec ?? 0.15) * sr))
    this.reportFrames = Math.max(1, Math.round((opts.reportSec ?? 0.05) * sr))
    this.ackFrames = opts.ackFrames ?? 4096
    this.seekStep = 1 / Math.max(1, (opts.seekRampSec ?? 0.01) * sr)
    this.pauseStep = 1 / Math.max(1, (opts.pauseRampSec ?? 0.03) * sr)
    this.envStep = this.seekStep
    this.gk = 1 - Math.exp(-1 / (0.01 * sr))
  }

  // ---- commands -------------------------------------------------------------------------

  command(c: CoreCommand): void {
    if (this.pendingAction) {
      this.deferred.push(c)
      return
    }
    switch (c.type) {
      case 'load':
        return this.silenced(() => {
          this.closeAll()
          this.cur = this.voice(c.streamId, c.path, c.startFrame, c.gain, c.durationFrames)
          this.open(this.cur)
          this.paused = !c.play
          this.pausedSent = this.paused
          if (c.play) this.sinks.host({ type: 'playing' })
          this.sinks.host({ type: 'buffering', streamId: c.streamId, buffering: true })
        })
      case 'next': {
        if (this.nxt) this.close(this.nxt)
        const v = (this.nxt = this.voice(c.streamId, c.path, 0, c.gain, c.durationFrames))
        v.xfFrames = Math.max(0, Math.round(c.crossfadeFrames))
        this.open(v)
        return
      }
      case 'clearNext':
        if (this.nxt) this.close(this.nxt)
        this.nxt = null
        return
      case 'crossfade':
        if (this.nxt?.id === c.streamId) this.nxt.xfFrames = Math.max(0, Math.round(c.frames))
        return
      case 'seek':
        if (!this.cur) return
        return this.silenced(() => {
          if (this.out) this.close(this.out)
          this.out = null
          const v = this.cur
          if (!v) return
          v.flush()
          v.gen++
          v.genStart = v.pos = Math.max(0, Math.round(c.frame))
          v.waiting = true
          this.sinks.decoder({ type: 'seek', streamId: v.id, gen: v.gen, startSec: v.pos / this.sampleRate })
          this.sinks.host({ type: 'buffering', streamId: v.id, buffering: true })
          this.report()
        })
      case 'play':
        this.paused = false
        this.pausedSent = false
        this.target(1, this.pauseStep)
        this.sinks.host({ type: 'playing' })
        return
      case 'pause':
        this.paused = true
        this.target(0, this.pauseStep)
        if (this.env <= 0) this.notifyPaused()
        return
      case 'stop':
        return this.silenced(() => {
          this.closeAll()
          this.paused = true
          this.notifyPaused()
          this.report()
        })
      case 'gain':
        for (const v of [this.cur, this.nxt, this.out]) if (v?.id === c.streamId) v.gain = c.gain
        return
    }
  }

  onDecoder(ev: PcmEvent): void {
    const v = [this.cur, this.nxt, this.out].find((x) => x?.id === ev.streamId)
    if (!v || ev.gen !== v.gen) return
    switch (ev.type) {
      case 'pcm':
        v.push(ev.data)
        return
      case 'eof':
        v.eof = true
        v.endFrame = v.genStart + ev.frames
        this.sinks.host({ type: 'eof', streamId: v.id, endFrame: v.endFrame })
        return
      case 'format':
        if (ev.durationSec && ev.durationSec > 0) v.durationFrames = Math.round(ev.durationSec * this.sampleRate)
        this.sinks.host({ type: 'format', streamId: v.id, durationSec: ev.durationSec })
        return
      case 'error':
        v.eof = true
        v.endFrame = v.pos + v.available()
        this.sinks.host({ type: 'error', streamId: v.id, message: ev.message })
        return
    }
  }

  // ---- render ---------------------------------------------------------------------------

  render(L: Float32Array, R: Float32Array, n: number): void {
    L.fill(0, 0, n)
    R.fill(0, 0, n)
    if (this.aL.length < n) {
      this.aL = new Float32Array(n)
      this.aR = new Float32Array(n)
      this.bL = new Float32Array(n)
      this.bR = new Float32Array(n)
    }
    let i = 0
    for (let guard = 0; i < n && guard < 32; guard++) {
      if (!this.cur || this.cur.waiting) this.env = 0
      if (this.pendingAction && this.env <= 0) {
        this.runPending()
        continue
      }
      const v = this.cur
      if (!v) break
      if (this.paused && this.env <= 0 && !this.pendingAction) {
        this.notifyPaused()
        break
      }
      if (v.waiting) {
        if (v.drained()) {
          this.finishCurrent()
          continue
        }
        if (!v.ready(this.prebuffer)) break
        v.waiting = false
        v.started = true
        this.env = 0
        this.target(this.paused ? 0 : 1, this.seekStep)
        this.sinks.host({ type: 'buffering', streamId: v.id, buffering: false })
      }
      this.maybeCrossfade()
      const c = this.cur!
      let m = n - i
      const xfIn = this.crossfadeIn()
      if (xfIn > 0) m = Math.min(m, xfIn)
      if (this.envTarget === 0 && this.env > 0) m = Math.min(m, Math.max(1, Math.ceil(this.env / this.envStep - 1e-9)))
      const got = c.read(this.aL, this.aR, m)
      const o = this.out
      if (o) {
        const og = o.read(this.bL, this.bR, got)
        this.bL.fill(0, og, got)
        this.bR.fill(0, og, got)
      }
      this.mix(L, R, i, got, c, o)
      this.playedFrames += got
      i += got
      this.ack(c)
      if (o) {
        this.ack(o)
        if (this.fadePos >= this.fadeLen) {
          this.close(o)
          this.out = null
        }
      }
      if (got < m) {
        if (c.drained()) {
          this.finishCurrent()
          continue
        }
        c.waiting = true
        this.env = 0
        this.sinks.host({ type: 'stall', streamId: c.id, frame: c.pos })
        this.sinks.host({ type: 'buffering', streamId: c.id, buffering: true })
        break
      }
    }
    this.outFrames += n
    this.sinceReport += n
    if (this.sinceReport >= this.reportFrames) this.report()
  }

  private mix(L: Float32Array, R: Float32Array, at: number, n: number, c: Voice, o: Voice | null): void {
    const { aL, aR, bL, bR, gk } = this
    let env = this.env
    const tgt = this.envTarget
    const step = this.envStep
    let g = c.g
    const gt = c.gain
    if (!o) {
      for (let k = 0; k < n; k++) {
        if (g !== gt) g += Math.abs(gt - g) < 1e-6 ? gt - g : (gt - g) * gk
        if (env !== tgt) env = env < tgt ? Math.min(tgt, env + step) : Math.max(tgt, env - step)
        const s = g * env
        L[at + k] = aL[k] * s
        R[at + k] = aR[k] * s
      }
    } else {
      let og = o.g
      const ogt = o.gain
      const len = this.fadeLen
      let p = this.fadePos
      for (let k = 0; k < n; k++, p++) {
        if (g !== gt) g += Math.abs(gt - g) < 1e-6 ? gt - g : (gt - g) * gk
        if (og !== ogt) og += Math.abs(ogt - og) < 1e-6 ? ogt - og : (ogt - og) * gk
        if (env !== tgt) env = env < tgt ? Math.min(tgt, env + step) : Math.max(tgt, env - step)
        const t = p >= len ? 1 : p / len
        const gin = Math.sin(t * HALF_PI) * g * env
        const gout = Math.cos(t * HALF_PI) * og * env
        L[at + k] = aL[k] * gin + bL[k] * gout
        R[at + k] = aR[k] * gin + bR[k] * gout
      }
      o.g = og
      this.fadePos = p
    }
    c.g = g
    this.env = env
  }

  // ---- internals ------------------------------------------------------------------------

  private target(t: number, step: number): void {
    this.envTarget = t
    this.envStep = step
  }

  /** Runs `act` once the output is silent (10 ms ramp first when audible). */
  private silenced(act: () => void): void {
    if (this.env <= 0 || !this.cur || this.cur.waiting) {
      this.env = 0
      act()
      if (!this.paused) this.target(1, this.seekStep)
      return
    }
    this.pendingAction = act
    this.target(0, this.seekStep)
  }

  private runPending(): void {
    const act = this.pendingAction
    this.pendingAction = null
    act?.()
    this.target(this.paused ? 0 : 1, this.seekStep)
    const q = this.deferred
    this.deferred = []
    for (let k = 0; k < q.length; k++) {
      if (this.pendingAction) {
        this.deferred.push(...q.slice(k))
        break
      }
      this.command(q[k])
    }
  }

  private notifyPaused(): void {
    if (this.pausedSent) return
    this.pausedSent = true
    this.sinks.host({ type: 'paused' })
  }

  private crossfadeIn(): number {
    const c = this.cur
    const nx = this.nxt
    if (!c || !nx || nx.xfFrames <= 0 || this.out) return Infinity
    const end = c.end()
    if (end === null) return Infinity
    return end - nx.xfFrames - c.pos
  }

  private maybeCrossfade(): void {
    const c = this.cur
    const nx = this.nxt
    if (!c || !nx || nx.xfFrames <= 0 || this.out) return
    const end = c.end()
    if (end === null) return
    const remaining = end - c.pos
    if (remaining > nx.xfFrames || !nx.ready(this.prebuffer)) return
    this.out = c
    this.cur = nx
    this.nxt = null
    this.fadeLen = remaining >= 1 ? remaining : nx.xfFrames
    this.fadePos = 0
    nx.waiting = false
    nx.started = true
    this.sinks.host({ type: 'transition', from: c.id, to: nx.id, crossfade: true })
  }

  private finishCurrent(): void {
    const v = this.cur!
    const nx = this.nxt
    this.close(v)
    this.cur = null
    if (!nx) {
      this.sinks.host({ type: 'ended', streamId: v.id })
      this.report()
      return
    }
    this.nxt = null
    this.cur = nx
    this.sinks.host({ type: 'transition', from: v.id, to: nx.id, crossfade: false })
    if (nx.available() > 0 || nx.eof) {
      nx.waiting = false
      nx.started = true
    } else {
      this.env = 0
      this.sinks.host({ type: 'stall', streamId: nx.id, frame: nx.pos })
      this.sinks.host({ type: 'buffering', streamId: nx.id, buffering: true })
    }
  }

  private ack(v: Voice): void {
    if (v.unacked < this.ackFrames) return
    this.sinks.decoder({ type: 'ack', streamId: v.id, gen: v.gen, frames: v.unacked })
    v.unacked = 0
  }

  private voice(id: number, path: string, start: number, gain: number, dur: number | null): Voice {
    const ring = this.pool.pop() ?? new Float32Array(this.ringFrames * 2)
    return new Voice(id, path, ring, Math.max(0, Math.round(start)), gain, dur)
  }

  private open(v: Voice): void {
    this.sinks.decoder({ type: 'open', streamId: v.id, gen: v.gen, path: v.path, startSec: v.pos / this.sampleRate, sampleRate: this.sampleRate })
  }

  private close(v: Voice): void {
    if (v.closed) return
    v.closed = true
    this.sinks.decoder({ type: 'close', streamId: v.id })
    v.flush()
    if (this.pool.length < 4) this.pool.push(v.ring)
  }

  private closeAll(): void {
    for (const v of [this.out, this.cur, this.nxt]) if (v) this.close(v)
    this.out = this.cur = this.nxt = null
  }

  report(): void {
    this.sinceReport = 0
    const c = this.cur
    this.sinks.host({
      type: 'pos',
      streamId: c?.id ?? null,
      frame: c?.pos ?? 0,
      playing: !this.paused,
      buffering: !!c?.waiting,
      outFrames: this.outFrames,
      playedFrames: this.playedFrames,
    })
  }
}
