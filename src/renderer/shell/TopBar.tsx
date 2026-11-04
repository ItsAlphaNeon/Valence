// Top bar: back/forward, the search pill in the middle, activity and settings on the
// right. The bar is the window's drag region; the native window controls sit at its right end.

import { useEffect, useRef, useState } from 'react'
import { cx, plural } from '../lib/format'
import { platform } from '../lib/ipc'
import { navigate, useUi } from '../state/ui'
import { useLib } from '../state/library'
import { IconButton, Spinner } from '../components/ui'
import { Icon } from '../components/Icon'

export const MOD = platform === 'darwin' ? '⌘' : 'Ctrl'

function Activity() {
  const jobs = useLib((s) => s.jobs)
  const scan = useLib((s) => s.scan)
  const active = jobs.filter((j) => j.status === 'running' || j.status === 'queued').length
  const review = jobs.filter((j) => j.status === 'review').length
  if (scan && scan.total > 0)
    return (
      <span className="tb-activity" title="Scanning your library">
        <Spinner size={13} /> Scanning {Math.round((scan.done / scan.total) * 100)}%
      </span>
    )
  if (!active && !review) return null
  return (
    <button className={cx('tb-activity', !active && review > 0 && 'warn')} onClick={() => navigate({ view: 'import', tab: !active && review ? 'review' : 'queue' })} title="Open Import">
      {active ? (
        <>
          <Spinner size={13} /> Importing {plural(active, 'release')}
        </>
      ) : (
        <>
          <Icon name="warning" size={14} /> {review} to review
        </>
      )}
    </button>
  )
}

export function TopBar() {
  const route = useUi((s) => s.route)
  const back = useUi((s) => s.back.length)
  const fwd = useUi((s) => s.fwd.length)
  const [q, setQ] = useState(route.view === 'search' ? route.q : '')
  const input = useRef<HTMLInputElement>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (route.view !== 'search') setQ('')
  }, [route.view])

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'f') {
        e.preventDefault()
        input.current?.focus()
        input.current?.select()
      }
    }
    const focus = () => {
      input.current?.focus()
      input.current?.select()
    }
    window.addEventListener('keydown', key)
    window.addEventListener('valence:focus-search', focus)
    return () => {
      window.removeEventListener('keydown', key)
      window.removeEventListener('valence:focus-search', focus)
    }
  }, [])

  const search = (text: string, now = false) => {
    setQ(text)
    if (timer.current) clearTimeout(timer.current)
    const go = () => {
      const cur = useUi.getState().route
      if (!text.trim()) {
        if (cur.view === 'search') useUi.getState().goBack()
        return
      }
      useUi.getState().navigate({ view: 'search', q: text.trim() }, { replace: cur.view === 'search' })
    }
    if (now) go()
    else timer.current = setTimeout(go, 200)
  }

  return (
    <header className="topbar drag">
      <button className="tb-brand" onClick={() => navigate({ view: 'albums' })} title="Albums" style={{ border: 0, background: 'none' }}>
        Valence
      </button>
      <div className="tb-nav">
        <IconButton icon="chevronLeft" size={18} title="Back (Alt+←)" disabled={!back} onClick={() => useUi.getState().goBack()} />
        <IconButton icon="chevronRight" size={18} title="Forward (Alt+→)" disabled={!fwd} onClick={() => useUi.getState().goForward()} />
      </div>
      <div className="tb-center">
        <label className="tb-search">
          <Icon name="search" size={20} />
          <input
            ref={input}
            type="search"
            placeholder="Search songs, albums and artists"
            value={q}
            spellCheck={false}
            onChange={(e) => search(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') search(q, true)
              if (e.key === 'Escape') {
                search('', true)
                input.current?.blur()
              }
            }}
          />
          {q ? (
            <IconButton icon="close" size={14} title="Clear" onClick={() => search('', true)} />
          ) : (
            <button
              className="tb-kbd"
              title="Command palette"
              style={{ background: 'none' }}
              onClick={(e) => {
                e.preventDefault()
                useUi.getState().setPalette(true)
              }}
            >
              {MOD} K
            </button>
          )}
        </label>
      </div>
      <div className="tb-right">
        <Activity />
        <IconButton icon="keyboard" size={18} title="Keyboard shortcuts (?)" onClick={() => useUi.getState().setShortcuts(true)} />
        <IconButton icon="settings" size={18} title={`Settings (${MOD}+,)`} active={route.view === 'settings'} onClick={() => navigate({ view: 'settings' })} />
      </div>
    </header>
  )
}
