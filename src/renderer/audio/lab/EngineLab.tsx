// Dev page for the playback engine (#engine-lab[?engine=element&strategy=stream&mute=1]).
// Exposes window.__lab for scripts/e2e-playback.mjs.

import { useEffect, useState } from 'react'
import { Player } from '../player'
import { loadWorkletModule } from '../worklet-engine'
import type { OutputStrategy } from '../media-session'
import type { EngineKind, OutputDevice, PlayerCommand, PlayerState, PlayItem } from '../types'

interface LabOptions {
  engine?: EngineKind
  strategy?: OutputStrategy
  mute?: boolean
}

interface LoadOpts {
  titles?: string[]
  artist?: string
  album?: string
  albumKey?: string | null
  durationsMs?: number[]
  startIndex?: number
  startMs?: number
  autoplay?: boolean
}

class Capture {
  private node: AudioWorkletNode
  private chunks: Float32Array[] = []
  private done: ((v: Float32Array) => void) | null = null

  constructor(ctx: AudioContext, source: AudioNode) {
    this.node = new AudioWorkletNode(ctx, 'valence-tap', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] })
    source.connect(this.node)
    this.node.connect(new GainNode(ctx, { gain: 0 })).connect(ctx.destination)
    this.node.port.onmessage = (e) => {
      if (e.data.type === 'chunk') this.chunks.push(e.data.data as Float32Array)
      else if (e.data.type === 'stopped') {
        const n = this.chunks.reduce((s, c) => s + c.length, 0)
        const out = new Float32Array(n)
        let o = 0
        for (const c of this.chunks) {
          out.set(c, o)
          o += c.length
        }
        this.chunks = []
        this.done?.(out)
        this.done = null
      }
    }
  }

  start(): void {
    this.chunks = []
    this.node.port.postMessage({ type: 'start' })
  }

  stop(): Promise<Float32Array> {
    return new Promise((res) => {
      this.done = res
      this.node.port.postMessage({ type: 'stop' })
    })
  }

  dispose(): void {
    this.node.disconnect()
  }
}

function toBase64(f: Float32Array): string {
  const u = new Uint8Array(f.buffer, f.byteOffset, f.byteLength)
  let s = ''
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000))
  return btoa(s)
}

const basename = (p: string) => p.split(/[\\/]/).pop()!.replace(/\.[^.]+$/, '')

function hashParams(): LabOptions {
  const q = new URLSearchParams(location.hash.split('?')[1] ?? '')
  const engine = q.get('engine')
  const strategy = q.get('strategy')
  return {
    engine: engine === 'element' || engine === 'worklet' ? engine : undefined,
    strategy: strategy === 'destination' || strategy === 'stream' || strategy === 'anchor' ? strategy : undefined,
    mute: q.get('mute') === '1' ? true : undefined,
  }
}

function createLab(setState: (s: PlayerState) => void) {
  let player: Player | null = null
  let loads = 0
  let capture: Capture | null = null
  let opts: LabOptions = hashParams()
  const events: unknown[] = []
  const offs: (() => void)[] = []

  async function build(o: LabOptions): Promise<Player> {
    const p = await Player.create({ engine: o.engine ?? 'worklet', outputStrategy: o.strategy, mute: o.mute, storage: null })
    await loadWorkletModule(p.ctx)
    capture = new Capture(p.ctx, p.graph.tap)
    offs.push(
      p.on('state', setState),
      p.on('played', (e) => events.push({ type: 'played', id: e.item.id, playedMs: e.playedMs, completed: e.completed })),
      p.on('skipped', (e) => events.push({ type: 'skipped', id: e.item.id, playedMs: e.playedMs })),
      p.on('track', (t) => events.push({ type: 'track', id: t?.id ?? null, at: performance.now() })),
      p.on('ended', () => events.push({ type: 'ended', at: performance.now() })),
      p.on('error', (e) => events.push({ type: 'error', id: e.item?.id ?? null, message: e.message })),
    )
    return p
  }

  const need = () => {
    if (!player) throw new Error('lab not ready')
    return player
  }

  const lab = {
    ready: false,
    events,
    get player() {
      return player
    },
    async init(o: LabOptions = opts) {
      opts = o
      player = await build(o)
      lab.ready = true
      return lab.info()
    },
    async reset(o: LabOptions = {}) {
      lab.ready = false
      for (const f of offs.splice(0)) f()
      capture?.dispose()
      await player?.dispose()
      events.length = 0
      return lab.init({ ...opts, ...o })
    },
    loadPaths(paths: string[], o: LoadOpts = {}) {
      const n = ++loads
      const items: PlayItem[] = paths.map((path, i) => ({
        id: `lab:${n}:${i}:${path}`,
        path,
        title: o.titles?.[i] ?? basename(path),
        artist: o.artist ?? 'Valence Lab',
        album: o.album ?? 'Engine Lab',
        albumKey: o.albumKey === null ? undefined : (o.albumKey ?? 'engine-lab'),
        trackNo: i + 1,
        discNo: 1,
        durationMs: o.durationsMs?.[i] ?? 0,
      }))
      need().command({ type: 'setQueue', items, startIndex: o.startIndex ?? 0, startMs: o.startMs ?? 0, autoplay: o.autoplay ?? true, source: { kind: 'album', id: 'lab' } })
      return items.map((i) => i.id)
    },
    command: (c: PlayerCommand) => need().command(c),
    state: () => need().getState(),
    framesRendered: () => need().framesRendered(),
    sampleRate: () => need().ctx.sampleRate,
    info: () => ({
      engine: need().engineKind,
      strategy: need().outputStrategy,
      mute: need().muteForced,
      sampleRate: need().ctx.sampleRate,
      ctxState: need().ctx.state,
      baseLatency: need().ctx.baseLatency,
      outputLatency: need().ctx.outputLatency,
    }),
    devices: (): Promise<OutputDevice[]> => need().listOutputDevices(),
    captureStart: () => capture?.start(),
    captureStop: (): Promise<Float32Array> => capture?.stop() ?? Promise.resolve(new Float32Array(0)),
    captureStopBase64: async () => toBase64(await lab.captureStop()),
  }
  return lab
}

declare global {
  interface Window {
    __lab?: ReturnType<typeof createLab>
  }
}

export default function EngineLab() {
  const [state, setState] = useState<PlayerState | null>(null)
  const [paths, setPaths] = useState('')
  const [info, setInfo] = useState<unknown>(null)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    const lab = createLab(setState)
    window.__lab = lab
    lab.init().then(setInfo, (e: Error) => setErr(String(e?.stack ?? e)))
    return () => {
      void lab.player?.dispose()
      if (window.__lab === lab) delete window.__lab
    }
  }, [])

  const cmd = (c: PlayerCommand) => window.__lab?.command(c)
  const s = state
  const btn = { margin: 2, padding: '4px 10px' }
  return (
    <div style={{ fontFamily: 'system-ui', padding: 16, fontSize: 13 }}>
      <h2 style={{ margin: '0 0 8px' }}>Engine lab</h2>
      {err && <pre style={{ color: 'crimson' }}>{err}</pre>}
      <div>
        <button style={btn} onClick={() => cmd({ type: 'prev' })}>Prev</button>
        <button style={btn} onClick={() => cmd({ type: 'toggle' })}>{s?.playing ? 'Pause' : 'Play'}</button>
        <button style={btn} onClick={() => cmd({ type: 'next' })}>Next</button>
        <button style={btn} onClick={() => cmd({ type: 'seekBy', deltaMs: -10000 })}>-10s</button>
        <button style={btn} onClick={() => cmd({ type: 'seekBy', deltaMs: 10000 })}>+10s</button>
        <button style={btn} onClick={() => cmd({ type: 'setEngine', engine: s?.engine === 'worklet' ? 'element' : 'worklet' })}>Engine: {s?.engine}</button>
      </div>
      <div style={{ margin: '8px 0' }}>
        <textarea rows={3} style={{ width: '100%' }} placeholder="Absolute file paths, one per line" value={paths} onChange={(e) => setPaths(e.target.value)} />
        <button style={btn} onClick={() => window.__lab?.loadPaths(paths.split('\n').map((p) => p.trim()).filter(Boolean))}>Load</button>
      </div>
      {s && (
        <div>
          <b>{s.current?.title ?? '—'}</b> {Math.round(s.positionMs / 100) / 10}s / {Math.round(s.durationMs / 100) / 10}s {s.buffering ? '(buffering)' : ''}
          <input type="range" min={0} max={1} step={0.01} value={s.volume} onChange={(e) => cmd({ type: 'setVolume', volume: Number(e.target.value) })} />
        </div>
      )}
      <pre style={{ fontSize: 11, opacity: 0.8 }}>{JSON.stringify(info)}</pre>
      <pre style={{ fontSize: 11, maxHeight: 300, overflow: 'auto' }}>{s ? JSON.stringify({ ...s, queue: { upNext: s.queue.upNext.length, ...s.queue.context, upcoming: s.queue.context.upcoming.length } }, null, 1) : ''}</pre>
    </div>
  )
}
