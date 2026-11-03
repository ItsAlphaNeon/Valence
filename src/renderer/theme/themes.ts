// Bundled themes plus user themes (JSON with the same shape) from ~/Music/.valence/themes/, which
// sync across devices. A theme is token overrides plus optional CSS, applied as one <style>.

import { useSyncExternalStore } from 'react'
import { SETTINGS, type UserThemes } from '@shared/ipc/settings'
import { invoke, on } from '../lib/ipc'
import type { Tier } from './tiers'

export interface ThemeDef {
  id: string
  name: string
  description?: string
  /** Forces light/dark; omitted = follow system. */
  scheme?: 'light' | 'dark'
  /** Highest tier this theme allows (e.g. Performance caps at "glass"). */
  maxTier?: Tier
  /** Uses album-art tint unless false. */
  artTint?: boolean
  accent?: string
  tokens?: Record<string, string>
  light?: Record<string, string>
  dark?: Record<string, string>
  css?: string
  /** User themes: file name in the themes folder. */
  file?: string
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

// --- user themes -----------------------------------------------------------------------------

let user: UserThemes = { dir: '', themes: [], errors: [] }
let snapshot: ThemeDef[] = BUILTIN_THEMES
const listeners = new Set<() => void>()

function setUser(u: UserThemes): void {
  user = u
  snapshot = [...BUILTIN_THEMES, ...u.themes]
  for (const l of listeners) l()
}

export function allThemes(): ThemeDef[] {
  return snapshot
}

export function userThemes(): UserThemes {
  return user
}

export function findTheme(id: unknown): ThemeDef {
  return snapshot.find((t) => t.id === id) ?? BUILTIN_THEMES[0]
}

export async function loadUserThemes(): Promise<void> {
  setUser(await invoke<UserThemes>(SETTINGS.themes).catch(() => user))
}

/** Loads user themes now and again whenever the folder changes; `onChange` runs after each reload. */
export async function watchUserThemes(onChange: () => void): Promise<void> {
  await loadUserThemes()
  on(SETTINGS.themesChanged, () => void loadUserThemes().then(onChange))
}

export function useThemes(): { themes: ThemeDef[]; user: UserThemes } {
  const themes = useSyncExternalStore(
    (cb) => (listeners.add(cb), () => listeners.delete(cb)),
    () => snapshot,
  )
  return { themes, user }
}

// --- apply -----------------------------------------------------------------------------------

const decls = (m: Record<string, string> | undefined) =>
  Object.entries(m ?? {})
    .map(([k, v]) => `${k.startsWith('--') ? k : `--${k}`}: ${v};`)
    .join(' ')

/** Stylesheet for a theme. Selectors out-rank theme.css's scheme rules; flat/minimal keep opaque surfaces. */
export function themeCss(theme: ThemeDef): string {
  const out: string[] = []
  if (theme.tokens && Object.keys(theme.tokens).length) out.push(`:root:root { ${decls(theme.tokens)} }`)
  if (theme.light && Object.keys(theme.light).length) {
    const d = decls(theme.light)
    out.push(`@media (prefers-color-scheme: light) { :root:root:not([data-scheme='dark']) { ${d} } }`, `:root:root[data-scheme='light'] { ${d} }`)
  }
  if (theme.dark && Object.keys(theme.dark).length) {
    const d = decls(theme.dark)
    out.push(`@media (prefers-color-scheme: dark) { :root:root:not([data-scheme='light']) { ${d} } }`, `:root:root[data-scheme='dark'] { ${d} }`)
  }
  if (out.length) {
    out.push(
      `:root:root:root[data-tier='flat'] { --glass-bg: color-mix(in srgb, var(--surface) 92%, transparent); --glass-bg-strong: var(--surface); --bg: var(--bg-solid); }`,
      `:root:root:root[data-tier='minimal'] { --glass-bg: var(--surface); --glass-bg-strong: var(--surface); --bg: var(--bg-solid); }`,
    )
  }
  if (theme.css) out.push(theme.css)
  return out.join('\n')
}

let styleEl: HTMLStyleElement | null = null

export function applyTheme(theme: ThemeDef): void {
  const root = document.documentElement
  if (theme.scheme) root.dataset.scheme = theme.scheme
  else delete root.dataset.scheme
  root.dataset.theme = theme.id
  styleEl ??= document.head.appendChild(document.createElement('style'))
  styleEl.id = 'valence-theme'
  styleEl.textContent = themeCss(theme)
}
