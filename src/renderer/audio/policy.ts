// Pure playback policy helpers: volume curve, ReplayGain, smart crossfade.

import type { PlayItem, RgMode } from './types'

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
