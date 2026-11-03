import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Pacer, type PacerClock } from '@main/sources/tidal/pacing'

describe('Pacer (fake timers)', () => {
  beforeEach(() => vi.useFakeTimers({ now: 0 }))
  afterEach(() => vi.useRealTimers())

  it('waits 3–5 s between tracks and 30–60 s every 20 tracks', async () => {
    const waits: Array<[number, string]> = []
    let r = 0
    const pacer = new Pacer({ clock: { now: () => Date.now(), sleep: (ms) => new Promise((res) => setTimeout(res, ms)), random: () => (r = (r + 0.37) % 1) } })
    for (let i = 0; i < 41; i++) {
      const p = pacer.wait(undefined, (ms, reason) => waits.push([ms, reason]))
      await vi.runAllTimersAsync()
      await p
      pacer.done()
    }
    expect(waits).toHaveLength(40)
    const breaks = waits.map(([, reason], i) => [i + 1, reason]).filter(([, reason]) => reason === 'break')
    expect(breaks.map(([n]) => n)).toEqual([20, 40])
    for (const [ms, reason] of waits) {
      if (reason === 'gap') expect(ms).toBeGreaterThanOrEqual(3000), expect(ms).toBeLessThanOrEqual(5000)
      else expect(ms).toBeGreaterThanOrEqual(30_000), expect(ms).toBeLessThanOrEqual(60_000)
    }
  })

  it('does not wait before the first track and counts idle time toward the gap', async () => {
    const pacer = new Pacer({ clock: { now: () => Date.now(), sleep: (ms) => new Promise((res) => setTimeout(res, ms)), random: () => 0.5 } })
    expect(await pacer.wait()).toBe(0)
    pacer.done()
    vi.advanceTimersByTime(1500)
    const p = pacer.wait()
    await vi.advanceTimersByTimeAsync(2500)
    expect(await p).toBe(2500) // 4000 planned - 1500 already idle
    pacer.done()
    vi.advanceTimersByTime(120_000) // a long idle period resets the run
    expect(pacer.plan()).toEqual({ ms: 0, reason: 'break' })
  })

  it('aborts a wait with SourceError(cancelled) using the default clock', async () => {
    const pacer = new Pacer({ gapMs: [3000, 3000] })
    pacer.done()
    const ctrl = new AbortController()
    const p = pacer.wait(ctrl.signal)
    const assertion = expect(p).rejects.toMatchObject({ kind: 'cancelled' })
    await vi.advanceTimersByTimeAsync(1000)
    ctrl.abort()
    await assertion
  })
})

describe('Pacer (injected clock)', () => {
  it('uses the injected sleep and never touches real timers', async () => {
    let now = 0
    const slept: number[] = []
    const clock: PacerClock = { now: () => now, random: () => 1, sleep: async (ms) => void slept.push(ms) }
    const pacer = new Pacer({ clock, breakEvery: 2, gapMs: [3000, 5000], breakMs: [30_000, 60_000] })
    for (let i = 0; i < 4; i++) {
      await pacer.wait()
      now += 10_000 // download time does not count as idle
      pacer.done()
      now += 100 // idle time does
    }
    expect(slept).toEqual([4900, 59_900, 4900])
  })
})
