// Bundled palettes plus user themes (JSON with the same shape) from ~/Music/.valence/themes/, which
// sync across devices. Bundled palettes live in theme.css under html[data-theme]; a user theme is
// token overrides plus optional CSS, applied as one <style>.

import { useSyncExternalStore } from 'react'
import { SETTINGS, type UserThemes } from '@shared/ipc/settings'
import { invoke, on } from '../lib/ipc'

export interface ThemeDef {
  id: string
  name: string
  description?: string
  /** Forces light/dark; omitted = follow the system. */
  scheme?: 'light' | 'dark'
  /** Legacy (Liquid Glass tiers); ignored. */
  maxTier?: string
  /** false = never take the accent from album art. */
  artTint?: boolean
  accent?: string
  tokens?: Record<string, string>
  light?: Record<string, string>
  dark?: Record<string, string>
  css?: string
  /** User themes: file name in the themes folder. */
  file?: string
  /** Bundled palettes: preview colors for the picker (base, panel, card, text). */
  preview?: [string, string, string, string]
}

export const BUILTIN_THEMES: ThemeDef[] = [
  { id: 'dark', name: 'Dark', scheme: 'dark', description: 'Musicolet’s dark grey, like the phone app.', preview: ['#212121', '#181818', '#323232', '#fff'] },
  { id: 'black', name: 'Black (AMOLED)', scheme: 'dark', description: 'Pure black, easy on OLED screens.', preview: ['#0f0f0f', '#000', '#1e1e1e', '#fff'] },
  { id: 'light', name: 'Light', scheme: 'light', description: 'Light grey bars around white.', preview: ['#eeeeee', '#fafafa', '#ffffff', '#1a1a1a'] },
  { id: 'system', name: 'Follow system', description: 'Dark or Light, following your system setting.', preview: ['#212121', '#181818', '#fafafa', '#fff'] },
  { id: 'midnight', name: 'Midnight', scheme: 'dark', description: 'Inky blue-black, cool and calm.', preview: ['#121729', '#0d1120', '#222a45', '#fff'] },
  { id: 'ember', name: 'Ember', scheme: 'dark', description: 'Warm, low-light browns.', preview: ['#1c1611', '#16110d', '#30261e', '#fbf3ea'] },
  { id: 'paper', name: 'Paper', scheme: 'light', description: 'Warm cream, like a liner note.', preview: ['#ece4d7', '#faf6ef', '#fffdf8', '#2b241e'] },
]

/** Theme ids from earlier versions. */
const LEGACY: Record<string, string> = {
  oled: 'black',
  musicolet: 'dark',
  'liquid-glass': 'dark',
  'liquid-glass-performance': 'dark',
  'solid-dark': 'dark',
  'solid-light': 'light',
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
  const key = typeof id === 'string' ? (LEGACY[id] ?? id) : 'dark'
  return snapshot.find((t) => t.id === key) ?? BUILTIN_THEMES[0]
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

/** Stylesheet for a user theme. Selectors out-rank theme.css's palette rules. */
export function themeCss(theme: ThemeDef): string {
  const out: string[] = []
  if (theme.tokens && Object.keys(theme.tokens).length) out.push(`:root:root:root { ${decls(theme.tokens)} }`)
  if (theme.light && Object.keys(theme.light).length) out.push(`:root:root:root[data-scheme='light'] { ${decls(theme.light)} }`)
  if (theme.dark && Object.keys(theme.dark).length) out.push(`:root:root:root[data-scheme='dark'] { ${decls(theme.dark)} }`)
  if (theme.css) out.push(theme.css)
  return out.join('\n')
}

const systemDark = () => matchMedia('(prefers-color-scheme: dark)').matches

/** The light/dark a theme resolves to right now. */
export function resolvedScheme(theme: ThemeDef): 'light' | 'dark' {
  return theme.scheme ?? (systemDark() ? 'dark' : 'light')
}

let styleEl: HTMLStyleElement | null = null

export function applyTheme(theme: ThemeDef): void {
  const root = document.documentElement
  root.dataset.scheme = resolvedScheme(theme)
  // User themes build on the plain dark/light palette.
  root.dataset.theme = theme.file ? root.dataset.scheme : theme.id
  styleEl ??= document.head.appendChild(document.createElement('style'))
  styleEl.id = 'valence-theme'
  styleEl.textContent = theme.file ? themeCss(theme) : ''
}
