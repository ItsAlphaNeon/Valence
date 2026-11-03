// Building blocks for the Settings sections: rows, toggles and inputs that persist on change.

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { invoke, errorMessage } from '../../lib/ipc'
import { cx } from '../../lib/format'
import { useLib } from '../../state/library'
import { toast } from '../../state/ui'
import { SETTINGS, type AppInfo } from '@shared/ipc/settings'
import { Button } from '../../components/ui'
import { Icon, type IconName } from '../../components/Icon'

/** Like useSetting, but reports IPC failures (and rolls the mirror back) instead of rejecting silently. */
export function useSettingValue<T>(key: string, fallback: T): [T, (v: T) => void] {
  const raw = useLib((s) => s.settings[key])
  const value = raw === undefined || raw === null ? fallback : (raw as T)
  const set = (nv: T) => {
    const prev = useLib.getState().settings[key]
    useLib.setState((s) => ({ settings: { ...s.settings, [key]: nv } }))
    invoke(SETTINGS.set, key, nv).catch((e) => {
      useLib.setState((s) => ({ settings: { ...s.settings, [key]: prev } }))
      toast(`Couldn’t save setting: ${errorMessage(e)}`, 'error')
    })
  }
  return [value, set]
}

let appInfoPromise: Promise<AppInfo> | null = null

/** AppInfo rarely changes during a session; fetch once and share. `refresh` re-fetches. */
export function useAppInfo(): { info: AppInfo | null; refresh: () => void } {
  const [info, setInfo] = useState<AppInfo | null>(null)
  const [tick, setTick] = useState(0)
  useEffect(() => {
    let live = true
    appInfoPromise ??= invoke<AppInfo>(SETTINGS.appInfo)
    appInfoPromise.then(
      (i) => live && setInfo(i),
      (e) => {
        appInfoPromise = null
        if (live) toast(`Couldn’t read app info: ${errorMessage(e)}`, 'error')
      },
    )
    return () => {
      live = false
    }
  }, [tick])
  return {
    info,
    refresh: () => {
      appInfoPromise = null
      setTick((t) => t + 1)
    },
  }
}

export async function openPath(p: string | null | undefined): Promise<void> {
  if (!p) return
  try {
    // shell.openPath resolves to an error string ('' on success).
    const err = await invoke<string>(SETTINGS.openPath, p)
    if (err) toast(err, 'error')
  } catch (e) {
    toast(errorMessage(e), 'error')
  }
}

/** A link to a setup page, opened in the default browser. */
export function ExternalLink({ href }: { href: string }) {
  return (
    <a
      className="mono"
      href={href}
      onClick={(e) => {
        e.preventDefault()
        invoke(SETTINGS.openExternal, href).catch((err) => toast(errorMessage(err), 'error'))
      }}
    >
      {href.slice('https://'.length)}
    </a>
  )
}

export const REVEAL_LABEL = window.valence?.platform === 'darwin' ? 'Show in Finder' : window.valence?.platform === 'win32' ? 'Show in Explorer' : 'Open Folder'

// ---- Layout ----

export function SectionHead({ icon, title, children }: { icon: IconName; title: string; children?: ReactNode }) {
  return (
    <header className="set-head">
      <div className="set-head-icon">
        <Icon name={icon} size={20} />
      </div>
      <div className="grow">
        <h2 className="set-head-title">{title}</h2>
        {children && <p className="set-head-lede">{children}</p>}
      </div>
    </header>
  )
}

export function Card({ title, aside, children, className }: { title?: ReactNode; aside?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cx('card glass set-card', className)}>
      {(title || aside) && (
        <div className="set-card-head">
          {title && <h3>{title}</h3>}
          {aside && <div className="set-card-aside">{aside}</div>}
        </div>
      )}
      {children}
    </section>
  )
}

export function Row({ label, desc, children, className, top }: { label: ReactNode; desc?: ReactNode; children?: ReactNode; className?: string; top?: boolean }) {
  return (
    <div className={cx('setting-row', top && 'set-row-top', className)}>
      <div className="setting-text">
        <div className="setting-label">{label}</div>
        {desc && <div className="setting-desc">{desc}</div>}
      </div>
      {children !== undefined && <div className="set-control">{children}</div>}
    </div>
  )
}

/** Full-width row: label on top, control below (for long inputs). */
export function StackRow({ label, desc, children, className }: { label: ReactNode; desc?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={cx('setting-row set-row-stack', className)}>
      <div className="setting-text">
        <div className="setting-label">{label}</div>
        {desc && <div className="setting-desc">{desc}</div>}
      </div>
      <div className="set-stack-control">{children}</div>
    </div>
  )
}

export function Toggle({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label?: string; disabled?: boolean }) {
  return <input type="checkbox" className="toggle" checked={checked} disabled={disabled} aria-label={label} onChange={(e) => onChange(e.target.checked)} />
}

export function ToggleRow({ k, fallback, label, desc, note }: { k: string; fallback: boolean; label: ReactNode; desc?: ReactNode; note?: ReactNode }) {
  const [v, set] = useSettingValue<boolean>(k, fallback)
  return (
    <Row
      label={label}
      desc={
        desc || note ? (
          <>
            {desc}
            {note && <span className="set-note">{note}</span>}
          </>
        ) : undefined
      }
    >
      <Toggle checked={!!v} onChange={set} label={typeof label === 'string' ? label : undefined} />
    </Row>
  )
}

/** A brief "Saved" tick after a commit. */
function useSavedFlash(): [boolean, () => void] {
  const [on, setOn] = useState(false)
  const t = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => void (t.current && clearTimeout(t.current)), [])
  return [
    on,
    () => {
      setOn(true)
      if (t.current) clearTimeout(t.current)
      t.current = setTimeout(() => setOn(false), 1600)
    },
  ]
}

/**
 * Text input that commits on blur or Enter (Escape reverts). `validate` returns an error message
 * to reject the draft. Re-syncs from `value` while not being edited.
 */
export function CommitInput({
  value,
  onCommit,
  placeholder,
  type = 'text',
  mono,
  className,
  validate,
  normalize,
  width,
  ariaLabel,
  onDraft,
}: {
  value: string
  onCommit: (v: string) => void
  placeholder?: string
  type?: 'text' | 'password' | 'number' | 'url'
  mono?: boolean
  className?: string
  validate?: (v: string) => string | null
  normalize?: (v: string) => string
  width?: number | string
  ariaLabel?: string
  onDraft?: (v: string) => void
}) {
  const [draft, setDraft] = useState(value)
  const editing = useRef(false)
  const cancel = useRef(false)
  const [saved, flash] = useSavedFlash()
  useEffect(() => {
    if (!editing.current) setDraft(value)
  }, [value])
  const commit = (raw: string) => {
    const v = normalize ? normalize(raw) : raw.trim()
    if (v === value) {
      setDraft(value)
      return
    }
    const err = validate?.(v)
    if (err) {
      toast(err, 'error')
      setDraft(value)
      onDraft?.(value)
      return
    }
    setDraft(v)
    onCommit(v)
    flash()
  }
  return (
    <span className={cx('set-input', className)} style={{ width }}>
      <input
        type={type}
        className={cx(mono && 'mono')}
        value={draft}
        placeholder={placeholder}
        aria-label={ariaLabel}
        spellCheck={false}
        autoComplete="off"
        onFocus={() => (editing.current = true)}
        onChange={(e) => {
          setDraft(e.target.value)
          onDraft?.(e.target.value)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur()
          else if (e.key === 'Escape') {
            cancel.current = true
            e.currentTarget.blur()
          }
        }}
        onBlur={(e) => {
          editing.current = false
          if (cancel.current) {
            cancel.current = false
            setDraft(value)
            onDraft?.(value)
            return
          }
          commit(e.currentTarget.value)
        }}
      />
      <span className={cx('set-saved', saved && 'on')} aria-hidden>
        <Icon name="check" size={13} />
      </span>
    </span>
  )
}

/** CommitInput bound to a string setting. Empty input stores `emptyValue` (default ''). */
export function TextSetting({
  k,
  fallback = '',
  emptyValue = '',
  ...rest
}: { k: string; fallback?: string; emptyValue?: string | null } & Omit<Parameters<typeof CommitInput>[0], 'value' | 'onCommit'>) {
  const [v, set] = useSettingValue<string | null>(k, fallback)
  return <CommitInput {...rest} value={v ?? ''} onCommit={(nv) => set((nv === '' ? emptyValue : nv) as string | null)} />
}

export function Select<T extends string>({ value, options, onChange, ariaLabel, className }: { value: T; options: Array<{ value: T; label: string }>; onChange: (v: T) => void; ariaLabel?: string; className?: string }) {
  return (
    <select className={cx('set-select', className)} value={value} aria-label={ariaLabel} onChange={(e) => onChange(e.target.value as T)}>
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  )
}

/** A folder path line with an optional open button. */
export function PathLine({ path, empty, openLabel = REVEAL_LABEL, onOpen }: { path: string | null | undefined; empty?: ReactNode; openLabel?: string; onOpen?: () => void }) {
  return (
    <div className="set-path">
      <Icon name="folder" size={16} className="set-path-icon" />
      {path ? (
        <span className="mono set-path-text selectable" title={path}>
          {path}
        </span>
      ) : (
        <span className="faint set-path-text">{empty ?? 'Not set'}</span>
      )}
      {path && (
        <Button small kind="ghost" onClick={onOpen ?? (() => void openPath(path))}>
          {openLabel}
        </Button>
      )}
    </div>
  )
}

export function Stat({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="set-stat">
      <div className="set-stat-value tnum">{value}</div>
      <div className="set-stat-label">{label}</div>
    </div>
  )
}

/** Collapsible "Advanced" block. */
export function Disclosure({ title, children, defaultOpen }: { title: ReactNode; children: ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(!!defaultOpen)
  return (
    <div className={cx('set-disclosure', open && 'open')}>
      <button className="set-disclosure-btn" onClick={() => setOpen(!open)} aria-expanded={open}>
        <Icon name="chevronRight" size={12} />
        <span>{title}</span>
      </button>
      {open && <div className="set-disclosure-body">{children}</div>}
    </div>
  )
}

/** Mirrors an attribute on <html> (e.g. the tier the shell resolved). */
export function useHtmlAttr(name: string): string | null {
  const [v, setV] = useState(() => document.documentElement.getAttribute(name))
  useEffect(() => {
    const el = document.documentElement
    const mo = new MutationObserver(() => setV(el.getAttribute(name)))
    mo.observe(el, { attributes: true, attributeFilter: [name] })
    setV(el.getAttribute(name))
    return () => mo.disconnect()
  }, [name])
  return v
}
