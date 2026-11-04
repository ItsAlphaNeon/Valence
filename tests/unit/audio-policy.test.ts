import { describe, expect, it } from 'vitest'
import { DEFAULT_PREFS, SLEEP_FADE_MS, SLEEP_OFF, albumEndsBetween, balanceGains, normalizePrefs, normalizeSleep, sameAlbum, sleepFadePlan, volumeToGain } from '@renderer/audio/policy'
import type { PlayItem } from '@renderer/audio/types'

const item = (id: string, extra: Partial<PlayItem> = {}): PlayItem => ({ id, path: `/m/${id}.flac`, title: id, artist: 'A', album: 'X', durationMs: 180000, ...extra })

describe('balanceGains', () => {
  it('is unity on both channels at center', () => {
    expect(balanceGains(0)).toEqual([1, 1])
  })
  it('attenuates only the far channel, linearly', () => {
    expect(balanceGains(-1)).toEqual([1, 0])
    expect(balanceGains(1)).toEqual([0, 1])
    const [l, r] = balanceGains(0.25)
    expect(l).toBeCloseTo(0.75, 9)
    expect(r).toBe(1)
    const [l2, r2] = balanceGains(-0.5)
    expect(l2).toBe(1)
    expect(r2).toBeCloseTo(0.5, 9)
  })
  it('clamps out-of-range and non-finite input', () => {
    expect(balanceGains(5)).toEqual([0, 1])
    expect(balanceGains(-5)).toEqual([1, 0])
    expect(balanceGains(NaN)).toEqual([1, 1])
  })
})

describe('normalizePrefs', () => {
  it('fills defaults', () => {
    expect(normalizePrefs({})).toEqual(DEFAULT_PREFS)
    expect(DEFAULT_PREFS).toEqual({ autoplay: true, sleepFade: true, mono: false, balance: 0, fadeMs: 120, prevRestartMs: 3000 })
  })
  it('clamps and rounds numbers, accepts numeric strings, ignores junk', () => {
    const p = normalizePrefs({ balance: 3, fadeMs: '87.6', prevRestartMs: -10, mono: 'yes', autoplay: false })
    expect(p.balance).toBe(1)
    expect(p.fadeMs).toBe(88)
    expect(p.prevRestartMs).toBe(0)
    expect(p.mono).toBe(false)
    expect(p.autoplay).toBe(false)
    expect(normalizePrefs({ fadeMs: 99999 }).fadeMs).toBe(2000)
    expect(normalizePrefs({ balance: '' }).balance).toBe(0)
    expect(normalizePrefs({ balance: 'abc' }).balance).toBe(0)
  })
  it('keeps the base for missing keys', () => {
    const base = { ...DEFAULT_PREFS, mono: true, balance: -0.4 }
    expect(normalizePrefs({ fadeMs: 0 }, base)).toEqual({ ...base, fadeMs: 0 })
  })
})

describe('album boundaries', () => {
  const a1 = item('a1', { albumKey: 'k1', album: 'One' })
  const a2 = item('a2', { albumKey: 'k1', album: 'One' })
  const b1 = item('b1', { albumKey: 'k2', album: 'One' })
  it('matches by albumKey when present, else by title', () => {
    expect(sameAlbum(a1, a2)).toBe(true)
    expect(sameAlbum(a1, b1)).toBe(false)
    expect(sameAlbum(a1, item('x', { album: 'One' }))).toBe(false)
    expect(sameAlbum(item('x', { album: ' one ' }), item('y', { album: 'One' }))).toBe(true)
    expect(sameAlbum(item('x', { album: '' }), item('y', { album: '' }))).toBe(false)
    expect(sameAlbum(a1, null)).toBe(false)
  })
  it('ends the album on a change, the end of the queue, a wrap, a continuation or a repeat', () => {
    expect(albumEndsBetween(a1, a2, 'context')).toBe(false)
    expect(albumEndsBetween(a1, a2, 'upNext')).toBe(false)
    expect(albumEndsBetween(a1, b1, 'context')).toBe(true)
    expect(albumEndsBetween(a1, null, null)).toBe(true)
    expect(albumEndsBetween(a1, a2, 'wrap')).toBe(true)
    expect(albumEndsBetween(a1, a2, 'continuation')).toBe(true)
    expect(albumEndsBetween(a1, a1, 'repeat')).toBe(true)
  })
})

describe('normalizeSleep', () => {
  const now = 1_000_000
  it('passes track and album through, rejects junk', () => {
    expect(normalizeSleep({ mode: 'track' }, now)).toEqual({ mode: 'track' })
    expect(normalizeSleep({ mode: 'album' }, now)).toEqual({ mode: 'album' })
    expect(normalizeSleep({ mode: 'off' }, now)).toBe(SLEEP_OFF)
    expect(normalizeSleep(null, now)).toBe(SLEEP_OFF)
    expect(normalizeSleep({ mode: 'nap' }, now)).toBe(SLEEP_OFF)
  })
  it('computes endsAt from minutes, keeps a future endsAt, drops a past one', () => {
    expect(normalizeSleep({ mode: 'time', minutes: 15 }, now)).toEqual({ mode: 'time', endsAt: now + 15 * 60_000, minutes: 15 })
    expect(normalizeSleep({ mode: 'time', endsAt: now + 60_000, minutes: 30 }, now)).toEqual({ mode: 'time', endsAt: now + 60_000, minutes: 30 })
    expect(normalizeSleep({ mode: 'time', endsAt: now + 10 * 60_000 }, now)).toEqual({ mode: 'time', endsAt: now + 10 * 60_000, minutes: 10 })
    expect(normalizeSleep({ mode: 'time', endsAt: now - 1, minutes: 5 }, now)).toBe(SLEEP_OFF)
    expect(normalizeSleep({ mode: 'time', minutes: 0 }, now)).toBe(SLEEP_OFF)
    expect(normalizeSleep({ mode: 'time' }, now)).toBe(SLEEP_OFF)
  })
})

describe('sleepFadePlan', () => {
  it('holds unity until the window, then falls monotonically to 0 at the end', () => {
    const rem = 5 * 60_000
    const plan = sleepFadePlan(rem)
    expect(plan[0]).toEqual({ at: 250, gain: 1 })
    expect(plan.at(-1)).toEqual({ at: rem, gain: 0 })
    for (let i = 1; i < plan.length; i++) {
      expect(plan[i].at).toBeGreaterThan(plan[i - 1].at)
      expect(plan[i].gain).toBeLessThanOrEqual(plan[i - 1].gain)
    }
    // the fade starts at the window edge
    const windowStart = plan.find((p) => p.at >= rem - SLEEP_FADE_MS)!
    expect(windowStart.at).toBe(rem - SLEEP_FADE_MS)
    expect(windowStart.gain).toBe(1)
    // and follows the volume curve
    const mid = plan.find((p) => p.at === rem - SLEEP_FADE_MS / 2)!
    expect(mid.gain).toBeCloseTo(volumeToGain(0.5), 9)
  })
  it('starts partway down when less than the window is left', () => {
    const plan = sleepFadePlan(10_000)
    expect(plan[0].at).toBe(250)
    expect(plan[0].gain).toBeCloseTo(volumeToGain((10_000 - 250) / SLEEP_FADE_MS), 9)
    expect(plan.at(-1)).toEqual({ at: 10_000, gain: 0 })
    for (let i = 1; i < plan.length; i++) expect(plan[i].gain).toBeLessThanOrEqual(plan[i - 1].gain)
  })
  it('goes straight to silence when almost no time is left', () => {
    expect(sleepFadePlan(100)).toEqual([{ at: 100, gain: 0 }])
    expect(sleepFadePlan(-5)).toEqual([{ at: 0, gain: 0 }])
  })
})
