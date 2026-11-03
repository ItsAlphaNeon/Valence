import { useEffect, useRef, useState } from 'react'
import { cx } from '../../../lib/format'
import { BUILTIN_THEMES, type ThemeDef } from '../../../theme/themes'
import { TIERS, type Tier } from '../../../theme/tiers'
import { Segmented } from '../../../components/ui'
import { Icon } from '../../../components/Icon'
import { Card, Row, SectionHead, ToggleRow, useHtmlAttr, useSettingValue } from '../controls'

const THEME_DESC: Record<string, string> = {
  'liquid-glass': 'Layered glass that takes on the colors of the album playing.',
  'liquid-glass-performance': 'The same look with lighter effects — no refraction or backdrop motion.',
  'solid-dark': 'Opaque dark surfaces. Easy on battery and older graphics.',
  'solid-light': 'Opaque light surfaces. Easy on battery and older graphics.',
}

const TIER_INFO: Record<Tier | 'auto', { label: string; desc: string }> = {
  auto: { label: 'Automatic', desc: 'Picks a level from your graphics hardware and accessibility settings, and steps down if animation stutters.' },
  full: { label: 'Full', desc: 'Liquid Glass refraction, blur and the slowly drifting album-art backdrop. Best with a dedicated GPU.' },
  glass: { label: 'Glass', desc: 'Frosted blur without refraction or backdrop motion.' },
  flat: { label: 'Flat', desc: 'Translucent solid surfaces, no blur. Light work for integrated graphics.' },
  minimal: { label: 'Minimal', desc: 'Solid surfaces and no animation. Lowest power use.' },
}

const SWATCHES = ['#5e5ce6', '#0a84ff', '#40c8e0', '#30d158', '#ffd60a', '#ff9f0a', '#ff453a', '#ff375f', '#bf5af2', '#a2845e']
const DEFAULT_ACCENT = SWATCHES[0]
const HEX = /^#[0-9a-f]{6}$/i

function schemeLabel(t: ThemeDef): string {
  return t.scheme === 'dark' ? 'Dark' : t.scheme === 'light' ? 'Light' : 'Auto'
}

function ThemePicker() {
  const [themeId, setTheme] = useSettingValue<string>('ui.theme', 'liquid-glass')
  return (
    <div className="set-tiles" role="radiogroup" aria-label="Theme">
      {BUILTIN_THEMES.map((t) => {
        const on = t.id === themeId || (!BUILTIN_THEMES.some((b) => b.id === themeId) && t.id === 'liquid-glass')
        return (
          <button key={t.id} role="radio" aria-checked={on} className={cx('set-tile', on && 'on')} onClick={() => setTheme(t.id)}>
            <div className="set-tile-top">
              <span className="set-tile-name">{t.name}</span>
              {on && <Icon name="check" size={14} className="set-tile-check" />}
            </div>
            <div className="set-tile-desc">{THEME_DESC[t.id] ?? (t.artTint === false ? 'Fixed accent color.' : 'Tinted by album art.')}</div>
            <div className="set-tile-tags">
              <span className="chip">{schemeLabel(t)}</span>
              {t.maxTier && <span className="chip">Up to {TIER_INFO[t.maxTier].label}</span>}
            </div>
          </button>
        )
      })}
    </div>
  )
}

function TierPicker() {
  const [tier, setTier] = useSettingValue<Tier | 'auto'>('ui.tier', 'auto')
  const [themeId] = useSettingValue<string>('ui.theme', 'liquid-glass')
  const resolved = useHtmlAttr('data-tier') as Tier | null
  const theme = BUILTIN_THEMES.find((t) => t.id === themeId)
  const options: Array<Tier | 'auto'> = ['auto', ...TIERS]
  return (
    <>
      <div className="set-radios" role="radiogroup" aria-label="Visual effects">
        {options.map((o) => (
          <label key={o} className={cx('set-radio', tier === o && 'on')}>
            <input type="radio" name="ui-tier" checked={tier === o} onChange={() => setTier(o)} />
            <span className="set-radio-dot" aria-hidden />
            <span className="grow">
              <span className="set-radio-label">
                {TIER_INFO[o].label}
                {o === 'auto' && tier === 'auto' && resolved && TIER_INFO[resolved] && <span className="faint"> — using {TIER_INFO[resolved].label}</span>}
              </span>
              <span className="set-radio-desc">{TIER_INFO[o].desc}</span>
            </span>
          </label>
        ))}
      </div>
      {theme?.maxTier && (
        <p className="set-callout">
          <Icon name="info" size={13} /> {theme.name} limits effects to {TIER_INFO[theme.maxTier].label}.
        </p>
      )}
    </>
  )
}

function AccentPicker() {
  const [accent, setAccent] = useSettingValue<string>('ui.accent', 'art')
  const fixed = accent !== 'art' && HEX.test(accent)
  const [hex, setHex] = useState(fixed ? accent : DEFAULT_ACCENT)
  const commitTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    if (fixed) setHex(accent)
  }, [accent, fixed])
  useEffect(() => () => void (commitTimer.current && clearTimeout(commitTimer.current)), [])
  return (
    <>
      <Row label="Accent color" desc={fixed ? 'Buttons, selections and highlights use this color.' : 'Buttons and highlights pick up the dominant color of the current album’s artwork.'}>
        <Segmented<'art' | 'fixed'>
          value={fixed ? 'fixed' : 'art'}
          options={[
            { value: 'art', label: 'From Artwork' },
            { value: 'fixed', label: 'Fixed' },
          ]}
          onChange={(v) => setAccent(v === 'art' ? 'art' : hex)}
        />
      </Row>
      {fixed && (
        <div className="set-accent">
          <div className="set-swatches" role="radiogroup" aria-label="Accent presets">
            {SWATCHES.map((c) => (
              <button
                key={c}
                role="radio"
                aria-checked={accent.toLowerCase() === c}
                aria-label={c}
                className={cx('set-swatch', accent.toLowerCase() === c && 'on')}
                style={{ background: c }}
                onClick={() => setAccent(c)}
              />
            ))}
          </div>
          <label className="set-color" title="Custom color">
            <input
              type="color"
              value={hex}
              aria-label="Custom accent color"
              onChange={(e) => {
                const v = e.target.value
                setHex(v)
                // The picker streams values while dragging; persist once it settles.
                if (commitTimer.current) clearTimeout(commitTimer.current)
                commitTimer.current = setTimeout(() => HEX.test(v) && setAccent(v.toLowerCase()), 350)
              }}
            />
            <span className="mono">{hex.toUpperCase()}</span>
          </label>
        </div>
      )}
    </>
  )
}

export function AppearanceSection() {
  return (
    <>
      <SectionHead icon="smart" title="Appearance">
        Pick a look, then trade effects for battery or speed. Changes apply immediately.
      </SectionHead>
      <Card title="Theme">
        <ThemePicker />
      </Card>
      <Card title="Visual effects">
        <TierPicker />
      </Card>
      <Card>
        <AccentPicker />
      </Card>
      <Card title="Windows">
        {window.valence.platform !== 'darwin' && (
          <ToggleRow k="ui.closeToTray" fallback={false} label="Keep playing when the window is closed" desc="Closing the window hides Valence in the tray instead of quitting. Quit from the tray menu." />
        )}
        <ToggleRow k="ui.mini.onTop" fallback={true} label="Mini player stays on top" desc="Open it from the player bar, the tray, or Ctrl+Alt+M (⌘⌥M on a Mac)." />
      </Card>
    </>
  )
}
