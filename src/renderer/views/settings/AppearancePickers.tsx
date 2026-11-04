// Palette, accent and album-color pickers shared by Settings → Appearance and the welcome tour.

import { useEffect, useRef, useState } from 'react'
import { cx } from '../../lib/format'
import { useLib, useSetting } from '../../state/library'
import { ACCENTS, accentHex, artThemeSetting, type ArtTheme } from '../../theme/accent'
import { findTheme, useThemes, type ThemeDef } from '../../theme/themes'
import { Icon } from '../../components/Icon'

const HEX = /^#[0-9a-f]{6}$/i

function Preview({ t }: { t: ThemeDef }) {
  const p = t.preview
  if (!p)
    return (
      <span className="theme-swatch-preview custom">
        <Icon name="sliders" size={18} />
      </span>
    )
  return (
    <span className="theme-swatch-preview" style={{ background: p[0] }}>
      <i style={{ background: p[1] }} />
      <i style={{ background: p[2] }} />
      <b style={{ background: p[3] }} />
    </span>
  )
}

export function PalettePicker({ withUser = true }: { withUser?: boolean }) {
  const [theme, setTheme] = useSetting<string>('ui.theme', 'dark')
  const { themes } = useThemes()
  const active = findTheme(theme).id
  const list = withUser ? themes : themes.filter((t) => !t.file)
  return (
    <div className="theme-swatches" role="radiogroup" aria-label="Palette">
      {list.map((t) => (
        <button key={t.id} role="radio" aria-checked={active === t.id} className={cx('theme-swatch', active === t.id && 'on')} onClick={() => setTheme(t.id)} title={t.description}>
          <Preview t={t} />
          <span className="theme-swatch-name">
            {t.name}
            {t.file && <span className="chip">Yours</span>}
          </span>
        </button>
      ))}
    </div>
  )
}

export function AccentPicker({ custom = true }: { custom?: boolean }) {
  const [accent, setAccent] = useSetting<string>('ui.accent', ACCENTS[0].id)
  const preset = ACCENTS.find((a) => a.id === accent || a.hex === String(accent).toLowerCase())
  const isCustom = !preset && HEX.test(String(accent))
  const [hex, setHex] = useState(() => accentHex(accent))
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => setHex(accentHex(accent)), [accent])
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), [])
  return (
    <div className="accent-swatches" role="radiogroup" aria-label="Accent color">
      {ACCENTS.map((a) => (
        <button
          key={a.id}
          role="radio"
          aria-checked={preset?.id === a.id}
          aria-label={`${a.name}, ${a.note}`}
          className={cx('accent-swatch', preset?.id === a.id && 'on')}
          style={{ background: a.hex }}
          title={`${a.name} · ${a.note}`}
          onClick={() => setAccent(a.id)}
        />
      ))}
      {custom && (
        <label className={cx('accent-swatch custom', isCustom && 'on')} title="Pick any color" style={isCustom ? { background: hex } : undefined}>
          <input
            type="color"
            value={hex}
            aria-label="Custom accent color"
            onChange={(e) => {
              const v = e.target.value
              setHex(v)
              // The picker streams values while dragging; save once it settles.
              if (timer.current) clearTimeout(timer.current)
              timer.current = setTimeout(() => HEX.test(v) && setAccent(v.toLowerCase()), 300)
            }}
          />
          {!isCustom && <Icon name="plus" size={14} />}
        </label>
      )}
    </div>
  )
}

const ART_CHOICES: Array<[ArtTheme, string, string]> = [
  ['off', 'Off', 'Always your accent color'],
  ['accent', 'Accent', 'Buttons and highlights follow the album'],
  ['full', 'Everything', 'The whole window takes on the album’s colors'],
]

export function ArtThemePicker() {
  const all = useLib((s) => s.settings)
  const [, setArt] = useSetting<ArtTheme>('ui.artTheme', 'accent')
  const art = artThemeSetting(all)
  return (
    <div className="choice-row" role="radiogroup" aria-label="Album art colors">
      {ART_CHOICES.map(([v, label, sub]) => (
        <button key={v} role="radio" aria-checked={art === v} className={cx('choice', art === v && 'on', `art-${v}`)} onClick={() => setArt(v)}>
          <span className="choice-demo" aria-hidden>
            <i />
            <b />
          </span>
          <span className="strong">{label}</span>
          <span className="faint small">{sub}</span>
        </button>
      ))}
    </div>
  )
}
