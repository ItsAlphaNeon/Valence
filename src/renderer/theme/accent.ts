// Accent and album-art colors. The accent is a preset (named after noble gases, which glow these
// colors in a discharge tube), a custom color, or the playing album's color. Main computes one
// vibrant color per art hash; here it is adjusted for contrast and published as CSS variables.

import { useEffect, useState } from 'react'
import { invoke } from '../lib/ipc'
import { LIB } from '@shared/ipc/library'

export interface Rgb {
  r: number
  g: number
  b: number
}

export interface AccentPreset {
  id: string
  name: string
  hex: string
  note: string
}

export const ACCENTS: AccentPreset[] = [
  { id: 'argon', name: 'Argon', hex: '#a78bfa', note: 'Soft lavender' },
  { id: 'neon', name: 'Neon', hex: '#ff6b4a', note: 'Warm red-orange' },
  { id: 'helium', name: 'Helium', hex: '#ffb45c', note: 'Peach gold' },
  { id: 'xenon', name: 'Xenon', hex: '#5b9dff', note: 'Electric blue' },
  { id: 'krypton', name: 'Krypton', hex: '#e9eef6', note: 'Ice white' },
  { id: 'radon', name: 'Radon', hex: '#ff5f9e', note: 'Rose pink' },
]
export const DEFAULT_ACCENT = ACCENTS[0]

/** off: preset accent only · accent: the accent follows the album playing · full: the whole window does. */
export type ArtTheme = 'off' | 'accent' | 'full'

/** ui.artTheme, falling back to what older settings meant (a #hex accent = fixed, else follow the album). */
export function artThemeSetting(s: Record<string, unknown>): ArtTheme {
  const v = s['ui.artTheme']
  if (v === 'off' || v === 'accent' || v === 'full') return v
  const legacy = s['ui.accent']
  return typeof legacy === 'string' && legacy.startsWith('#') ? 'off' : 'accent'
}

const cache = new Map<string, Rgb | null>()

function lin(v: number): number {
  const s = v / 255
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
}
export function lum(c: Rgb): number {
  return 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b)
}

function mix(c: Rgb, t: number, toward: number): Rgb {
  return { r: c.r + (toward - c.r) * t, g: c.g + (toward - c.g) * t, b: c.b + (toward - c.b) * t }
}

/** Nudges the color until it has ~3:1 contrast against the panel color (light or dark). */
export function contrastAdjust(c: Rgb, dark: boolean): Rgb {
  const bg = dark ? 0.007 : 1
  let cur = c
  for (let i = 0; i < 14; i++) {
    const L = lum(cur)
    const ratio = dark ? (L + 0.05) / (bg + 0.05) : (bg + 0.05) / (L + 0.05)
    if (ratio >= 3.2) break
    cur = mix(cur, 0.12, dark ? 255 : 0)
  }
  return { r: Math.round(cur.r), g: Math.round(cur.g), b: Math.round(cur.b) }
}

export function hexToRgb(hex: string): Rgb {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex.trim())
  return m ? { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16) } : hexToRgb(DEFAULT_ACCENT.hex)
}

/** Text color with the better contrast on top of `c`. */
export function onColor(c: Rgb): '#000' | '#fff' {
  const L = lum(c)
  return (L + 0.05) / 0.05 >= 1.05 / (L + 0.05) ? '#000' : '#fff'
}

function rgbToHsl({ r, g, b }: Rgb): [number, number, number] {
  r /= 255
  g /= 255
  b /= 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const l = (max + min) / 2
  if (max === min) return [0, 0, l]
  const d = max - min
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4
  return [h / 6, s, l]
}

function hslToRgb(h: number, s: number, l: number): Rgb {
  if (s === 0) return { r: l * 255, g: l * 255, b: l * 255 }
  const f = (p: number, q: number, t: number) => {
    if (t < 0) t += 1
    if (t > 1) t -= 1
    if (t < 1 / 6) return p + (q - p) * 6 * t
    if (t < 1 / 2) return q
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6
    return p
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s
  const p = 2 * l - q
  return { r: f(p, q, h + 1 / 3) * 255, g: f(p, q, h) * 255, b: f(p, q, h - 1 / 3) * 255 }
}

/** A header-friendly version of an art color: rich, mid-dark, never neon or muddy. */
export function headerColor(c: Rgb): Rgb {
  const [h, s, l] = rgbToHsl(c)
  const o = hslToRgb(h, Math.min(0.72, s < 0.08 ? s : Math.max(0.32, s)), Math.min(0.46, Math.max(0.24, l)))
  return { r: Math.round(o.r), g: Math.round(o.g), b: Math.round(o.b) }
}

export async function artColor(hash: string | null | undefined): Promise<Rgb | null> {
  if (!hash) return null
  if (!cache.has(hash)) cache.set(hash, await invoke<Rgb | null>(LIB.artColor, hash).catch(() => null))
  return cache.get(hash) ?? null
}

/** `"r g b"` of an album's header color, for `rgb(var(--hdr))`. */
export function useHeaderColor(hash: string | null | undefined): string | null {
  const [c, setC] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    if (!hash) return setC(null)
    void artColor(hash).then((rgb) => {
      if (!live) return
      if (!rgb) return setC(null)
      const h = headerColor(rgb)
      setC(`${h.r} ${h.g} ${h.b}`)
    })
    return () => {
      live = false
    }
  }, [hash])
  return c
}

// --- live accent ------------------------------------------------------------------------------

let fixed: Rgb = hexToRgb(DEFAULT_ACCENT.hex)
let mode: ArtTheme = 'accent'
let lastHash: string | null = null

/** Resolves a `ui.accent` value (preset id, #hex, or the legacy "art") to a color. */
export function accentHex(v: unknown): string {
  if (typeof v === 'string') {
    if (/^#[0-9a-f]{6}$/i.test(v)) return v
    const p = ACCENTS.find((a) => a.id === v)
    if (p) return p.hex
  }
  return DEFAULT_ACCENT.hex
}

export function configureAccent(opts: { accent: string; artTheme: ArtTheme }): void {
  fixed = hexToRgb(opts.accent)
  mode = opts.artTheme
  document.documentElement.dataset.art = mode
  void applyAccent(lastHash)
}

/** Kept for older callers: a fixed color or (null) the default preset. */
export function setFixedAccent(hex: string | null): void {
  fixed = hexToRgb(hex ?? DEFAULT_ACCENT.hex)
  void applyAccent(lastHash)
}

export function isDark(): boolean {
  return document.documentElement.dataset.scheme !== 'light'
}

function publish(prefix: 'tint' | 'art', c: Rgb): void {
  const root = document.documentElement.style
  root.setProperty(`--${prefix}-r`, String(Math.round(c.r)))
  root.setProperty(`--${prefix}-g`, String(Math.round(c.g)))
  root.setProperty(`--${prefix}-b`, String(Math.round(c.b)))
}

/** Called on every track change with the playing album's art hash. */
export async function applyAccent(artHash: string | null): Promise<void> {
  lastHash = artHash
  let art: Rgb | null = null
  if (mode !== 'off' && artHash) {
    art = await artColor(artHash)
    if (artHash !== lastHash) return
  }
  const base = art ?? fixed
  const c = contrastAdjust(base, isDark())
  publish('tint', c)
  document.documentElement.style.setProperty('--accent-fg', onColor(c))
  if (mode === 'full') publish('art', art ? headerColor(art) : { r: 64, g: 64, b: 72 })
  window.dispatchEvent(new CustomEvent('valence:accent', { detail: c }))
}

matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => void applyAccent(lastHash))
