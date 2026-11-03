// Album-art tint: main computes a vibrant color per art hash; we adjust it for contrast against the
// current scheme and publish it as CSS variables.

import { invoke } from '../lib/ipc'
import { LIB } from '@shared/ipc/library'

interface Rgb {
  r: number
  g: number
  b: number
}

const cache = new Map<string, Rgb | null>()
const DEFAULT: Rgb = { r: 94, g: 92, b: 230 }

function lum(c: Rgb): number {
  const f = (v: number) => {
    const s = v / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b)
}

function mix(c: Rgb, t: number, toward: number): Rgb {
  return { r: c.r + (toward - c.r) * t, g: c.g + (toward - c.g) * t, b: c.b + (toward - c.b) * t }
}

/** Nudges the color until it has ~3:1 contrast against the background (light or dark). */
export function contrastAdjust(c: Rgb, dark: boolean): Rgb {
  const bg = dark ? 0.012 : 0.88
  let cur = c
  for (let i = 0; i < 12; i++) {
    const L = lum(cur)
    const ratio = dark ? (L + 0.05) / (bg + 0.05) : (bg + 0.05) / (L + 0.05)
    if (ratio >= 3) break
    cur = mix(cur, 0.12, dark ? 255 : 0)
  }
  return { r: Math.round(cur.r), g: Math.round(cur.g), b: Math.round(cur.b) }
}

export function hexToRgb(hex: string): Rgb {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex.trim())
  return m ? { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16) } : DEFAULT
}

let fixed: Rgb | null = null
let lastHash: string | null = null

export function setFixedAccent(hex: string | null): void {
  fixed = hex ? hexToRgb(hex) : null
  void applyAccent(lastHash)
}

export function isDark(): boolean {
  const s = document.documentElement.dataset.scheme
  return s ? s === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches
}

export async function applyAccent(artHash: string | null): Promise<void> {
  lastHash = artHash
  let base: Rgb = fixed ?? DEFAULT
  if (!fixed && artHash) {
    if (!cache.has(artHash)) cache.set(artHash, await invoke<Rgb | null>(LIB.artColor, artHash).catch(() => null))
    if (artHash !== lastHash) return
    base = cache.get(artHash) ?? DEFAULT
  }
  const c = contrastAdjust(base, isDark())
  const root = document.documentElement.style
  root.setProperty('--tint-r', String(c.r))
  root.setProperty('--tint-g', String(c.g))
  root.setProperty('--tint-b', String(c.b))
  root.setProperty('--accent-fg', lum(c) > 0.45 ? '#111' : '#fff')
}

matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => void applyAccent(lastHash))
