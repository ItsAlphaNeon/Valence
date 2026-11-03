// Fallback engine: two <audio> elements on valence-media:// URLs, each through a
// MediaElementAudioSourceNode + GainNode into the shared graph. Near-gapless: the next element
// starts ~150 ms before the current one ends with equal-power cross-ramps (or a full crossfade).

import { Emitter, type AudioEngine, type EngineEvents, type LoadOptions, type NextOptions } from './engine'
import { mediaUrl } from './policy'
import type { PlayItem } from './types'

const LEAD_SEC = 0.15
const SEEK_RAMP = 0.01
const PAUSE_RAMP = 0.03

interface Slot {
  el: HTMLAudioElement
  gain: GainNode
  item: PlayItem | null
  rg: number
  ready: boolean
  token: number
  fading: boolean
}

function curve(n: number, fadeIn: boolean, scale: number): Float32Array {
  const c = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1)
    c[i] = (fadeIn ? Math.sin((t * Math.PI) / 2) : Math.cos((t * Math.PI) / 2)) * scale
  }
  return c
}

export class ElementEngine extends Emitter<EngineEvents> implements AudioEngine {
  readonly kind = 'element' as const
  private slots: Slot[] = []
  private cur: Slot | null = null
  private nxt: { item: PlayItem; gain: number; crossfadeSec: number; slot: Slot | null } | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  private wantPlay = false
  private handoff = false
  private lastPosEmit = 0
  private disposers: (() => void)[] = []

  constructor(
    private ctx: AudioContext,
    private dest: AudioNode,
  ) {
    super()
  }

  get loaded(): boolean {
    return !!this.cur
  }

  async init(): Promise<void> {
    for (let i = 0; i < 2; i++) {
      const el = new Audio()
      el.crossOrigin = 'anonymous'
      el.preload = 'auto'
      const src = this.ctx.createMediaElementSource(el)
      const gain = new GainNode(this.ctx, { gain: 0 })
      src.connect(gain).connect(this.dest)
      const slot: Slot = { el, gain, item: null, rg: 1, ready: false, token: 0, fading: false }
      const on = (ev: string, fn: () => void) => {
        el.addEventListener(ev, fn)
        this.disposers.push(() => el.removeEventListener(ev, fn))
      }
      on('canplay', () => (slot.ready = true))
      on('ended', () => this.onEnded(slot))
      on('error', () => this.onError(slot))
      on('waiting', () => slot === this.cur && this.emit('buffering', true))
      on('playing', () => slot === this.cur && this.emit('buffering', false))
      on('durationchange', () => {
        if (slot.item && Number.isFinite(el.duration)) this.emit('duration', { itemId: slot.item.id, durationMs: el.duration * 1000 })
      })
      this.disposers.push(() => {
        src.disconnect()
        gain.disconnect()
      })
      this.slots.push(slot)
    }
    this.timer = setInterval(() => this.tick(), 20)
  }

  private other(s: Slot | null): Slot {
    return this.slots[0] === s ? this.slots[1] : this.slots[0]
  }

  private ramp(s: Slot, to: number, sec: number): void {
    const p = s.gain.gain
    const t = this.ctx.currentTime
    p.cancelScheduledValues(t)
    p.setValueAtTime(p.value, t)
    p.linearRampToValueAtTime(to, t + sec)
  }

  private release(s: Slot): void {
    s.token++
    s.fading = false
    s.gain.gain.cancelScheduledValues(this.ctx.currentTime)
    s.gain.gain.setValueAtTime(0, this.ctx.currentTime)
    s.el.pause()
    s.el.removeAttribute('src')
    s.el.load()
    s.item = null
    s.ready = false
  }

  private releaseLater(s: Slot, ms: number): void {
    const tok = ++s.token
    s.fading = true
    setTimeout(() => s.token === tok && this.release(s), ms)
  }

  private assign(s: Slot, item: PlayItem, gain: number, startMs = 0): void {
    s.token++
    s.fading = false
    s.item = item
    s.rg = gain
    s.ready = false
    s.el.src = mediaUrl(item.path)
    s.el.currentTime = startMs / 1000
  }

  load(item: PlayItem, o: LoadOptions = {}): void {
    const old = this.cur
    const s = this.other(old)
    if (old) {
      this.ramp(old, 0, SEEK_RAMP)
      this.releaseLater(old, SEEK_RAMP * 1000 + 20)
    }
    if (this.nxt?.slot && this.nxt.slot !== s) this.release(this.nxt.slot)
    this.nxt = null
    this.handoff = false
    this.assign(s, item, o.gain ?? 1, o.startMs ?? 0)
    this.cur = s
    this.wantPlay = o.autoplay ?? true
    s.gain.gain.setValueAtTime(0, this.ctx.currentTime)
    if (this.wantPlay) this.startSlot(s, SEEK_RAMP)
  }

  private startSlot(s: Slot, rampSec: number): void {
    if (this.ctx.state !== 'running') void this.ctx.resume().catch(() => {})
    void s.el.play().then(
      () => s === this.cur && this.wantPlay && this.ramp(s, s.rg, rampSec),
      (e: unknown) => s === this.cur && this.wantPlay && this.emit('error', { item: s.item, message: String(e) }),
    )
  }

  setNext(item: PlayItem | null, o: NextOptions = {}): void {
    const gain = o.gain ?? 1
    const crossfadeSec = Math.max(0, o.crossfadeSec ?? 0)
    if (item && this.nxt?.item.id === item.id) {
      this.nxt.gain = gain
      this.nxt.crossfadeSec = crossfadeSec
      if (this.nxt.slot) this.nxt.slot.rg = gain
      return
    }
    if (this.nxt?.slot && !this.handoff) this.release(this.nxt.slot)
    this.nxt = item ? { item, gain, crossfadeSec, slot: null } : null
  }

  private durationSec(s: Slot): number {
    const d = s.el.duration
    return Number.isFinite(d) && d > 0 ? d : (s.item?.durationMs ?? 0) / 1000
  }

  private tick(): void {
    const c = this.cur
    if (!c?.item) return
    const now = performance.now()
    if (now - this.lastPosEmit >= 50) {
      this.lastPosEmit = now
      this.emit('position', { itemId: c.item.id, positionMs: c.el.currentTime * 1000 })
    }
    const n = this.nxt
    const dur = this.durationSec(c)
    if (!n || !dur) return
    const remaining = dur - c.el.currentTime
    if (!n.slot && remaining < Math.max(30, n.crossfadeSec + 10) && !this.other(c).fading) {
      n.slot = this.other(c)
      this.assign(n.slot, n.item, n.gain)
    }
    const overlap = Math.max(LEAD_SEC, n.crossfadeSec)
    if (n.slot && n.slot.ready && !this.handoff && this.wantPlay && !c.el.paused && remaining <= overlap) this.crossTo(c, n.slot, Math.max(0.02, remaining), n.crossfadeSec > 0)
  }

  private crossTo(c: Slot, s: Slot, sec: number, crossfade: boolean): void {
    this.handoff = true
    const t = this.ctx.currentTime
    const steps = Math.max(8, Math.round(sec * 200))
    c.gain.gain.cancelScheduledValues(t)
    c.gain.gain.setValueCurveAtTime(curve(steps, false, c.rg), t, sec)
    s.gain.gain.cancelScheduledValues(t)
    s.gain.gain.setValueCurveAtTime(curve(steps, true, s.rg), t, sec)
    void s.el.play().catch(() => {})
    this.cur = s
    this.nxt = null
    this.handoff = false
    this.releaseLater(c, sec * 1000 + 100)
    this.emit('transition', { item: s.item!, crossfade })
  }

  private onEnded(s: Slot): void {
    if (s !== this.cur) return
    const n = this.nxt
    if (n && this.wantPlay) {
      if (!n.slot) {
        n.slot = this.other(s)
        this.assign(n.slot, n.item, n.gain)
      }
      const ns = n.slot
      this.cur = ns
      this.nxt = null
      this.release(s)
      ns.gain.gain.setValueAtTime(0, this.ctx.currentTime)
      this.startSlot(ns, SEEK_RAMP)
      this.emit('transition', { item: ns.item!, crossfade: false })
      return
    }
    const item = s.item
    this.cur = null
    this.release(s)
    this.emit('ended', { item })
  }

  private onError(s: Slot): void {
    if (!s.item || !s.el.getAttribute('src')) return
    const item = s.item
    const message = s.el.error?.message || `media error ${s.el.error?.code ?? ''}`.trim()
    this.emit('error', { item, message })
    if (s === this.cur) {
      this.cur = null
      this.release(s)
      this.emit('ended', { item })
    } else if (this.nxt?.slot === s) {
      this.release(s)
      this.nxt.slot = null
    }
  }

  play(): void {
    const c = this.cur
    if (!c) return
    this.wantPlay = true
    this.startSlot(c, PAUSE_RAMP)
  }

  pause(): void {
    const c = this.cur
    this.wantPlay = false
    if (!c) return
    this.ramp(c, 0, PAUSE_RAMP)
    setTimeout(() => !this.wantPlay && c.el.pause(), PAUSE_RAMP * 1000 + 15)
    if (this.nxt?.slot && this.nxt.slot !== c) this.nxt.slot.el.pause()
  }

  stop(): void {
    this.wantPlay = false
    for (const s of this.slots) this.release(s)
    this.cur = null
    this.nxt = null
  }

  seek(ms: number): void {
    const c = this.cur
    if (!c) return
    this.ramp(c, 0, SEEK_RAMP)
    setTimeout(() => {
      if (c !== this.cur) return
      c.el.currentTime = Math.max(0, ms) / 1000
      const up = () => this.wantPlay && c === this.cur && this.ramp(c, c.rg, SEEK_RAMP)
      c.el.addEventListener('seeked', up, { once: true })
    }, SEEK_RAMP * 1000 + 5)
  }

  setGain(itemId: string, gain: number): void {
    for (const s of this.slots) {
      if (s.item?.id !== itemId) continue
      s.rg = gain
      if (s === this.cur && this.wantPlay) this.ramp(s, gain, SEEK_RAMP)
    }
    if (this.nxt?.item.id === itemId) this.nxt.gain = gain
  }

  positionMs(): number {
    return (this.cur?.el.currentTime ?? 0) * 1000
  }

  framesRendered(): number {
    return Math.round((this.cur?.el.currentTime ?? 0) * this.ctx.sampleRate)
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer)
    for (const s of this.slots) this.release(s)
    for (const d of this.disposers) d()
    this.slots = []
    this.clearListeners()
  }
}
