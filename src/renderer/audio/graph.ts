// Web Audio graph: engine -> preamp -> 10-band peaking EQ -> [limiter] -> tap -> master -> analyser -> output.

import { clamp, dbToGain, volumeToGain } from './policy'
import type { EqPresetName, EqState } from './types'

export const EQ_FREQS = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000]
export const EQ_Q = 1.41
export const EQ_MAX_DB = 12

export const EQ_PRESETS: Record<Exclude<EqPresetName, 'Custom'>, number[]> = {
  Flat: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  'Bass Boost': [6, 5, 4, 2.5, 1, 0, 0, 0, 0, 0],
  'Treble Boost': [0, 0, 0, 0, 0, 1, 2.5, 4, 5, 6],
  Vocal: [-2, -3, -3, 1, 3.5, 3.5, 3, 1.5, 0, -1.5],
  Loudness: [6, 4, 0, 0, -2, 0, -1, -5, 5, 1],
  Electronic: [4, 3.5, 1, 0, -2, 2, 1, 1, 4, 5],
  Rock: [5, 4, 3, 1.5, -0.5, -1, 0.5, 2.5, 3.5, 4.5],
  Acoustic: [4.5, 4.5, 3.5, 1, 1.5, 1.5, 3, 3.5, 3, 1.5],
}

export const defaultEq = (): EqState => ({ enabled: false, preset: 'Flat', gains: [...EQ_PRESETS.Flat] })

export function normalizeEq(eq: Partial<EqState> | null | undefined, base: EqState = defaultEq()): EqState {
  const gains = Array.isArray(eq?.gains) && eq.gains.length === 10 ? eq.gains.map((g) => clamp(Number(g) || 0, -EQ_MAX_DB, EQ_MAX_DB)) : base.gains
  return { enabled: eq?.enabled ?? base.enabled, preset: (eq?.preset as EqPresetName) ?? base.preset, gains }
}

/** Limiter is engaged whenever the chain can add gain. */
export const needsLimiter = (eq: EqState, preampDb: number) => preampDb > 0 || (eq.enabled && eq.gains.some((g) => g > 0))

export class AudioGraph {
  readonly input: GainNode
  readonly bands: BiquadFilterNode[]
  readonly limiter: DynamicsCompressorNode
  /** Pre-master signal (after EQ/limiter), for captures and meters that ignore volume. */
  readonly tap: GainNode
  readonly master: GainNode
  readonly analyser: AnalyserNode
  private limiterOn = false
  private eq: EqState = defaultEq()
  private preampDb = 0

  constructor(
    readonly ctx: BaseAudioContext,
    private forceMute = false,
  ) {
    this.input = new GainNode(ctx, { gain: 1 })
    this.bands = EQ_FREQS.map((frequency) => new BiquadFilterNode(ctx, { type: 'peaking', frequency, Q: EQ_Q, gain: 0 }))
    this.limiter = new DynamicsCompressorNode(ctx, { threshold: -1, knee: 0, ratio: 20, attack: 0.003, release: 0.25 })
    this.tap = new GainNode(ctx, { gain: 1 })
    this.master = new GainNode(ctx, { gain: 0 })
    this.analyser = new AnalyserNode(ctx, { fftSize: 2048, smoothingTimeConstant: 0.8 })
    let prev: AudioNode = this.input
    for (const b of this.bands) {
      prev.connect(b)
      prev = b
    }
    prev.connect(this.tap)
    this.limiter.connect(this.tap)
    this.tap.connect(this.master)
    this.master.connect(this.analyser)
  }

  /** Node to connect to the output stage. */
  get output(): AudioNode {
    return this.analyser
  }

  get limiterEngaged(): boolean {
    return this.limiterOn
  }

  private ramp(p: AudioParam, v: number, tc = 0.015): void {
    const t = this.ctx.currentTime
    p.cancelScheduledValues(t)
    p.setTargetAtTime(v, t, tc)
  }

  setPreamp(db: number): void {
    this.preampDb = clamp(db, -12, 12)
    this.ramp(this.input.gain, dbToGain(this.preampDb))
    this.updateLimiter()
  }

  setEq(eq: EqState): void {
    this.eq = eq
    this.bands.forEach((b, i) => this.ramp(b.gain, eq.enabled ? clamp(eq.gains[i] ?? 0, -EQ_MAX_DB, EQ_MAX_DB) : 0))
    this.updateLimiter()
  }

  setVolume(volume: number, muted: boolean): void {
    this.ramp(this.master.gain, this.forceMute || muted ? 0 : volumeToGain(volume))
  }

  private updateLimiter(): void {
    const on = needsLimiter(this.eq, this.preampDb)
    if (on === this.limiterOn) return
    this.limiterOn = on
    const last = this.bands[this.bands.length - 1]
    last.disconnect()
    last.connect(on ? this.limiter : this.tap)
  }

  dispose(): void {
    for (const n of [this.input, ...this.bands, this.limiter, this.tap, this.master, this.analyser]) n.disconnect()
  }
}
