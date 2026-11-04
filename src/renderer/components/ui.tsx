// Small shared UI primitives.

import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Icon, type IconName } from './Icon'
import { artUrl } from '../lib/ipc'
import { cx } from '../lib/format'
import type { InLibraryBadge } from '@shared/types'

export function Artwork({
  hash,
  url,
  size,
  px = 300,
  radius,
  title,
  className,
  style,
}: {
  hash?: string | null
  url?: string | null
  size?: number | string
  px?: number
  radius?: number
  title?: string
  className?: string
  style?: CSSProperties
}) {
  const [failed, setFailed] = useState(false)
  const src = url ?? artUrl(hash, px)
  useEffect(() => setFailed(false), [src])
  const s: CSSProperties = { width: size, height: size, borderRadius: radius, ...style }
  if (!src || failed) {
    const letter = (title ?? '').trim().charAt(0).toUpperCase() || '♪'
    let h = 0
    for (const c of title ?? '') h = (h * 31 + c.charCodeAt(0)) % 360
    return (
      <div className={cx('art art-empty', className)} style={{ ...s, background: `linear-gradient(135deg, hsl(${h} 45% 58%), hsl(${(h + 40) % 360} 50% 38%))` }}>
        <span>{letter}</span>
      </div>
    )
  }
  return <img className={cx('art', className)} style={s} src={src} alt="" draggable={false} loading="lazy" decoding="async" onError={() => setFailed(true)} />
}

export function Button({
  children,
  onClick,
  kind = 'default',
  icon,
  disabled,
  title,
  className,
  small,
}: {
  children?: ReactNode
  onClick?: (e: React.MouseEvent) => void
  kind?: 'default' | 'primary' | 'ghost' | 'danger'
  icon?: IconName
  disabled?: boolean
  title?: string
  className?: string
  small?: boolean
}) {
  return (
    <button className={cx('btn', `btn-${kind}`, small && 'btn-sm', className)} onClick={onClick} disabled={disabled} title={title}>
      {icon && <Icon name={icon} size={small ? 14 : 16} />}
      {children && <span>{children}</span>}
    </button>
  )
}

export function IconButton({
  icon,
  onClick,
  title,
  active,
  size = 18,
  className,
  disabled,
  filled,
}: {
  icon: IconName
  onClick?: (e: React.MouseEvent) => void
  title?: string
  active?: boolean
  size?: number
  className?: string
  disabled?: boolean
  filled?: boolean
}) {
  return (
    <button className={cx('icon-btn', active && 'active', className)} onClick={onClick} title={title} aria-label={title} disabled={disabled}>
      <Icon name={icon} size={size} filled={filled} />
    </button>
  )
}

/** Horizontal slider (seek/volume). Calls onChange while dragging, onCommit on release. */
export function Slider({
  value,
  max,
  onChange,
  onCommit,
  className,
  label,
}: {
  value: number
  max: number
  onChange?: (v: number) => void
  onCommit?: (v: number) => void
  className?: string
  label?: string
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [drag, setDrag] = useState<number | null>(null)
  const v = drag ?? value
  const pct = max > 0 ? Math.min(100, Math.max(0, (v / max) * 100)) : 0
  const at = (clientX: number) => {
    const r = ref.current!.getBoundingClientRect()
    return Math.min(max, Math.max(0, ((clientX - r.left) / r.width) * max))
  }
  return (
    <div
      ref={ref}
      className={cx('slider', drag != null && 'dragging', className)}
      role="slider"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={v}
      tabIndex={0}
      onKeyDown={(e) => {
        const step = max / 50
        if (e.key === 'ArrowRight') onCommit?.(Math.min(max, value + step))
        if (e.key === 'ArrowLeft') onCommit?.(Math.max(0, value - step))
      }}
      onPointerDown={(e) => {
        ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
        const nv = at(e.clientX)
        setDrag(nv)
        onChange?.(nv)
      }}
      onPointerMove={(e) => {
        if (drag == null) return
        const nv = at(e.clientX)
        setDrag(nv)
        onChange?.(nv)
      }}
      onPointerUp={(e) => {
        if (drag == null) return
        const nv = at(e.clientX)
        setDrag(null)
        onCommit?.(nv)
      }}
      onPointerCancel={() => setDrag(null)}
    >
      <div className="slider-track">
        <div className="slider-fill" style={{ width: `${pct}%` }} />
      </div>
      <div className="slider-thumb" style={{ left: `${pct}%` }} />
    </div>
  )
}

export function Segmented<T extends string>({ value, options, onChange, className }: { value: T; options: Array<{ value: T; label: ReactNode }>; onChange: (v: T) => void; className?: string }) {
  const idx = Math.max(0, options.findIndex((o) => o.value === value))
  return (
    <div className={cx('segmented', className)} style={{ ['--n' as string]: options.length, ['--i' as string]: idx }}>
      <div className="segmented-thumb" />
      {options.map((o) => (
        <button key={o.value} className={cx('segmented-opt', o.value === value && 'on')} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  )
}

export function Stars({ rating, onRate, size = 12 }: { rating: number; onRate?: (stars: number) => void; size?: number }) {
  const stars = Math.round((rating ?? 0) / 20)
  const [hover, setHover] = useState<number | null>(null)
  const shown = hover ?? stars
  return (
    <span className={cx('stars', onRate && 'editable')} onMouseLeave={() => setHover(null)}>
      {[1, 2, 3, 4, 5].map((n) => (
        <span
          key={n}
          className={cx('star', n <= shown && 'on')}
          onMouseEnter={() => onRate && setHover(n)}
          onClick={(e) => {
            e.stopPropagation()
            onRate?.(n === stars ? 0 : n)
          }}
        >
          <Icon name="star" size={size} filled={n <= shown} />
        </span>
      ))}
    </span>
  )
}

export function LibraryBadge({ badge, queued, compact }: { badge: InLibraryBadge; queued?: 'queued' | 'running' | null; compact?: boolean }) {
  if (queued) return <span className={cx('badge', 'badge-queued')}>{queued === 'running' ? 'Downloading' : 'Queued'}</span>
  if (badge.status === 'in-library')
    return (
      <span className="badge badge-ok" title="In your library">
        <Icon name="check" size={12} />
        {!compact && 'In Library'}
      </span>
    )
  if (badge.status === 'partial')
    return (
      <span className="badge badge-partial" title={`${badge.have} of ${badge.total} tracks in your library`}>
        ◐ {badge.have}/{badge.total}
      </span>
    )
  return null
}

export function Spinner({ size = 18 }: { size?: number }) {
  return <span className="spinner" style={{ width: size, height: size }} />
}

export function Empty({ icon, title, children }: { icon?: IconName; title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      {icon && <Icon name={icon} size={44} />}
      <h3>{title}</h3>
      {children && <div className="empty-body">{children}</div>}
    </div>
  )
}

export function ProgressBar({ value, indeterminate }: { value: number; indeterminate?: boolean }) {
  return (
    <div className={cx('progress', indeterminate && 'indeterminate')}>
      <div className="progress-fill" style={{ width: `${Math.round(Math.min(1, Math.max(0, value)) * 100)}%` }} />
    </div>
  )
}

// ---- Context menu ----

export interface MenuItem {
  label?: string
  icon?: IconName
  onClick?: () => void
  danger?: boolean
  disabled?: boolean
  separator?: boolean
  submenu?: MenuItem[]
  checked?: boolean
}

let openMenu: ((m: { x: number; y: number; items: MenuItem[] } | null) => void) | null = null

export function showMenu(e: { clientX: number; clientY: number; preventDefault?: () => void; stopPropagation?: () => void }, items: MenuItem[]): void {
  e.preventDefault?.()
  e.stopPropagation?.()
  openMenu?.({ x: e.clientX, y: e.clientY, items })
}

export function MenuHost() {
  const [m, setM] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null)
  useEffect(() => {
    openMenu = setM
    return () => {
      openMenu = null
    }
  }, [])
  useEffect(() => {
    if (!m) return
    const close = () => setM(null)
    const key = (e: KeyboardEvent) => e.key === 'Escape' && close()
    window.addEventListener('pointerdown', close)
    window.addEventListener('blur', close)
    window.addEventListener('keydown', key)
    window.addEventListener('resize', close)
    return () => {
      window.removeEventListener('pointerdown', close)
      window.removeEventListener('blur', close)
      window.removeEventListener('keydown', key)
      window.removeEventListener('resize', close)
    }
  }, [m])
  if (!m) return null
  return createPortal(<MenuList x={m.x} y={m.y} items={m.items} close={() => setM(null)} />, document.body)
}

function MenuList({ x, y, items, close }: { x: number; y: number; items: MenuItem[]; close: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ x, y })
  const [sub, setSub] = useState<{ i: number; x: number; y: number } | null>(null)
  useLayoutEffect(() => {
    const r = ref.current!.getBoundingClientRect()
    setPos({ x: Math.min(x, innerWidth - r.width - 8), y: Math.min(y, innerHeight - r.height - 8) })
  }, [x, y])
  return (
    <div ref={ref} className="menu pop" style={{ left: pos.x, top: pos.y }} onPointerDown={(e) => e.stopPropagation()} onContextMenu={(e) => e.preventDefault()}>
      {items.map((it, i) =>
        it.separator ? (
          <div key={i} className="menu-sep" />
        ) : (
          <button
            key={i}
            className={cx('menu-item', it.danger && 'danger')}
            disabled={it.disabled}
            onMouseEnter={(e) => {
              if (it.submenu) {
                const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
                setSub({ i, x: r.right - 4, y: r.top - 6 })
              } else setSub(null)
            }}
            onClick={() => {
              if (it.submenu) return
              close()
              it.onClick?.()
            }}
          >
            <span className="menu-icon">{it.checked ? <Icon name="check" size={14} /> : it.icon ? <Icon name={it.icon} size={15} /> : null}</span>
            <span className="menu-label">{it.label}</span>
            {it.submenu && <Icon name="chevronRight" size={12} />}
          </button>
        ),
      )}
      {sub && items[sub.i]?.submenu && <MenuList x={sub.x} y={sub.y} items={items[sub.i].submenu!} close={close} />}
    </div>
  )
}

// ---- Modal ----

export function Modal({ title, onClose, children, footer, width = 560, className }: { title: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode; width?: number; className?: string }) {
  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [onClose])
  return createPortal(
    <div className="modal-scrim" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={cx('modal pop', className)} style={{ width }} role="dialog" aria-modal>
        <header className="modal-head">
          <h2>{title}</h2>
          <IconButton icon="close" onClick={onClose} title="Close" />
        </header>
        <div className="modal-body">{children}</div>
        {footer && <footer className="modal-foot">{footer}</footer>}
      </div>
    </div>,
    document.body,
  )
}

/** Prompt for a single line of text. */
export function usePrompt(): [ReactNode, (opts: { title: string; label?: string; initial?: string; ok?: string }) => Promise<string | null>] {
  const [state, setState] = useState<{ title: string; label?: string; initial?: string; ok?: string; resolve: (v: string | null) => void } | null>(null)
  const [text, setText] = useState('')
  const node = state ? (
    <Modal
      title={state.title}
      width={420}
      onClose={() => {
        state.resolve(null)
        setState(null)
      }}
      footer={
        <>
          <Button
            kind="ghost"
            onClick={() => {
              state.resolve(null)
              setState(null)
            }}
          >
            Cancel
          </Button>
          <Button
            kind="primary"
            disabled={!text.trim()}
            onClick={() => {
              state.resolve(text.trim())
              setState(null)
            }}
          >
            {state.ok ?? 'OK'}
          </Button>
        </>
      }
    >
      <label className="field">
        {state.label && <span>{state.label}</span>}
        <input
          autoFocus
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && text.trim()) {
              state.resolve(text.trim())
              setState(null)
            }
          }}
        />
      </label>
    </Modal>
  ) : null
  return [
    node,
    (opts) =>
      new Promise((resolve) => {
        setText(opts.initial ?? '')
        setState({ ...opts, resolve })
      }),
  ]
}
