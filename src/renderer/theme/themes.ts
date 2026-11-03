// Bundled themes: token overrides applied on <html>. User themes (JSON with the same shape) live in
// ~/Music/.valence/themes/ and sync across devices.

import type { Tier } from './tiers'

export interface ThemeDef {
  id: string
  name: string
  /** Forces light/dark; omitted = follow system. */
  scheme?: 'light' | 'dark'
  /** Highest tier this theme allows (e.g. Performance caps at "glass"). */
  maxTier?: Tier
  /** Uses album-art tint unless false. */
  artTint?: boolean
  accent?: string
  tokens?: Record<string, string>
  css?: string
}

export const BUILTIN_THEMES: ThemeDef[] = [
  { id: 'liquid-glass', name: 'Liquid Glass' },
  { id: 'liquid-glass-performance', name: 'Liquid Glass (Performance)', maxTier: 'glass' },
  { id: 'solid-dark', name: 'Solid Dark', scheme: 'dark', maxTier: 'minimal' },
  { id: 'solid-light', name: 'Solid Light', scheme: 'light', maxTier: 'minimal' },
]

const TIER_ORDER: Tier[] = ['full', 'glass', 'flat', 'minimal']

export function capTier(t: Tier, theme: ThemeDef): Tier {
  if (!theme.maxTier) return t
  return TIER_ORDER[Math.max(TIER_ORDER.indexOf(t), TIER_ORDER.indexOf(theme.maxTier))]
}

let applied: string[] = []
let styleEl: HTMLStyleElement | null = null

export function applyTheme(theme: ThemeDef): void {
  const root = document.documentElement
  for (const k of applied) root.style.removeProperty(k)
  applied = []
  if (theme.scheme) root.dataset.scheme = theme.scheme
  else delete root.dataset.scheme
  for (const [k, v] of Object.entries(theme.tokens ?? {})) {
    const name = k.startsWith('--') ? k : `--${k}`
    root.style.setProperty(name, v)
    applied.push(name)
  }
  styleEl ??= document.head.appendChild(document.createElement('style'))
  styleEl.textContent = theme.css ?? ''
}
