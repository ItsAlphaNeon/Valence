// Human-ish pacing between track downloads: a 3–5 s gap between tracks and a 30–60 s pause every
// 20 tracks. One Pacer is shared across jobs so back-to-back albums are paced too; time already
// spent idle counts toward the next wait.

import { abortableSleep } from './util'

export interface PacerClock {
  now(): number
  sleep(ms: number, signal?: AbortSignal): Promise<void>
  random(): number
}

export const systemClock: PacerClock = {
  now: () => Date.now(),
  sleep: (ms, signal) => abortableSleep(ms, signal),
  random: () => Math.random(),
}

export interface PacerOptions {
  clock?: PacerClock
  gapMs?: [number, number]
  breakEvery?: number
  breakMs?: [number, number]
}

export type WaitReason = 'gap' | 'break'

export class Pacer {
  private readonly clock: PacerClock
  private readonly gap: [number, number]
  private readonly every: number
  private readonly brk: [number, number]
  private count = 0
  private last: number | null = null

  constructor(opts: PacerOptions = {}) {
    this.clock = opts.clock ?? systemClock
    this.gap = opts.gapMs ?? [3_000, 5_000]
    this.every = opts.breakEvery ?? 20
    this.brk = opts.breakMs ?? [30_000, 60_000]
  }

  private pick([lo, hi]: [number, number]): number {
    return Math.round(lo + (hi - lo) * this.clock.random())
  }

  /** The wait the next track needs right now (without sleeping). */
  plan(): { ms: number; reason: WaitReason } {
    if (this.last === null || this.count === 0) return { ms: 0, reason: 'gap' }
    const idle = Math.max(0, this.clock.now() - this.last)
    // A long idle period already was a break; start a fresh run of tracks.
    if (idle >= this.brk[1]) {
      this.count = 0
      return { ms: 0, reason: 'break' }
    }
    const reason: WaitReason = this.count % this.every === 0 ? 'break' : 'gap'
    const ms = this.pick(reason === 'break' ? this.brk : this.gap)
    return { ms: Math.max(0, ms - idle), reason }
  }

  /** Waits before the next track download. Resolves with the time waited. */
  async wait(signal?: AbortSignal, onWait?: (ms: number, reason: WaitReason) => void): Promise<number> {
    const { ms, reason } = this.plan()
    if (ms > 0) {
      onWait?.(ms, reason)
      await this.clock.sleep(ms, signal)
    }
    return ms
  }

  /** Marks a track download as finished (successful or not). */
  done(): void {
    this.count++
    this.last = this.clock.now()
  }

  reset(): void {
    this.count = 0
    this.last = null
  }
}
