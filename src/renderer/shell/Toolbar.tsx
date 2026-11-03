// Floating toolbar over the content: back/forward, the scrolled-away view title, global search.
// The whole bar is a window drag region; controls opt out.

import { useEffect, useRef, useState } from 'react'
import { cx } from '../lib/format'
import { useUi } from '../state/ui'
import { IconButton } from '../components/ui'
import { Icon } from '../components/Icon'

export function Toolbar({ scrolled, title }: { scrolled: boolean; title?: string }) {
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
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault()
        input.current?.focus()
        input.current?.select()
      }
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
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
    else timer.current = setTimeout(go, 220)
  }

  return (
    <header className={cx('toolbar drag', scrolled && 'scrolled')}>
      <IconButton icon="chevronLeft" title="Back" disabled={!back} onClick={() => useUi.getState().goBack()} />
      <IconButton icon="chevronRight" title="Forward" disabled={!fwd} onClick={() => useUi.getState().goForward()} />
      <span className="toolbar-title">{title}</span>
      <span className="toolbar-spacer" />
      <label className="search-box glass">
        <Icon name="search" size={15} />
        <input
          ref={input}
          type="search"
          placeholder="Search library"
          value={q}
          onChange={(e) => search(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') search(q, true)
            if (e.key === 'Escape') {
              search('', true)
              input.current?.blur()
            }
          }}
        />
        {q && <IconButton icon="close" size={12} title="Clear" onClick={() => search('', true)} />}
      </label>
    </header>
  )
}
