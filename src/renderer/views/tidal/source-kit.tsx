// Shared building blocks for the source browsers (TIDAL, Bandcamp): live queue state derived from
// import jobs, a remote-data hook, download control, track rows, load-more sentinel, pause banner and
// error states. Lives next to the TIDAL view; BandcampView imports it from here.

import { useContext, useEffect, useLayoutEffect, useRef, useState, useCallback, type ReactNode } from 'react'
import { create } from 'zustand'
import type { JobInfo } from '@shared/ipc/import'
import { IMPORT } from '@shared/ipc/import'
import type { InLibraryBadge } from '@shared/types'
import { SETTINGS } from '@shared/ipc/settings'
import { errorMessage, invoke } from '../../lib/ipc'
import { cx, duration } from '../../lib/format'
import { useLib } from '../../state/library'
import { navigate, toast } from '../../state/ui'
import { Artwork, Button, Empty, IconButton, LibraryBadge, ProgressBar, Spinner } from '../../components/ui'
import { Icon } from '../../components/Icon'
import { ScrollParent } from '../../components/TrackTable'
import {
  activeJobsByKey,
  describeSourceError,
  pendingState,
  PENDING_GRACE_MS,
  type ErrorCopy,
  type PendingDownload,
  type QueueState,
} from './source-helpers'
import './source-kit.css'

export type SourceId = 'tidal' | 'bandcamp'
export const SOURCE_LABEL: Record<SourceId, string> = { tidal: 'TIDAL', bandcamp: 'Bandcamp' }
export const MISSING_BADGE: InLibraryBadge = { status: 'missing', have: 0, total: 0 }
export const trackBadge = (inLibrary: boolean): InLibraryBadge => (inLibrary ? { status: 'in-library', have: 1, total: 1 } : MISSING_BADGE)

// ---- Live queue index (import jobs + downloads requested from this window) ----

type Entry = JobInfo | QueueState
interface QueueIndex {
  byKey: Map<string, Entry>
  hasJobs: boolean
}

const useQueueIndex = create<QueueIndex>(() => ({ byKey: new Map(), hasJobs: false }))
let pending: PendingDownload[] = []
let expiry: ReturnType<typeof setTimeout> | null = null
const stateOf = (e: Entry): QueueState => (typeof e === 'string' ? e : (e.status as QueueState))

function rebuild(): void {
  const jobs = useLib.getState().jobs
  const now = Date.now()
  const byKey = new Map<string, Entry>(activeJobsByKey(jobs))
  // Forget requests whose jobs finished (or never showed up) once they no longer resolve to a state.
  pending = pending.filter((p) => pendingState(p, jobs, now) !== null)
  let nextExpiry = Infinity
  for (const p of pending) {
    const st = pendingState(p, jobs, now)!
    const job = p.jobIds.map((id) => jobs.find((j) => j.id === id)).find((j) => j && (j.status === 'running' || j.status === 'queued'))
    if (!job) nextExpiry = Math.min(nextExpiry, p.at + PENDING_GRACE_MS - now)
    for (const k of p.keys) {
      const cur = byKey.get(k)
      if (!cur || (st === 'running' && stateOf(cur) !== 'running')) byKey.set(k, job ?? st)
    }
  }
  useQueueIndex.setState({ byKey, hasJobs: jobs.length > 0 })
  if (expiry) clearTimeout(expiry)
  expiry = Number.isFinite(nextExpiry) ? setTimeout(rebuild, Math.max(50, nextExpiry + 20)) : null
}

useLib.subscribe((s, prev) => {
  if (s.jobs !== prev.jobs) rebuild()
})
rebuild()

/** Marks keys as queued right away (before the job broadcast arrives) and tracks them by job id. */
export function addPending(keys: string[], jobIds: string[]): void {
  if (!keys.length) return
  pending.push({ keys, jobIds, at: Date.now() })
  rebuild()
}

/**
 * Live queued/running state for a release. `fallback` is the state main reported with the summary; it
 * is only trusted while the renderer has no job list at all.
 */
export function useQueueState(keys: readonly string[], fallback?: QueueState | null): QueueState | null {
  return useQueueIndex((s) => {
    let found: QueueState | null = null
    for (const k of keys) {
      const e = s.byKey.get(k)
      if (!e) continue
      const st = stateOf(e)
      if (st === 'running') return st
      found = st
    }
    return found ?? (s.hasJobs ? null : (fallback ?? null))
  })
}

/** The active job (for progress) behind the first matching key, if any. */
export function useQueueJob(keys: readonly string[]): JobInfo | null {
  return useQueueIndex((s) => {
    let found: JobInfo | null = null
    for (const k of keys) {
      const e = s.byKey.get(k)
      if (!e || typeof e === 'string') continue
      if (e.status === 'running') return e
      found ??= e
    }
    return found
  })
}

/** Derive a primitive from the set of active keys (re-renders only when the result changes). */
export function useQueueSelect<T extends string | number | boolean | null>(fn: (isActive: (key: string) => boolean) => T): T {
  return useQueueIndex((s) => fn((k) => s.byKey.has(k)))
}

export const isKeyActive = (key: string): boolean => useQueueIndex.getState().byKey.has(key)

/** Counts of active jobs among `keySets` (e.g. the tracks of a playlist). */
export function useQueueCount(keySets: readonly (readonly string[])[]): { queued: number; running: number } {
  const str = useQueueIndex((s) => {
    let q = 0
    let r = 0
    for (const keys of keySets) {
      let st: QueueState | null = null
      for (const k of keys) {
        const e = s.byKey.get(k)
        if (!e) continue
        st = stateOf(e)
        if (st === 'running') break
      }
      if (st === 'running') r++
      else if (st === 'queued') q++
    }
    return `${q}:${r}`
  })
  const [q, r] = str.split(':').map(Number)
  return { queued: q, running: r }
}

// ---- Errors / notices ----

/** Abuse signals seen in this window, in case the paused-sources broadcast is late or missing. */
const useNotices = create<Partial<Record<SourceId, string>>>(() => ({}))

export function reportSourceError(source: SourceId, e: unknown, login?: () => void): ErrorCopy {
  const label = SOURCE_LABEL[source]
  const c = describeSourceError(label, e)
  if (c.kind === 'abuse') {
    useNotices.setState({ [source]: c.detail })
    toast(`${c.title} — resume from Import`, 'error', { label: 'Open Import', run: () => navigate({ view: 'import', tab: 'queue' }) })
  } else if (c.kind === 'auth') toast(`${c.title}.`, 'error', login ? { label: 'Log in', run: login } : undefined)
  else if (c.kind === 'cancelled') toast(c.detail || 'Cancelled')
  else if (c.kind === 'rate-limit') toast(`${c.title}. ${c.detail}`, 'error')
  else toast(c.kind === 'unavailable' ? c.detail : `${c.title}: ${c.detail}`, 'error')
  return c
}

export function ErrorState({ source, error, onRetry, onLogin }: { source: SourceId; error: unknown; onRetry?: () => void; onLogin?: () => void }) {
  const c = describeSourceError(SOURCE_LABEL[source], error)
  const icon = c.kind === 'auth' ? 'user' : c.kind === 'network' ? 'refresh' : 'warning'
  return (
    <Empty icon={icon} title={c.title}>
      <span>{c.detail}</span>
      <div className="row">
        {c.kind === 'auth' && onLogin && (
          <Button kind="primary" onClick={onLogin}>
            Log in to {SOURCE_LABEL[source]}
          </Button>
        )}
        {c.kind === 'abuse' && (
          <Button kind="primary" icon="inbox" onClick={() => navigate({ view: 'import', tab: 'queue' })}>
            Open Import
          </Button>
        )}
        {onRetry && c.kind !== 'auth' && (
          <Button icon="refresh" onClick={onRetry}>
            Try Again
          </Button>
        )}
      </div>
    </Empty>
  )
}

/** Banner while the import queue holds this source's jobs (abuse flag, login needed, manual pause). */
export function PauseBanner({ source, loggedIn, onLogin }: { source: SourceId; loggedIn: boolean; onLogin?: () => void }) {
  const reason = useLib((s) => s.pausedSources[source])
  const notice = useNotices((s) => s[source])
  const wasPaused = useRef(!!reason)
  useEffect(() => {
    // Resumed from Import: drop the local abuse notice too.
    if (wasPaused.current && !reason) useNotices.setState({ [source]: undefined })
    wasPaused.current = !!reason
  }, [reason, source])
  const [busy, setBusy] = useState(false)
  if (!reason && !notice) return null
  const label = SOURCE_LABEL[source]
  const text = reason ?? notice ?? ''
  const login = /log ?in/i.test(text) && !notice
  const resume = async () => {
    setBusy(true)
    try {
      await invoke(IMPORT.resumeSource, source)
      toast(`${label} downloads resumed`, 'ok')
    } catch (e) {
      reportSourceError(source, e)
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className={cx('src-banner', login ? 'info' : 'warn')} role="status">
      <Icon name={login ? 'user' : 'warning'} size={18} />
      <div className="src-banner-text">
        {login ? (
          <>
            <b>{label} downloads are waiting for login.</b>
            <span>{loggedIn ? 'You are logged in again — resume the queued downloads when ready.' : `Log in to ${label} to continue the queued downloads.`}</span>
          </>
        ) : (
          <>
            <b>{label} paused downloads (possible account flag) — resume from Import.</b>
            <span>{text}</span>
          </>
        )}
      </div>
      {login && !loggedIn && onLogin && (
        <Button small kind="primary" onClick={onLogin}>
          Log In
        </Button>
      )}
      {login && loggedIn && (
        <Button small kind="primary" disabled={busy} onClick={() => void resume()}>
          Resume Downloads
        </Button>
      )}
      {!login && (
        <Button small icon="inbox" onClick={() => navigate({ view: 'import', tab: 'queue' })}>
          Open Import
        </Button>
      )}
    </div>
  )
}

// ---- Remote data ----

export interface Remote<T> {
  data: T | undefined
  error: unknown
  loading: boolean
  /** Reload with a spinner/error state. */
  reload: () => void
  /** Reload quietly (keeps current data on failure). */
  refresh: () => void
}

/**
 * Loads `fn()` for `key` (null = idle). Data from a previous key is never shown for a new one. With
 * `refetchOnLibrary`, library changes (imports finishing) trigger a quiet debounced refresh so badges
 * catch up; main caches browse calls, so this rarely hits the network.
 */
export function useRemote<T>(key: string | null, fn: () => Promise<T>, opts: { refetchOnLibrary?: boolean } = {}): Remote<T> {
  const [state, setState] = useState<{ key: string | null; data?: T; error?: unknown; loading: boolean }>({ key, loading: key != null })
  const fnRef = useRef(fn)
  useLayoutEffect(() => {
    fnRef.current = fn
  })
  const seq = useRef(0)
  const run = useCallback(
    (quiet: boolean) => {
      if (key == null) return
      const n = ++seq.current
      if (!quiet) setState((s) => ({ key, data: s.key === key ? s.data : undefined, error: undefined, loading: true }))
      fnRef.current().then(
        (data) => {
          if (n === seq.current) setState({ key, data, loading: false })
        },
        (error: unknown) => {
          if (n !== seq.current) return
          setState((s) => (quiet && s.key === key && s.data !== undefined ? { ...s, loading: false } : { key, data: undefined, error, loading: false }))
        },
      )
    },
    [key],
  )
  useEffect(() => {
    if (key == null) setState({ key, loading: false })
    else run(false)
  }, [key, run])
  const version = useLib((s) => s.version)
  const seen = useRef(version)
  const refetch = !!opts.refetchOnLibrary
  useEffect(() => {
    if (!refetch || version === seen.current) return
    seen.current = version
    const t = setTimeout(() => run(true), 1500)
    return () => clearTimeout(t)
  }, [version, refetch, run])
  const same = state.key === key
  return {
    data: same ? state.data : undefined,
    error: same ? state.error : undefined,
    loading: same ? state.loading : key != null,
    reload: () => run(false),
    refresh: () => run(true),
  }
}

// ---- Download control ----

/**
 * In-library badge + download button. While a job is queued/running the queued badge replaces the
 * button. `onDownload` may return a promise; the button spins until it settles.
 */
export function DownloadControl({
  badge,
  queue,
  onDownload,
  compact,
  big,
  label = 'Download',
  className,
  kind,
}: {
  badge: InLibraryBadge | null
  queue: QueueState | null
  onDownload: () => Promise<unknown> | void
  compact?: boolean
  /** Render a full text button (without the badge, which heroes show separately) instead of an icon button. */
  big?: boolean
  label?: string
  className?: string
  kind?: 'primary' | 'default'
}) {
  const [busy, setBusy] = useState(false)
  const alive = useRef(true)
  useEffect(
    () => () => {
      alive.current = false
    },
    [],
  )
  const have = badge?.status === 'in-library'
  const click = async (e: React.MouseEvent) => {
    e.stopPropagation()
    if (busy) return
    setBusy(true)
    try {
      await onDownload()
    } finally {
      if (alive.current) setBusy(false)
    }
  }
  if (queue)
    return (
      <span className={cx('src-dl', className)}>
        <LibraryBadge badge={badge ?? MISSING_BADGE} queued={queue} />
      </span>
    )
  const title = have ? `${label} again — files already in your library are kept unless this copy is better` : label
  if (big)
    return (
      <Button kind={kind ?? (have ? 'default' : 'primary')} icon={busy ? undefined : 'download'} disabled={busy} onClick={(e) => void click(e)} title={title} className={className}>
        {busy ? <Spinner size={12} /> : null}
        {have ? `${label} Again` : label}
      </Button>
    )
  return (
    <span className={cx('src-dl', className)}>
      {badge && <LibraryBadge badge={badge} compact={compact} />}
      {busy ? (
        <span className="src-dl-busy">
          <Spinner size={14} />
        </span>
      ) : (
        <IconButton icon="download" size={16} className={cx('src-dl-btn', have && 'again')} title={title} onClick={(e) => void click(e)} />
      )}
    </span>
  )
}

/** "Downloading · 45%" with a progress bar for the active job behind a release. */
export function JobProgress({ job }: { job: JobInfo | null }) {
  if (!job) return null
  const running = job.status === 'running'
  const pct = Math.round((job.progress ?? 0) * 100)
  const what = job.message || job.stage || (running ? 'Downloading' : 'Waiting in the import queue')
  return (
    <div className="src-progress">
      <div className="src-progress-text">
        <span className="ellipsis">{what}</span>
        {running && pct > 0 && <span className="tnum">{pct}%</span>}
      </div>
      <ProgressBar value={job.progress ?? 0} indeterminate={!running || pct === 0} />
    </div>
  )
}

// ---- Tiles ----

export function SourceTile({
  art,
  title,
  explicit,
  sub,
  footer,
  round,
  onOpen,
  onContextMenu,
}: {
  art: string | null
  title: string
  explicit?: boolean
  sub?: ReactNode
  footer?: ReactNode
  round?: boolean
  onOpen?: () => void
  onContextMenu?: (e: React.MouseEvent) => void
}) {
  return (
    <div
      className={cx('tile src-tile', round && 'round')}
      onClick={onOpen}
      onContextMenu={onContextMenu}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && e.target === e.currentTarget) onOpen?.()
      }}
    >
      <div className="tile-art">
        <Artwork url={art} radius={round ? 999 : 10} title={title} />
      </div>
      <div className="tile-title src-tile-title" title={title}>
        <span className="ellipsis">{title}</span>
        {explicit && <Explicit />}
      </div>
      {sub != null && <div className="tile-sub ellipsis">{sub}</div>}
      {footer && (
        <div className="src-tile-foot" onClick={(e) => e.stopPropagation()}>
          {footer}
        </div>
      )}
    </div>
  )
}

export function Explicit() {
  return (
    <span className="src-explicit" title="Explicit" aria-label="Explicit">
      E
    </span>
  )
}

// ---- Track rows ----

export function TrackRow({
  lead,
  art,
  title,
  explicit,
  sub,
  album,
  durationSec,
  right,
  dim,
  dimReason,
  onContextMenu,
}: {
  lead?: ReactNode
  art?: string | null
  title: string
  explicit?: boolean
  sub?: ReactNode
  album?: ReactNode
  durationSec?: number
  right?: ReactNode
  dim?: boolean
  dimReason?: string
  onContextMenu?: (e: React.MouseEvent) => void
}) {
  return (
    <div className={cx('src-tr', dim && 'dim')} onContextMenu={onContextMenu} title={dim ? dimReason : undefined}>
      <div className="src-tr-lead tnum">{art !== undefined ? <Artwork url={art} size={36} radius={5} title={title} /> : lead}</div>
      <div className="src-tr-main">
        <div className="src-tr-title">
          <span className="ellipsis">{title}</span>
          {explicit && <Explicit />}
        </div>
        {sub && <div className="src-tr-sub ellipsis">{sub}</div>}
      </div>
      {album !== undefined && <div className="src-tr-album ellipsis">{album}</div>}
      <div className="src-tr-right">{right}</div>
      <div className="src-tr-time tnum">{durationSec ? duration(durationSec * 1000) : ''}</div>
    </div>
  )
}

export function TrackListHead({ album, lead = '#' }: { album?: boolean; lead?: string }) {
  return (
    <div className={cx('src-tr src-tr-head', album && 'has-album')}>
      <div className="src-tr-lead">{lead}</div>
      <div className="src-tr-main">Title</div>
      {album && <div className="src-tr-album">Album</div>}
      <div className="src-tr-right" />
      <div className="src-tr-time">
        <Icon name="clock" size={13} />
      </div>
    </div>
  )
}

// ---- Infinite scroll ----

/** Footer that loads the next page when it scrolls into view (and offers a button as a fallback). */
export function LoadMore({ hasMore, loading, error, onMore, shown, total, noun }: { hasMore: boolean; loading: boolean; error?: boolean; onMore: () => void; shown: number; total?: number; noun: string }) {
  const ref = useRef<HTMLDivElement>(null)
  const scroll = useContext(ScrollParent)
  const onMoreRef = useRef(onMore)
  useLayoutEffect(() => {
    onMoreRef.current = onMore
  })
  const armed = hasMore && !loading && !error
  useEffect(() => {
    const el = ref.current
    if (!el || !armed) return
    const io = new IntersectionObserver((es) => es.some((e) => e.isIntersecting) && onMoreRef.current(), { root: scroll?.current ?? null, rootMargin: '0px 0px 600px 0px' })
    io.observe(el)
    return () => io.disconnect()
  }, [armed, scroll])
  return (
    <div ref={ref} className="src-more">
      {loading ? (
        <Spinner />
      ) : error ? (
        <Button small icon="refresh" onClick={onMore}>
          Couldn’t load more — Try Again
        </Button>
      ) : hasMore ? (
        <Button small onClick={onMore}>
          Load More
        </Button>
      ) : null}
      {shown > 0 && (
        <span className="faint">
          {total != null && total > shown ? `${shown.toLocaleString()} of ${total.toLocaleString()} ${noun}` : `${shown.toLocaleString()} ${noun}`}
        </span>
      )}
    </div>
  )
}

/** Renders a growing prefix of a long list (cheap stand-in for virtualization). */
export function useProgressive<T>(items: readonly T[], step = 120, resetKey?: unknown): { visible: readonly T[]; more: boolean; showMore: () => void } {
  const [n, setN] = useState(step)
  useEffect(() => setN(step), [resetKey, step])
  return { visible: items.slice(0, n), more: items.length > n, showMore: () => setN((x) => x + step) }
}

// ---- Misc ----

/** Opens a TIDAL/Bandcamp page in the default browser. */
export function openLink(url: string | null | undefined): void {
  if (!url) return
  invoke(SETTINGS.openExternal, url).catch((e) => toast(errorMessage(e), 'error'))
}

export function copyLink(url: string | null | undefined): void {
  if (!url) return
  navigator.clipboard.writeText(url).then(
    () => toast('Link copied', 'ok'),
    () => toast('Couldn’t copy the link', 'error'),
  )
}

export function CenterSpin({ label }: { label?: string }) {
  return (
    <div className="center-spin src-center-spin">
      <Spinner size={22} />
      {label && <span className="faint">{label}</span>}
    </div>
  )
}
