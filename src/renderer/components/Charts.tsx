// Small, quiet single-series charts for Listening Stats: columns that grow from one baseline, a hover
// and keyboard readout, and a table view so no value is hover-only. Marks use the (contrast-adjusted)
// accent; all text stays in text colors.

import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { cx } from '../lib/format'

export interface Datum {
  label: string
  value: number
  /** Tooltip / table detail under the value. */
  detail?: string
}

const AXIS_W = 40
const BASE_H = 22
const GAP = 2
const MAX_BAR = 24

function niceStep(max: number, ticks = 4): number {
  if (max <= 0) return 1
  const raw = max / ticks
  const p = 10 ** Math.floor(Math.log10(raw))
  const n = raw / p
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p
}

export const compact = (n: number): string =>
  n >= 10_000 ? new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(n) : n.toLocaleString()

/** Column path with a 4px rounded data-end and a square baseline. */
function column(x: number, y: number, w: number, h: number): string {
  const r = Math.min(4, w / 2, h)
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`
}

export function ColumnChart({
  data,
  height = 180,
  unit,
  xLabel,
  title,
  minBar = 1,
}: {
  data: Datum[]
  height?: number
  /** Value suffix in the readout ("plays"). */
  unit: string
  /** Which x labels to print (sparse); default every label. */
  xLabel?: (d: Datum, i: number) => string | null
  /** Accessible name. */
  title: string
  minBar?: number
}) {
  const wrap = useRef<HTMLDivElement>(null)
  const [w, setW] = useState(600)
  const [active, setActive] = useState<number | null>(null)
  const [table, setTable] = useState(false)
  useLayoutEffect(() => {
    const el = wrap.current
    if (!el) return
    const ro = new ResizeObserver(() => setW(el.clientWidth))
    ro.observe(el)
    setW(el.clientWidth)
    return () => ro.disconnect()
  }, [table])
  const max = Math.max(0, ...data.map((d) => d.value))
  const step = niceStep(max)
  const top = Math.max(step, Math.ceil(max / step) * step)
  const ticks = useMemo(() => Array.from({ length: Math.round(top / step) + 1 }, (_, i) => i * step), [top, step])
  const plotW = Math.max(10, w - AXIS_W)
  const plotH = height - BASE_H
  const slot = plotW / Math.max(1, data.length)
  const bar = Math.max(minBar, Math.min(MAX_BAR, slot - GAP))
  const y = (v: number) => plotH - (v / top) * plotH
  const at = (i: number) => AXIS_W + i * slot + (slot - bar) / 2

  const onMove = (e: React.PointerEvent) => {
    const r = e.currentTarget.getBoundingClientRect()
    const i = Math.floor((e.clientX - r.left - AXIS_W) / slot)
    setActive(i >= 0 && i < data.length ? i : null)
  }
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight' && e.key !== 'Home' && e.key !== 'End') return
    e.preventDefault()
    e.stopPropagation()
    const last = data.length - 1
    setActive((a) => (e.key === 'Home' ? 0 : e.key === 'End' ? last : a == null ? last : Math.max(0, Math.min(last, a + (e.key === 'ArrowLeft' ? -1 : 1)))))
  }
  const cur = active != null ? data[active] : null
  const tipLeft = active != null ? Math.min(Math.max(at(active) + bar / 2, 70), w - 70) : 0

  return (
    <div className="chart">
      <button className="chart-mode" onClick={() => setTable(!table)} aria-pressed={table}>
        {table ? 'Chart' : 'Table'}
      </button>
      {table ? (
        <div className="chart-table-wrap">
          <table className="chart-table">
            <thead>
              <tr>
                <th>{title}</th>
                <th className="num">{unit[0].toUpperCase() + unit.slice(1)}</th>
              </tr>
            </thead>
            <tbody>
              {data.map((d) => (
                <tr key={d.label}>
                  <td>{d.label}</td>
                  <td className="num">
                    {d.value.toLocaleString()}
                    {d.detail && <span className="faint"> · {d.detail}</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div
          ref={wrap}
          className="chart-plot"
          tabIndex={0}
          role="img"
          aria-label={`${title}. Use the arrow keys to read values.`}
          onPointerMove={onMove}
          onPointerLeave={() => setActive(null)}
          onKeyDown={onKey}
          onBlur={() => setActive(null)}
        >
          <svg width={w} height={height} aria-hidden>
            {ticks.map((t) => (
              <g key={t}>
                <line className="chart-grid" x1={AXIS_W} x2={w} y1={Math.round(y(t)) + 0.5} y2={Math.round(y(t)) + 0.5} />
                <text className="chart-tick" x={AXIS_W - 8} y={y(t)} dy="0.32em" textAnchor="end">
                  {compact(t)}
                </text>
              </g>
            ))}
            {data.map((d, i) =>
              d.value > 0 ? <path key={i} className={cx('chart-bar', active === i && 'on', active != null && active !== i && 'dim')} d={column(at(i), y(d.value), bar, plotH - y(d.value))} /> : null,
            )}
            {active != null && <rect className="chart-hover" x={AXIS_W + active * slot} y={0} width={slot} height={plotH} />}
            {data.map((d, i) => {
              const l = xLabel ? xLabel(d, i) : d.label
              return l ? (
                <text key={i} className="chart-tick" x={at(i) + bar / 2} y={plotH + 15} textAnchor="middle">
                  {l}
                </text>
              ) : null
            })}
          </svg>
          {cur && (
            <div className="chart-tip" style={{ left: tipLeft, top: Math.max(0, y(cur.value) - 8) }}>
              <b>
                {cur.value.toLocaleString()} {cur.value === 1 ? unit.replace(/s$/, '') : unit}
              </b>
              <span>{cur.label}</span>
              {cur.detail && <span className="faint">{cur.detail}</span>}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/** A thin magnitude bar for ranked lists (share of the leader). */
export function Meter({ value, max }: { value: number; max: number }) {
  return (
    <span className="meter" aria-hidden>
      <i style={{ width: `${max > 0 ? Math.max(2, (value / max) * 100) : 0}%` }} />
    </span>
  )
}

export function StatTile({ label, value, sub }: { label: string; value: ReactNode; sub?: ReactNode }) {
  return (
    <div className="stat-tile">
      <span className="stat-label">{label}</span>
      <span className="stat-value">{value}</span>
      {sub && <span className="stat-sub">{sub}</span>}
    </div>
  )
}
