// Pure playback policy helpers: volume curve, ReplayGain, smart crossfade, balance, prefs, sleep timer.

import type { PlaybackPrefs, PlayItem, RgMode, SleepTimer } from './types'

export const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x))
export const dbToGain = (db: number) => 10 ** (db / 20)

/** Perceptual volume (0..1) -> linear gain; cubic gives ~-60 dB at 10% and -18 dB at 50%. */
export function volumeToGain(v: number): number {
  const x = clamp(Number.isFinite(v) ? v : 0, 0, 1)
  return x * x * x
}

/** ReplayGain as a linear factor, clamped by the peak so the result never clips. */
export function rgGain(item: PlayItem | null | undefined, mode: RgMode, albumContext: boolean): number {
  const rg = item?.rg
  if (!rg || mode === 'off') return 1
  const album = mode === 'album' || (mode === 'auto' && albumContext)
  const gain = album ? (rg.albumGain ?? rg.trackGain) : (rg.trackGain ?? rg.albumGain)
  const peak = album ? (rg.albumPeak ?? rg.trackPeak) : (rg.trackPeak ?? rg.albumPeak)
  if (gain === undefined || !Number.isFinite(gain)) return 1
  let g = dbToGain(clamp(gain, -24, 24))
  if (peak && peak > 0) g = Math.min(g, 1 / peak)
  return g
}

/** b directly follows a on the same album (next track, or first track of the next disc). */
export function isAlbumContinuation(a: PlayItem | null | undefined, b: PlayItem | null | undefined): boolean {
  if (!a || !b || !a.albumKey || a.albumKey !== b.albumKey) return false
  if (a.trackNo == null || b.trackNo == null) return false
  const ad = a.discNo ?? 1
  const bd = b.discNo ?? 1
  return (bd === ad && b.trackNo === a.trackNo + 1) || (bd === ad + 1 && b.trackNo === 1)
}

/** Smart crossfade: none between consecutive album tracks (gapless) or when repeating a track. */
export function crossfadeSecFor(a: PlayItem | null | undefined, b: PlayItem | null | undefined, sec: number): number {
  if (!(sec > 0) || !a || !b || a.id === b.id || isAlbumContinuation(a, b)) return 0
  return sec
}

/** Media URL for the element engine: valence-media://file/<base64url(utf8 path)>.<ext> */
export function mediaUrl(path: string): string {
  const bytes = new TextEncoder().encode(path)
  let bin = ''
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
  const b64 = btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  const ext = /\.([A-Za-z0-9]{1,5})$/.exec(path)?.[1]
  return `valence-media://file/${b64}${ext ? '.' + ext.toLowerCase() : ''}`
}

// ---- channels ---------------------------------------------------------------------------------

/** Balance in [-1, 1] -> [left, right] gains: the far channel is attenuated, the near one stays at unity. */
export function balanceGains(balance: number): [number, number] {
  const b = clamp(Number.isFinite(balance) ? balance : 0, -1, 1)
  return [b > 0 ? 1 - b : 1, b < 0 ? 1 + b : 1]
}

// ---- preferences ------------------------------------------------------------------------------

export const DEFAULT_PREFS: PlaybackPrefs = { autoplay: true, sleepFade: true, mono: false, balance: 0, fadeMs: 120, prevRestartMs: 3000 }

/** Coerces untrusted preference values (settings files, IPC) into range. */
export function normalizePrefs(p: Partial<Record<keyof PlaybackPrefs, unknown>>, base: PlaybackPrefs = DEFAULT_PREFS): PlaybackPrefs {
  const bool = (v: unknown, d: boolean) => (typeof v === 'boolean' ? v : d)
  const num = (v: unknown, lo: number, hi: number, d: number) => {
    const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN
    return Number.isFinite(n) ? clamp(n, lo, hi) : d
  }
  return {
    autoplay: bool(p.autoplay, base.autoplay),
    sleepFade: bool(p.sleepFade, base.sleepFade),
    mono: bool(p.mono, base.mono),
    balance: num(p.balance, -1, 1, base.balance),
    fadeMs: Math.round(num(p.fadeMs, 0, 2000, base.fadeMs)),
    prevRestartMs: Math.round(num(p.prevRestartMs, 0, 60_000, base.prevRestartMs)),
  }
}

// ---- album boundaries / sleep timer -----------------------------------------------------------

const norm = (s: string | undefined) => (s ?? '').trim().toLowerCase()

/** Same album: by albumKey when either has one, else by album title. */
export function sameAlbum(a: PlayItem | null | undefined, b: PlayItem | null | undefined): boolean {
  if (!a || !b) return false
  if (a.albumKey || b.albumKey) return a.albumKey === b.albumKey
  return !!norm(a.album) && norm(a.album) === norm(b.album)
}

/** Where the next item comes from (PlayQueue.peekFrom). */
export type NextFrom = 'repeat' | 'upNext' | 'context' | 'wrap' | 'continuation'

/** An album sleep timer ends between `cur` and `next`: the album changes, the context ends or wraps, or a track repeats. */
export function albumEndsBetween(cur: PlayItem | null | undefined, next: PlayItem | null | undefined, from: NextFrom | null): boolean {
  if (!cur || !next || !from || from === 'wrap' || from === 'continuation' || from === 'repeat') return true
  return !sameAlbum(cur, next)
}

export const SLEEP_OFF: SleepTimer = Object.freeze({ mode: 'off' }) as SleepTimer
export const SLEEP_FADE_MS = 20_000

/** Validates a sleep timer from the UI or the relay; a 'time' timer without endsAt starts now from `minutes`. */
export function normalizeSleep(t: unknown, now = Date.now()): SleepTimer {
  const o = (t && typeof t === 'object' ? t : {}) as { mode?: unknown; endsAt?: unknown; minutes?: unknown }
  if (o.mode === 'track' || o.mode === 'album') return { mode: o.mode }
  if (o.mode !== 'time') return SLEEP_OFF
  const minutes = typeof o.minutes === 'number' && Number.isFinite(o.minutes) && o.minutes > 0 ? o.minutes : null
  const endsAt = typeof o.endsAt === 'number' && Number.isFinite(o.endsAt) ? o.endsAt : minutes !== null ? now + minutes * 60_000 : NaN
  if (!Number.isFinite(endsAt) || endsAt <= now) return SLEEP_OFF
  return { mode: 'time', endsAt, minutes: minutes ?? Math.round((endsAt - now) / 60_000) }
}

/**
 * Gain breakpoints (ms from now) for a timed sleep fade: unity until the last `windowMs`, then down
 * the volume curve to 0 at `remainingMs`. The first point settles from whatever level is current.
 * Schedule each with linearRampToValueAtTime after holding the current value.
 */
export function sleepFadePlan(remainingMs: number, windowMs = SLEEP_FADE_MS, steps = 24, settleMs = 250): Array<{ at: number; gain: number }> {
  const rem = Math.max(0, remainingMs)
  const G = (left: number) => (left >= windowMs ? 1 : volumeToGain(Math.max(0, left) / windowMs))
  const settle = Math.min(settleMs, rem)
  const pts = [{ at: settle, gain: G(rem - settle) }]
  for (let k = 0; k <= steps; k++) {
    const left = windowMs * (1 - k / steps)
    const at = rem - left
    if (at > settle) pts.push({ at, gain: G(left) })
  }
  return pts
}
