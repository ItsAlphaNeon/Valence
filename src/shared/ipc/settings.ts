// Settings IPC (renderer <-> main). Keys with a shared prefix (library., transcode., art., …) sync
// through ~/Music/.valence/settings.json; everything else is local to this machine.

export const SETTINGS = {
  all: 'settings:all',
  get: 'settings:get',
  set: 'settings:set',
  /** broadcast: (key, value) */
  changed: 'settings:changed',
  /** Native folder picker; returns the chosen path or null. */
  chooseFolder: 'settings:chooseFolder',
  openPath: 'settings:openPath',
  /** Opens an https URL from a short allowlist in the default browser. */
  openExternal: 'settings:openExternal',
  appInfo: 'settings:appInfo',
  /** User themes from ~/Music/.valence/themes/*.json -> UserThemes */
  themes: 'settings:themes',
  /** Writes an example theme (unless one exists) and returns its path. */
  themeExample: 'settings:themeExample',
  /** broadcast: () — a file in the themes folder changed */
  themesChanged: 'settings:themesChanged',
} as const

export type ThemeTier = 'full' | 'glass' | 'flat' | 'minimal'

/** A theme file, validated. Token maps are CSS custom properties (with or without the leading --). */
export interface ThemeFile {
  /** "user:<file name without .json>" */
  id: string
  name: string
  description?: string
  /** Forces light/dark; omitted = follow system. */
  scheme?: 'light' | 'dark'
  maxTier?: ThemeTier
  /** false = never tint from album art. */
  artTint?: boolean
  accent?: string
  /** Applied in both light and dark. */
  tokens?: Record<string, string>
  /** Applied only when the window is light / dark (after `tokens`). */
  light?: Record<string, string>
  dark?: Record<string, string>
  css?: string
  file: string
}

export interface UserThemes {
  dir: string
  themes: ThemeFile[]
  errors: Array<{ file: string; error: string }>
}

export interface AppInfo {
  version: string
  libraryRoot: string
  dataDir: string
  inboxDir: string
  archiveDir: string | null
  deviceId: string
  platform: string
  gpu: Record<string, string>
}
