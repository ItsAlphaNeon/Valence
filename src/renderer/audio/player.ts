// UI-agnostic Player: owns the queue, engine, Web Audio graph, output stage and media session.
//   const player = await Player.create({ onPlayLogged, onSkip })
//   player.on('state', render); player.command({ type: 'setQueue', items, startIndex: 3 })

import { ElementEngine } from './element-engine'
import { Emitter, type AudioEngine } from './engine'
import { AudioGraph, defaultEq, EQ_PRESETS, normalizeEq } from './graph'
import { DEFAULT_OUTPUT_STRATEGY, MediaSessionBridge, OutputStage, type OutputStrategy } from './media-session'
import { clamp, crossfadeSecFor, rgGain } from './policy'
import { PlayQueue } from './queue'
import type {
  EngineKind,
  EqState,
  OutputDevice,
  PlayerCommand,
  PlayerState,
  PlayItem,
  PlayLoggedEvent,
  QueueSnapshot,
  QueueSource,
  RepeatMode,
  RgMode,
  SkipEvent,
} from './types'
import { WorkletEngine } from './worklet-engine'

export interface PlayerEvents extends Record<string, unknown> {
  /** Full serializable state; position-only changes are throttled to ~4 Hz. */
  state: PlayerState
  /** Every engine position report (~20 Hz), for smooth seek bars. */
  position: { positionMs: number; durationMs: number }
  track: PlayItem | null
  played: PlayLoggedEvent
  skipped: SkipEvent
  ended: null
  error: { item: PlayItem | null; message: string }
}

export interface PlayerOptions {
  /** Force master gain 0 (VALENCE_MUTE). Default: hash `?mute=1` or invoke('audio:env'). */
  mute?: boolean
  engine?: EngineKind
  outputStrategy?: OutputStrategy
  /** Settings persistence; default localStorage, null disables. */
  storage?: Storage | null
  mediaSession?: boolean
  onPlayLogged?(e: PlayLoggedEvent): void
  onSkip?(e: SkipEvent): void
  rng?: () => number
  latencyHint?: AudioContextLatencyCategory | number
}

interface Settings {
  volume: number
  muted: boolean
  eq: EqState
  rgMode: RgMode
  preampDb: number
  crossfadeSec: number
  engine: EngineKind
  shuffle: boolean
  repeat: RepeatMode
  outputDeviceId: string
}

const KEY = 'valence.player.'
const DEFAULTS: Settings = {
  volume: 0.8,
  muted: false,
  eq: defaultEq(),
  rgMode: 'auto',
  preampDb: 0,
  crossfadeSec: 0,
  engine: 'worklet',
  shuffle: false,
  repeat: 'off',
  outputDeviceId: 'default',
}

interface Listen {
  item: PlayItem
  startedAt: number
  playedMs: number
  lastPos: number
}

export async function detectMute(): Promise<boolean> {
  const q = new URLSearchParams(location.hash.split('?')[1] ?? '')
  if (q.get('mute') === '1') return true
  try {
    const env = (await window.valence?.invoke('audio:env')) as { mute?: boolean } | undefined
    return !!env?.mute
  } catch {
    return false
  }
}

function defaultStorage(): Storage | null {
  try {
    return globalThis.localStorage ?? null
  } catch {
    return null
  }
}

export class Player extends Emitter<PlayerEvents> {
  static async create(opts: PlayerOptions = {}): Promise<Player> {
    const mute = opts.mute ?? (await detectMute())
    const p = new Player({ ...opts, mute })
    await p.init()
    return p
  }

  readonly ctx: AudioContext
  readonly graph: AudioGraph
  readonly queue: PlayQueue
  readonly muteForced: boolean
  private engine!: AudioEngine
  private output!: OutputStage
  private session: MediaSessionBridge | null = null
  private storage: Storage | null
  private st: Settings
  private playing = false
  private buffering = false
  private pos = 0
  private dur = 0
  private error: string | null = null
  private listen: Listen | null = null
  private errors = 0
  private snap: { v: number; s: QueueSnapshot } = { v: -1, s: null as unknown as QueueSnapshot }
  private flushQueued = false
  private stateTimer: ReturnType<typeof setTimeout> | null = null
  private lastStateAt = 0
  private switching = false
  private onPageHide = () => this.endListen('stopped')

  private constructor(private opts: PlayerOptions) {
    super()
    this.muteForced = !!opts.mute
    this.storage = opts.storage === undefined ? defaultStorage() : opts.storage
    this.st = this.loadSettings()
    if (opts.engine) this.st.engine = opts.engine
    this.queue = new PlayQueue(opts.rng)
    this.queue.setShuffle(this.st.shuffle)
    this.queue.setRepeat(this.st.repeat)
    this.ctx = new AudioContext({ latencyHint: opts.latencyHint ?? 'playback' })
    this.graph = new AudioGraph(this.ctx, this.muteForced)
  }

  private async init(): Promise<void> {
    this.graph.setPreamp(this.st.preampDb)
    this.graph.setEq(this.st.eq)
    this.graph.setVolume(this.st.volume, this.st.muted)
    this.output = new OutputStage(this.ctx, this.graph.output, this.opts.outputStrategy ?? DEFAULT_OUTPUT_STRATEGY)
    this.engine = await this.makeEngine(this.st.engine)
    if (this.st.outputDeviceId && this.st.outputDeviceId !== 'default') {
      await this.output.setSinkId(this.st.outputDeviceId).catch(() => (this.st.outputDeviceId = 'default'))
    }
    if (this.opts.mediaSession !== false) {
      this.session = new MediaSessionBridge({
        play: () => this.command({ type: 'play' }),
        pause: () => this.command({ type: 'pause' }),
        stop: () => this.command({ type: 'stop' }),
        prev: () => this.command({ type: 'prev' }),
        next: () => this.command({ type: 'next' }),
        seekTo: (ms) => this.command({ type: 'seek', positionMs: ms }),
        seekBy: (ms) => this.command({ type: 'seekBy', deltaMs: ms }),
      })
    }
    addEventListener('pagehide', this.onPageHide)
    this.scheduleState()
  }

  // ---- settings ---------------------------------------------------------------------------

  private loadSettings(): Settings {
    const s: Settings = { ...DEFAULTS, eq: defaultEq() }
    const get = <K extends keyof Settings>(k: K): Settings[K] | undefined => {
      try {
        const raw = this.storage?.getItem(KEY + k)
        return raw == null ? undefined : (JSON.parse(raw) as Settings[K])
      } catch {
        return undefined
      }
    }
    const num = (v: unknown, lo: number, hi: number, d: number) => (typeof v === 'number' && Number.isFinite(v) ? clamp(v, lo, hi) : d)
    s.volume = num(get('volume'), 0, 1, s.volume)
    s.muted = get('muted') === true
    s.eq = normalizeEq(get('eq'))
    const rg = get('rgMode')
    if (rg === 'off' || rg === 'track' || rg === 'album' || rg === 'auto') s.rgMode = rg
    s.preampDb = num(get('preampDb'), -12, 12, 0)
    s.crossfadeSec = num(get('crossfadeSec'), 0, 12, 0)
    const eng = get('engine')
    if (eng === 'worklet' || eng === 'element') s.engine = eng
    s.shuffle = get('shuffle') === true
    const rp = get('repeat')
    if (rp === 'off' || rp === 'all' || rp === 'one') s.repeat = rp
    const dev = get('outputDeviceId')
    if (typeof dev === 'string') s.outputDeviceId = dev
    return s
  }

  private save<K extends keyof Settings>(k: K, v: Settings[K]): void {
    this.st[k] = v
    try {
      this.storage?.setItem(KEY + k, JSON.stringify(v))
    } catch {
      /* storage unavailable */
    }
  }

  // ---- engine -----------------------------------------------------------------------------

  private async makeEngine(kind: EngineKind): Promise<AudioEngine> {
    if (kind === 'worklet') {
      const w = new WorkletEngine(this.ctx, this.graph.input)
      try {
        await w.init()
        return this.bind(w)
      } catch (e) {
        console.warn('[valence] worklet engine unavailable, using <audio> fallback', e)
        w.dispose()
      }
    }
    const el = new ElementEngine(this.ctx, this.graph.input)
    await el.init()
    return this.bind(el)
  }

  private bind(e: AudioEngine): AudioEngine {
    e.on('position', ({ itemId, positionMs }) => {
      if (e !== this.engine || itemId !== this.queue.current?.id) return
      this.trackPlayed(positionMs)
      this.pos = positionMs
      if (positionMs > 500) this.errors = 0
      this.emit('position', { positionMs, durationMs: this.dur })
      this.scheduleState(false)
    })
    e.on('transition', ({ item }) => e === this.engine && this.onTransition(item))
    e.on('ended', () => e === this.engine && this.onEnded())
    e.on('buffering', (b) => {
      if (e !== this.engine) return
      this.buffering = b
      this.scheduleState()
    })
    e.on('duration', ({ itemId, durationMs }) => {
      if (e !== this.engine || itemId !== this.queue.current?.id) return
      this.dur = durationMs
      this.scheduleState()
    })
    e.on('error', ({ item, message }) => {
      if (e !== this.engine) return
      this.errors++
      this.error = item ? `${item.title}: ${message}` : message
      this.emit('error', { item, message })
      this.scheduleState()
    })
    return e
  }

  private rg(item: PlayItem | null): number {
    if (!item) return 1
    const q = this.queue
    const albumCtx = q.source?.kind === 'album' || (!!item.albumKey && !q.shuffle && (q.peekNext()?.albumKey === item.albumKey || q.history.at(-1)?.albumKey === item.albumKey))
    return rgGain(item, this.st.rgMode, albumCtx)
  }

  private updateNext(): void {
    const cur = this.queue.current
    const n = cur ? this.queue.peekNext() : null
    this.engine.setNext(n, { gain: this.rg(n), crossfadeSec: crossfadeSecFor(cur, n, this.st.crossfadeSec) })
  }

  private startCurrent(startMs: number, autoplay: boolean): void {
    const item = this.queue.current
    if (!item) {
      this.engine.stop()
      this.playing = false
      this.pos = this.dur = 0
      this.output.setActive(false)
      this.emit('track', null)
      this.scheduleState()
      return
    }
    this.error = null
    this.engine.load(item, { startMs, autoplay, gain: this.rg(item) })
    this.playing = autoplay
    this.pos = startMs
    this.dur = item.durationMs
    this.buffering = true
    this.output.setActive(autoplay)
    this.beginListen(item, startMs)
    this.updateNext()
    this.emit('track', item)
    this.scheduleState()
  }

  private onTransition(item: PlayItem | null): void {
    this.endListen('completed')
    const n = this.queue.next(true)
    if (!n || !item || n.id !== item.id) {
      if (n) this.startCurrent(0, this.playing)
      else this.stopAtEnd()
      return
    }
    this.pos = 0
    this.dur = item.durationMs
    this.error = null
    this.beginListen(item, 0)
    this.updateNext()
    this.emit('track', item)
    this.scheduleState()
  }

  private onEnded(): void {
    this.endListen('completed')
    if (this.errors > Math.min(5, Math.max(1, this.queue.contextItems.length + this.queue.upNext.length))) return this.stopAtEnd()
    const n = this.queue.next(true)
    if (n) this.startCurrent(0, true)
    else this.stopAtEnd()
  }

  private stopAtEnd(): void {
    this.engine.stop()
    this.playing = false
    this.buffering = false
    this.pos = 0
    this.output.setActive(false)
    this.emit('ended', null)
    this.scheduleState()
  }

  // ---- play logging -------------------------------------------------------------------------

  private beginListen(item: PlayItem, startMs: number): void {
    this.listen = { item, startedAt: Date.now(), playedMs: 0, lastPos: startMs }
  }

  private trackPlayed(pos: number): void {
    const l = this.listen
    if (!l) return
    const d = pos - l.lastPos
    if (this.playing && d > 0 && d < 1500) l.playedMs += d
    l.lastPos = pos
  }

  private endListen(reason: 'completed' | 'skipped' | 'stopped'): void {
    const l = this.listen
    this.listen = null
    if (!l) return
    const dur = l.item.durationMs > 0 ? l.item.durationMs : this.dur
    const threshold = dur > 0 ? Math.min(dur * 0.5, 240_000) : 240_000
    const playedMs = Math.round(l.playedMs)
    if (playedMs >= threshold) {
      const e: PlayLoggedEvent = { item: l.item, playedMs, completed: reason === 'completed', startedAt: l.startedAt }
      this.opts.onPlayLogged?.(e)
      this.emit('played', e)
    } else if (reason === 'skipped' && playedMs < 30_000) {
      const e: SkipEvent = { item: l.item, playedMs, startedAt: l.startedAt }
      this.opts.onSkip?.(e)
      this.emit('skipped', e)
    }
  }

  // ---- commands -----------------------------------------------------------------------------

  command(c: PlayerCommand): void {
    if (!c || typeof c !== 'object') return
    switch (c.type) {
      case 'play':
        return this.play()
      case 'pause':
        return this.pause()
      case 'toggle':
        return this.playing ? this.pause() : this.play()
      case 'stop':
        this.endListen('stopped')
        this.engine.stop()
        this.playing = false
        this.pos = 0
        this.output.setActive(false)
        return this.scheduleState()
      case 'next':
        return this.next()
      case 'prev':
        return this.prev()
      case 'seek':
        return this.seek(c.positionMs)
      case 'seekBy':
        return this.seek(this.pos + c.deltaMs)
      case 'setVolume':
        this.save('volume', clamp(Number(c.volume) || 0, 0, 1))
        this.graph.setVolume(this.st.volume, this.st.muted)
        return this.scheduleState()
      case 'setMuted':
        this.save('muted', !!c.muted)
        this.graph.setVolume(this.st.volume, this.st.muted)
        return this.scheduleState()
      case 'setQueue':
        return this.setQueue(c.items, c.startIndex ?? 0, c.source, c.startMs, c.autoplay)
      case 'playNext':
      case 'addToQueue': {
        const had = !!this.queue.current
        if (c.type === 'playNext') this.queue.playNext(c.items)
        else this.queue.addToQueue(c.items)
        if (!had) this.startCurrent(0, true)
        else this.updateNext()
        return this.scheduleState()
      }
      case 'removeUpNext':
        this.queue.removeUpNext(c.index)
        this.updateNext()
        return this.scheduleState()
      case 'moveUpNext':
        this.queue.moveUpNext(c.from, c.to)
        this.updateNext()
        return this.scheduleState()
      case 'clearUpNext':
        this.queue.clearUpNext()
        this.updateNext()
        return this.scheduleState()
      case 'playUpNextAt':
        if (c.index < 0 || c.index >= this.queue.upNext.length) return
        this.endListen('skipped')
        this.queue.playUpNextAt(c.index)
        return this.startCurrent(0, true)
      case 'jumpTo':
        if (c.position < 0 || c.position >= this.queue.contextItems.length) return
        this.endListen('skipped')
        this.queue.jumpTo(c.position)
        return this.startCurrent(0, true)
      case 'setShuffle':
        this.queue.setShuffle(!!c.shuffle)
        this.save('shuffle', this.queue.shuffle)
        this.updateNext()
        return this.scheduleState()
      case 'setRepeat':
      case 'cycleRepeat': {
        const order: RepeatMode[] = ['off', 'all', 'one']
        const mode = c.type === 'setRepeat' ? c.repeat : order[(order.indexOf(this.queue.repeat) + 1) % 3]
        if (!order.includes(mode)) return
        this.queue.setRepeat(mode)
        this.save('repeat', mode)
        this.updateNext()
        return this.scheduleState()
      }
      case 'setCrossfade':
        this.save('crossfadeSec', clamp(Number(c.sec) || 0, 0, 12))
        this.updateNext()
        return this.scheduleState()
      case 'setRgMode':
        if (!['off', 'track', 'album', 'auto'].includes(c.mode)) return
        this.save('rgMode', c.mode)
        return this.refreshGains()
      case 'setPreamp':
        this.save('preampDb', clamp(Number(c.db) || 0, -12, 12))
        this.graph.setPreamp(this.st.preampDb)
        return this.scheduleState()
      case 'setEq':
        return this.applyEq(normalizeEq({ ...this.st.eq, ...c.eq }, this.st.eq))
      case 'setEqPreset': {
        const gains = c.preset === 'Custom' ? this.st.eq.gains : EQ_PRESETS[c.preset]
        if (!gains) return
        return this.applyEq({ enabled: true, preset: c.preset, gains: [...gains] })
      }
      case 'setEqBand': {
        if (c.index < 0 || c.index > 9) return
        const gains = [...this.st.eq.gains]
        gains[c.index] = clamp(Number(c.gainDb) || 0, -12, 12)
        return this.applyEq({ ...this.st.eq, preset: 'Custom', gains })
      }
      case 'setOutputDevice':
        return void this.setOutputDevice(c.deviceId)
      case 'setEngine':
        return void this.setEngine(c.engine)
    }
  }

  play(): void {
    if (!this.queue.current) return
    if (!this.engine.loaded) {
      this.startCurrent(this.dur > 0 && this.pos >= this.dur - 500 ? 0 : this.pos, true)
      return
    }
    this.playing = true
    this.engine.play()
    this.output.setActive(true)
    this.scheduleState()
  }

  pause(): void {
    this.playing = false
    this.engine.pause()
    this.output.setActive(false)
    this.scheduleState()
  }

  next(): void {
    const n = this.queue.next(false)
    if (!n) {
      this.endListen('skipped')
      return this.stopAtEnd()
    }
    this.endListen('skipped')
    this.startCurrent(0, this.playing || !this.engine.loaded)
  }

  prev(): void {
    const { item, restart } = this.queue.prev(this.pos)
    if (!item) return
    if (restart) {
      if (this.engine.loaded) this.seek(0)
      else this.startCurrent(0, this.playing)
      return
    }
    this.endListen('skipped')
    this.startCurrent(0, this.playing || !this.engine.loaded)
  }

  seek(ms: number): void {
    if (!this.queue.current || !Number.isFinite(ms)) return
    const t = clamp(ms, 0, this.dur > 0 ? Math.max(0, this.dur - 50) : ms)
    if (!this.engine.loaded) {
      this.startCurrent(t, false)
      return
    }
    this.engine.seek(t)
    this.pos = t
    if (this.listen) this.listen.lastPos = t
    this.scheduleState()
  }

  setQueue(items: PlayItem[], startIndex = 0, source?: QueueSource, startMs = 0, autoplay = true): void {
    this.endListen(this.playing ? 'skipped' : 'stopped')
    this.queue.setContext(items, startIndex, source ?? null)
    this.startCurrent(startMs, autoplay)
  }

  private refreshGains(): void {
    const cur = this.queue.current
    if (cur) this.engine.setGain(cur.id, this.rg(cur))
    this.updateNext()
    this.scheduleState()
  }

  private applyEq(eq: EqState): void {
    this.save('eq', eq)
    this.graph.setEq(eq)
    this.scheduleState()
  }

  async setOutputDevice(deviceId: string): Promise<void> {
    const id = deviceId || 'default'
    try {
      await this.output.setSinkId(id)
      this.save('outputDeviceId', id)
      this.error = null
    } catch (e) {
      this.error = `Output device: ${(e as Error).message}`
    }
    this.scheduleState()
  }

  async setEngine(kind: EngineKind): Promise<void> {
    if (this.switching || kind === this.engine.kind) return
    this.switching = true
    try {
      const wasPlaying = this.playing
      const pos = this.pos
      const loaded = this.engine.loaded
      const old = this.engine
      old.dispose()
      this.engine = await this.makeEngine(kind)
      this.save('engine', this.engine.kind)
      const cur = this.queue.current
      if (loaded && cur) {
        this.engine.load(cur, { startMs: pos, autoplay: wasPlaying, gain: this.rg(cur) })
        this.updateNext()
      }
    } finally {
      this.switching = false
      this.scheduleState()
    }
  }

  async listOutputDevices(): Promise<OutputDevice[]> {
    const ds = await navigator.mediaDevices.enumerateDevices()
    return ds
      .filter((d) => d.kind === 'audiooutput')
      .map((d) => ({ deviceId: d.deviceId, label: d.label || (d.deviceId === 'default' ? 'System default' : 'Output device') }))
  }

  // ---- state --------------------------------------------------------------------------------

  get engineKind(): EngineKind {
    return this.engine.kind
  }

  get outputStrategy(): OutputStrategy {
    return this.output.strategy
  }

  framesRendered(): number {
    return this.engine.framesRendered()
  }

  getState(): PlayerState {
    const q = this.queue
    if (this.snap.v !== q.version) this.snap = { v: q.version, s: q.snapshot() }
    return {
      current: q.current,
      positionMs: Math.round(this.pos),
      durationMs: Math.round(this.dur),
      playing: this.playing,
      buffering: this.buffering,
      volume: this.st.volume,
      muted: this.st.muted,
      shuffle: q.shuffle,
      repeat: q.repeat,
      queue: this.snap.s,
      crossfadeSec: this.st.crossfadeSec,
      rgMode: this.st.rgMode,
      preampDb: this.st.preampDb,
      eq: { ...this.st.eq, gains: [...this.st.eq.gains] },
      outputDeviceId: this.st.outputDeviceId,
      engine: this.engine?.kind ?? this.st.engine,
      error: this.error,
    }
  }

  private flush = (): void => {
    this.flushQueued = false
    if (this.stateTimer) clearTimeout(this.stateTimer)
    this.stateTimer = null
    this.lastStateAt = performance.now()
    const s = this.getState()
    this.session?.update(s)
    this.emit('state', s)
  }

  /** Coalesces state emissions; position-only updates are throttled to 4 Hz. */
  private scheduleState(urgent = true): void {
    if (urgent) {
      if (!this.flushQueued) {
        this.flushQueued = true
        queueMicrotask(this.flush)
      }
      return
    }
    if (this.stateTimer || this.flushQueued) return
    this.stateTimer = setTimeout(this.flush, Math.max(0, 250 - (performance.now() - this.lastStateAt)))
  }

  async dispose(): Promise<void> {
    removeEventListener('pagehide', this.onPageHide)
    this.endListen('stopped')
    if (this.stateTimer) clearTimeout(this.stateTimer)
    this.engine.dispose()
    this.output.dispose()
    this.session?.dispose()
    this.graph.dispose()
    this.clearListeners()
    await this.ctx.close().catch(() => {})
  }
}
