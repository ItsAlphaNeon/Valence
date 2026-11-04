// Primary engine: ffmpeg in main -> `pcm` MessagePort -> AudioWorklet (PlayerCore). Sample-accurate
// gapless, equal-power crossfade, prefetch of the next item when < 30 s remain (or at decoder EOF).

import processorUrl from './worklet/processor.ts?worker&url'
import { Emitter, requestPort, type AudioEngine, type EngineEvents, type LoadOptions, type NextOptions } from './engine'
import type { CoreCommand, CoreEvent } from './worklet/player-core'
import type { PlayItem } from './types'

const modules = new WeakMap<BaseAudioContext, Promise<void>>()

/** Loads the worklet module (player + tap processors) once per context. */
export function loadWorkletModule(ctx: BaseAudioContext): Promise<void> {
  let p = modules.get(ctx)
  if (!p) {
    p = ctx.audioWorklet.addModule(processorUrl)
    modules.set(ctx, p)
    p.catch(() => modules.delete(ctx))
  }
  return p
}

interface Stream {
  id: number
  item: PlayItem
  durationMs: number | null
}

export interface WorkletEngineOptions {
  port?: () => Promise<MessagePort>
  prefetchSec?: number
}

export class WorkletEngine extends Emitter<EngineEvents> implements AudioEngine {
  readonly kind = 'worklet' as const
  private node: AudioWorkletNode | null = null
  private ids = 0
  private streams = new Map<number, Stream>()
  private cur: Stream | null = null
  private nxt: { item: PlayItem; gain: number; crossfadeSec: number; stream: Stream | null } | null = null
  private pos = 0
  private played = 0
  private curEof = false
  private wantPlay = false
  private pauseRampMs = 30

  constructor(
    private ctx: AudioContext,
    private dest: AudioNode,
    private opts: WorkletEngineOptions = {},
  ) {
    super()
  }

  get loaded(): boolean {
    return !!this.cur
  }

  async init(): Promise<void> {
    await loadWorkletModule(this.ctx)
    const node = new AudioWorkletNode(this.ctx, 'valence-player', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] })
    node.port.onmessage = (e) => this.onCore(e.data as CoreEvent)
    const port = await (this.opts.port ?? (() => requestPort('pcm')))()
    node.port.postMessage({ type: 'attach', port }, [port])
    node.connect(this.dest)
    this.node = node
    this.setPauseRamp(this.pauseRampMs)
  }

  private post(c: CoreCommand): void {
    this.node?.port.postMessage(c)
  }

  private frames(ms: number): number {
    return Math.round((ms / 1000) * this.ctx.sampleRate)
  }

  private stream(item: PlayItem): Stream {
    return { id: ++this.ids, item, durationMs: item.durationMs > 0 ? item.durationMs : null }
  }

  private resumeCtx(): void {
    if (this.ctx.state !== 'running') void this.ctx.resume().catch(() => {})
  }

  load(item: PlayItem, o: LoadOptions = {}): void {
    const s = this.stream(item)
    this.streams.clear()
    this.streams.set(s.id, s)
    this.cur = s
    this.nxt = null
    this.curEof = false
    this.pos = Math.max(0, o.startMs ?? 0)
    const play = o.autoplay ?? true
    this.wantPlay = play
    if (play) this.resumeCtx()
    this.post({
      type: 'load',
      streamId: s.id,
      path: item.path,
      startFrame: this.frames(this.pos),
      gain: o.gain ?? 1,
      durationFrames: s.durationMs ? this.frames(s.durationMs) : null,
      play,
      fadeOutFrames: this.frames(Math.max(0, o.fadeOutMs ?? 0)),
    })
  }

  setNext(item: PlayItem | null, o: NextOptions = {}): void {
    const gain = o.gain ?? 1
    const crossfadeSec = Math.max(0, o.crossfadeSec ?? 0)
    const n = this.nxt
    if (item && n && n.item.id === item.id) {
      n.gain = gain
      n.crossfadeSec = crossfadeSec
      if (n.stream) {
        this.post({ type: 'crossfade', streamId: n.stream.id, frames: this.frames(crossfadeSec * 1000) })
        this.post({ type: 'gain', streamId: n.stream.id, gain })
      }
      return
    }
    if (n?.stream) {
      this.post({ type: 'clearNext' })
      this.streams.delete(n.stream.id)
    }
    this.nxt = item ? { item, gain, crossfadeSec, stream: null } : null
    this.maybePrefetch()
  }

  private maybePrefetch(): void {
    const n = this.nxt
    const c = this.cur
    if (!n || n.stream || !c) return
    const window = Math.max(this.opts.prefetchSec ?? 30, n.crossfadeSec + 10) * 1000
    const remaining = c.durationMs ? c.durationMs - this.pos : Infinity
    if (!this.curEof && remaining >= window) return
    const s = this.stream(n.item)
    this.streams.set(s.id, s)
    n.stream = s
    this.post({
      type: 'next',
      streamId: s.id,
      path: n.item.path,
      gain: n.gain,
      durationFrames: s.durationMs ? this.frames(s.durationMs) : null,
      crossfadeFrames: this.frames(n.crossfadeSec * 1000),
    })
  }

  private onCore(ev: CoreEvent): void {
    const sr = this.ctx.sampleRate
    switch (ev.type) {
      case 'pos':
        this.played = ev.playedFrames
        if (this.cur && ev.streamId === this.cur.id) {
          this.pos = (ev.frame / sr) * 1000
          this.emit('position', { itemId: this.cur.item.id, positionMs: this.pos })
          this.maybePrefetch()
        }
        return
      case 'transition': {
        const s = this.streams.get(ev.to)
        if (!s) return
        this.streams.delete(ev.from)
        this.cur = s
        this.curEof = false
        this.pos = 0
        if (this.nxt?.stream?.id === ev.to) this.nxt = null
        this.emit('transition', { item: s.item, crossfade: ev.crossfade })
        return
      }
      case 'ended':
        if (this.cur?.id === ev.streamId) {
          const item = this.cur.item
          this.cur = null
          this.emit('ended', { item })
        }
        return
      case 'eof': {
        const s = this.streams.get(ev.streamId)
        if (!s) return
        s.durationMs = (ev.endFrame / sr) * 1000
        this.emit('duration', { itemId: s.item.id, durationMs: s.durationMs })
        if (s === this.cur) {
          this.curEof = true
          this.maybePrefetch()
        }
        return
      }
      case 'format': {
        const s = this.streams.get(ev.streamId)
        if (!s || !ev.durationSec) return
        s.durationMs = ev.durationSec * 1000
        this.emit('duration', { itemId: s.item.id, durationMs: s.durationMs })
        return
      }
      case 'error': {
        const s = this.streams.get(ev.streamId)
        this.emit('error', { item: s?.item ?? null, message: ev.message })
        return
      }
      case 'buffering':
        if (this.cur?.id === ev.streamId) this.emit('buffering', ev.buffering)
        return
      case 'paused':
        if (!this.wantPlay && this.ctx.state === 'running') void this.ctx.suspend().catch(() => {})
        return
    }
  }

  play(): void {
    if (!this.cur) return
    this.wantPlay = true
    this.resumeCtx()
    this.post({ type: 'play' })
  }

  pause(): void {
    this.wantPlay = false
    this.post({ type: 'pause' })
  }

  stop(fadeOutMs = 0): void {
    this.wantPlay = false
    this.post({ type: 'stop', fadeOutFrames: this.frames(Math.max(0, fadeOutMs)) })
    this.cur = null
    this.nxt = null
    this.streams.clear()
    this.pos = 0
  }

  seek(ms: number): void {
    if (!this.cur) return
    this.pos = Math.max(0, ms)
    this.curEof = false
    this.post({ type: 'seek', frame: this.frames(this.pos) })
  }

  setPauseRamp(ms: number): void {
    this.pauseRampMs = Math.max(1, ms)
    this.post({ type: 'ramps', pauseFrames: this.frames(this.pauseRampMs) })
  }

  setGain(itemId: string, gain: number): void {
    for (const s of this.streams.values()) if (s.item.id === itemId) this.post({ type: 'gain', streamId: s.id, gain })
    if (this.nxt?.item.id === itemId) this.nxt.gain = gain
  }

  positionMs(): number {
    return this.pos
  }

  framesRendered(): number {
    return this.played
  }

  dispose(): void {
    const node = this.node
    this.node = null
    if (node) {
      node.port.postMessage({ type: 'dispose' })
      node.disconnect()
      node.port.onmessage = null
    }
    this.clearListeners()
  }
}
