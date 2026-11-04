// Web Audio graph: engine -> preamp -> 10-band peaking EQ -> [limiter] -> tap -> fader -> channels
// (mono mix, balance) -> master -> analyser -> output.

import { balanceGains, clamp, dbToGain, volumeToGain } from './policy'
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
  /** Sleep-timer fade, independent of the volume (the Player schedules it). */
  readonly fader: GainNode
  readonly master: GainNode
  readonly analyser: AnalyserNode
  private stereo: GainNode
  private monoMix: GainNode
  private sum: GainNode
  private split: ChannelSplitterNode
  private left: GainNode
  private right: GainNode
  private merge: ChannelMergerNode
  private limiterOn = false
  private eq: EqState = defaultEq()
  private preampDb = 0
  private mono = false
  private balance = 0

  constructor(
    readonly ctx: BaseAudioContext,
    private forceMute = false,
  ) {
    this.input = new GainNode(ctx, { gain: 1 })
    this.bands = EQ_FREQS.map((frequency) => new BiquadFilterNode(ctx, { type: 'peaking', frequency, Q: EQ_Q, gain: 0 }))
    this.limiter = new DynamicsCompressorNode(ctx, { threshold: -1, knee: 0, ratio: 20, attack: 0.003, release: 0.25 })
    this.tap = new GainNode(ctx, { gain: 1 })
    this.fader = new GainNode(ctx, { gain: 1 })
    // Mono: a 1-channel 'speakers' node downmixes (L+R)/2; `sum` (explicit stereo) upmixes it back to
    // both sides. The stereo and mono paths cross-ramp, so toggling never clicks.
    this.stereo = new GainNode(ctx, { gain: 1 })
    this.monoMix = new GainNode(ctx, { gain: 0, channelCount: 1, channelCountMode: 'explicit', channelInterpretation: 'speakers' })
    this.sum = new GainNode(ctx, { gain: 1, channelCount: 2, channelCountMode: 'explicit', channelInterpretation: 'speakers' })
    this.split = new ChannelSplitterNode(ctx, { numberOfOutputs: 2 })
    this.left = new GainNode(ctx, { gain: 1, channelCount: 1, channelCountMode: 'explicit' })
    this.right = new GainNode(ctx, { gain: 1, channelCount: 1, channelCountMode: 'explicit' })
    this.merge = new ChannelMergerNode(ctx, { numberOfInputs: 2 })
    this.master = new GainNode(ctx, { gain: 0 })
    this.analyser = new AnalyserNode(ctx, { fftSize: 2048, smoothingTimeConstant: 0.8 })
    let prev: AudioNode = this.input
    for (const b of this.bands) {
      prev.connect(b)
      prev = b
    }
    prev.connect(this.tap)
    this.limiter.connect(this.tap)
    this.tap.connect(this.fader)
    this.fader.connect(this.stereo).connect(this.sum)
    this.fader.connect(this.monoMix).connect(this.sum)
    this.sum.connect(this.split)
    this.split.connect(this.left, 0)
    this.split.connect(this.right, 1)
    this.left.connect(this.merge, 0, 0)
    this.right.connect(this.merge, 0, 1)
    this.merge.connect(this.master)
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

  setMono(on: boolean): void {
    if (on === this.mono) return
    this.mono = on
    this.ramp(this.stereo.gain, on ? 0 : 1)
    this.ramp(this.monoMix.gain, on ? 1 : 0)
  }

  /** -1 (left only) .. 1 (right only). */
  setBalance(balance: number): void {
    const b = clamp(Number.isFinite(balance) ? balance : 0, -1, 1)
    if (b === this.balance) return
    this.balance = b
    const [l, r] = balanceGains(b)
    this.ramp(this.left.gain, l)
    this.ramp(this.right.gain, r)
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
    const nodes = [this.input, ...this.bands, this.limiter, this.tap, this.fader, this.stereo, this.monoMix, this.sum, this.split, this.left, this.right, this.merge, this.master, this.analyser]
    for (const n of nodes) n.disconnect()
  }
}
