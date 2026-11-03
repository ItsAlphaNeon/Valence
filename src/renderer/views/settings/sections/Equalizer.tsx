// 10-band graphic EQ: vertical band sliders over a smooth response curve.

import { useRef, useState } from 'react'
import { cx } from '../../../lib/format'
import { cmd } from '../../../state/player'
import { EQ_FREQS, EQ_PRESET_NAMES, type EqPresetName, type EqState } from '../../../audio'
import { Button } from '../../../components/ui'
import { Row, Select, Toggle } from '../controls'

const MAX_DB = 12
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
const snap = (v: number) => Math.round(v * 2) / 2
const fmtFreq = (f: number) => (f >= 1000 ? `${f / 1000}k` : String(f))
const fmtDb = (g: number) => (g === 0 ? '0' : `${g > 0 ? '+' : '−'}${Math.abs(g).toFixed(Number.isInteger(g) ? 0 : 1)}`)

/** Catmull-Rom spline through the points, as an SVG cubic path. */
function smoothPath(pts: Array<[number, number]>): string {
  if (!pts.length) return ''
  let d = `M ${pts[0][0]} ${pts[0][1]}`
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)]
    const p1 = pts[i]
    const p2 = pts[i + 1]
    const p3 = pts[Math.min(pts.length - 1, i + 2)]
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6]
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6]
    d += ` C ${c1[0]} ${c1[1]}, ${c2[0]} ${c2[1]}, ${p2[0]} ${p2[1]}`
  }
  return d
}

const yOf = (g: number) => (1 - (g + MAX_DB) / (2 * MAX_DB)) * 100

function Band({ freq, value, onChange, onCommit }: { freq: number; value: number; onChange: (v: number) => void; onCommit: (v: number) => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const [drag, setDrag] = useState<number | null>(null)
  const last = useRef<number | null>(null)
  const v = drag ?? value
  const pct = ((v + MAX_DB) / (2 * MAX_DB)) * 100
  const at = (clientY: number) => {
    const r = ref.current!.getBoundingClientRect()
    return snap(clamp((1 - (clientY - r.top) / r.height) * 2 * MAX_DB - MAX_DB, -MAX_DB, MAX_DB))
  }
  const move = (nv: number) => {
    setDrag(nv)
    if (last.current !== nv) {
      last.current = nv
      onChange(nv)
    }
  }
  return (
    <div
      ref={ref}
      className={cx('eq-band', drag != null && 'dragging')}
      role="slider"
      tabIndex={0}
      aria-label={`${fmtFreq(freq)} Hz`}
      aria-orientation="vertical"
      aria-valuemin={-MAX_DB}
      aria-valuemax={MAX_DB}
      aria-valuenow={v}
      aria-valuetext={`${fmtDb(v)} dB`}
      title={`${fmtFreq(freq)} Hz: ${fmtDb(v)} dB — double-click to reset`}
      onPointerDown={(e) => {
        ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
        last.current = null
        move(at(e.clientY))
      }}
      onPointerMove={(e) => drag != null && move(at(e.clientY))}
      onPointerUp={(e) => {
        if (drag == null) return
        const nv = at(e.clientY)
        setDrag(null)
        onCommit(nv)
      }}
      onPointerCancel={() => setDrag(null)}
      onDoubleClick={() => onCommit(0)}
      onKeyDown={(e) => {
        const step = e.shiftKey ? 3 : 0.5
        if (e.key === 'ArrowUp' || e.key === 'ArrowRight') onCommit(clamp(value + step, -MAX_DB, MAX_DB))
        else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') onCommit(clamp(value - step, -MAX_DB, MAX_DB))
        else if (e.key === 'Home' || e.key === '0') onCommit(0)
        else return
        e.preventDefault()
      }}
    >
      <div className="eq-track">
        <div className="eq-fill" style={{ bottom: `${Math.min(pct, 50)}%`, height: `${Math.abs(pct - 50)}%` }} />
      </div>
      <div className="eq-thumb" style={{ bottom: `${pct}%` }} />
    </div>
  )
}

export function Equalizer({ eq }: { eq: EqState }) {
  const [live, setLive] = useState<Record<number, number>>({})
  const gains = eq.gains.map((g, i) => live[i] ?? g)
  const presetOptions: Array<{ value: EqPresetName; label: string }> = [...EQ_PRESET_NAMES.map((p) => ({ value: p as EqPresetName, label: p })), ...(eq.preset === 'Custom' ? [{ value: 'Custom' as EqPresetName, label: 'Custom' }] : [])]
  const setBand = (index: number, gainDb: number) => {
    if (!eq.enabled) cmd({ type: 'setEq', eq: { enabled: true } })
    cmd({ type: 'setEqBand', index, gainDb })
  }
  const pts = gains.map((g, i): [number, number] => [((i + 0.5) / gains.length) * 100, yOf(g)])
  const line = smoothPath(pts)
  const area = `${line} L ${pts[pts.length - 1][0]} 50 L ${pts[0][0]} 50 Z`
  return (
    <>
      <Row label="Equalizer" desc="Shape the sound with ten bands. Positive gain engages a limiter so peaks never clip.">
        <Toggle checked={eq.enabled} onChange={(enabled) => cmd({ type: 'setEq', eq: { enabled } })} label="Equalizer" />
      </Row>
      <Row label="Preset">
        <div className="row">
          <Select value={eq.preset} options={presetOptions} onChange={(preset) => cmd({ type: 'setEqPreset', preset })} ariaLabel="EQ preset" />
          <Button small kind="ghost" onClick={() => cmd({ type: 'setEqPreset', preset: 'Flat' })} disabled={eq.gains.every((g) => g === 0)}>
            Reset
          </Button>
        </div>
      </Row>
      <div className={cx('eq', !eq.enabled && 'off')}>
        <div className="eq-scale" aria-hidden>
          <span>+12</span>
          <span>0</span>
          <span>−12</span>
        </div>
        <div className="eq-main">
          <div className="eq-labels tnum" aria-hidden>
            {gains.map((g, i) => (
              <span key={i}>{fmtDb(g)}</span>
            ))}
          </div>
          <div className="eq-tracks">
            <div className="eq-zero" />
            <svg className="eq-curve" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden>
              <path className="eq-area" d={area} />
              <path className="eq-line" d={line} vectorEffect="non-scaling-stroke" />
            </svg>
            {EQ_FREQS.map((f, i) => (
              <Band
                key={f}
                freq={f}
                value={gains[i]}
                onChange={(v) => {
                  setLive((l) => ({ ...l, [i]: v }))
                  setBand(i, v)
                }}
                onCommit={(v) => {
                  setLive((l) => {
                    const n = { ...l }
                    delete n[i]
                    return n
                  })
                  setBand(i, v)
                }}
              />
            ))}
          </div>
          <div className="eq-labels faint" aria-hidden>
            {EQ_FREQS.map((f) => (
              <span key={f}>{fmtFreq(f)}</span>
            ))}
          </div>
        </div>
      </div>
    </>
  )
}
