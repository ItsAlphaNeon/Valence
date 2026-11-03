// Applies appearance settings (ui.theme, ui.tier, ui.accent) at startup and whenever they change.
// "auto" tier: a static guess from GPU status/OS preferences, refined once by a short frame-time
// benchmark (remembered per machine) and downgraded later if the UI starts dropping frames.

import { SETTINGS, type AppInfo } from '@shared/ipc/settings'
import { invoke, on } from '../lib/ipc'
import { applyAccent, setFixedAccent } from './accent'
import { BUILTIN_THEMES, applyTheme, capTier, type ThemeDef } from './themes'
import { applyTier, downgrade, guessTier, measureFrames, TIERS, type Tier } from './tiers'
import { usePlayer } from '../state/player'

const AUTO_KEY = 'valence.tier.auto'
let settings: Record<string, unknown> = {}
let gpu: Record<string, string> | undefined

function theme(): ThemeDef {
  return BUILTIN_THEMES.find((t) => t.id === settings['ui.theme']) ?? BUILTIN_THEMES[0]
}

function autoTier(): Tier {
  const saved = localStorage.getItem(AUTO_KEY) as Tier | null
  return saved && TIERS.includes(saved) ? saved : guessTier(gpu)
}

function currentTier(): Tier {
  const pref = settings['ui.tier'] as Tier | 'auto' | undefined
  const t = pref && pref !== 'auto' && TIERS.includes(pref) ? pref : autoTier()
  return capTier(t, theme())
}

function apply(): void {
  const th = theme()
  applyTheme(th)
  applyTier(currentTier())
  const accent = settings['ui.accent']
  if (typeof accent === 'string' && /^#[0-9a-f]{6}$/i.test(accent)) setFixedAccent(accent)
  else if (th.accent) setFixedAccent(th.accent)
  else setFixedAccent(null)
  if (th.artTint === false && !th.accent && !(typeof accent === 'string' && accent.startsWith('#'))) setFixedAccent('#5e5ce6')
  void applyAccent(usePlayer.getState().currentArtHash)
}

export async function initAppearance(): Promise<void> {
  const [all, info] = await Promise.all([
    invoke<Record<string, unknown>>(SETTINGS.all).catch(() => ({})),
    invoke<AppInfo>(SETTINGS.appInfo).catch(() => null),
  ])
  settings = all
  gpu = info?.gpu
  apply()
  on<[string, unknown]>(SETTINGS.changed, (k, v) => {
    if (!k.startsWith('ui.')) return
    settings = { ...settings, [k]: v }
    apply()
  })
  matchMedia('(prefers-reduced-transparency: reduce)').addEventListener('change', apply)
}

/** First-run benchmark for "auto", then a light watchdog that steps down on sustained jank. */
export function startTierWatch(): void {
  const isAuto = () => (settings['ui.tier'] ?? 'auto') === 'auto'
  if (isAuto() && !localStorage.getItem(AUTO_KEY)) {
    setTimeout(async () => {
      const p90 = await measureFrames(2000)
      let t = guessTier(gpu)
      if (p90 > 34) t = downgrade(downgrade(t))
      else if (p90 > 22) t = downgrade(t)
      localStorage.setItem(AUTO_KEY, t)
      apply()
    }, 2500)
  }
  let strikes = 0
  setInterval(async () => {
    if (!isAuto() || document.hidden) return
    const p90 = await measureFrames(1000)
    strikes = p90 > 40 ? strikes + 1 : 0
    if (strikes >= 3) {
      strikes = 0
      const cur = autoTier()
      const next = downgrade(cur)
      if (next !== cur) {
        localStorage.setItem(AUTO_KEY, next)
        apply()
      }
    }
  }, 60_000)
}
