// Applies appearance settings at startup and whenever one changes: palette (ui.theme), accent
// (ui.accent + ui.artTheme), density, motion, text size, zoom and colorful headers. Also tells the
// main process which colors to use for the window controls.

import { SETTINGS } from '@shared/ipc/settings'
import { invoke, on, send } from '../lib/ipc'
import { accentHex, applyAccent, artThemeSetting, configureAccent } from './accent'
import { applyTheme, findTheme, watchUserThemes } from './themes'
import { usePlayer } from '../state/player'

let settings: Record<string, unknown> = {}

const TEXT_SCALE: Record<string, number> = { small: 0.93, default: 1, large: 1.07, larger: 1.14 }
const LYRICS_SCALE: Record<string, number> = { small: 0.82, default: 1, large: 1.22 }

export { artThemeSetting }

function apply(): void {
  const th = findTheme(settings['ui.theme'])
  applyTheme(th)
  const root = document.documentElement
  const chosen = settings['ui.accent']
  const accent = typeof chosen === 'string' && chosen !== 'art' ? accentHex(chosen) : (th.accent ?? accentHex(null))
  configureAccent({ accent, artTheme: th.artTint === false ? 'off' : artThemeSetting(settings) })
  root.dataset.density = settings['ui.density'] === 'compact' ? 'compact' : 'comfortable'
  const motion = settings['ui.motion']
  root.dataset.motion = motion === 'off' || motion === 'on' ? motion : 'system'
  root.dataset.headers = settings['ui.headerColors'] === true ? 'on' : 'off'
  root.style.setProperty('--font-scale', String(TEXT_SCALE[String(settings['ui.textSize'] ?? 'default')] ?? 1))
  root.style.setProperty('--lyrics-scale', String(LYRICS_SCALE[String(settings['ui.lyrics.size'] ?? 'default')] ?? 1))
  const zoom = Number(settings['ui.zoom'] ?? 1)
  send('window:zoom', Number.isFinite(zoom) && zoom > 0 ? zoom : 1)
  // Window controls (Windows/Linux) follow the palette, not the OS.
  requestAnimationFrame(() => {
    const cs = getComputedStyle(root)
    send('window:chrome', { symbolColor: cs.getPropertyValue('--fg').trim() || '#ffffff', background: cs.getPropertyValue('--base').trim() || '#000000' })
  })
  void applyAccent(usePlayer.getState().currentArtHash)
}

export async function initAppearance(): Promise<void> {
  const [all] = await Promise.all([invoke<Record<string, unknown>>(SETTINGS.all).catch(() => ({})), watchUserThemes(() => apply())])
  settings = all
  apply()
  on<[string, unknown]>(SETTINGS.changed, (k, v) => {
    if (!k.startsWith('ui.')) return
    settings = { ...settings, [k]: v }
    apply()
  })
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', apply)
}
