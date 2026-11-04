// Command palette (Ctrl/⌘+K): jump anywhere, run player actions, and search the library — all from
// the keyboard. Arrow keys move, Enter runs, Shift+Enter queues a song to play next.

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { LIB, type SearchResult } from '@shared/ipc/library'
import { invoke } from '../lib/ipc'
import { cx } from '../lib/format'
import { albumRoute, navigate, useUi, type Route } from '../state/ui'
import { useLib } from '../state/library'
import { cmd, playNext, playTracks, setSleepTimer, setStopAfterCurrent, usePlayer } from '../state/player'
import { setLiked } from '../state/favorites'
import { Artwork } from '../components/ui'
import { Icon, type IconName } from '../components/Icon'
import { MOD } from './TopBar'

interface Cmd {
  id: string
  group: string
  label: string
  sub?: string
  icon?: IconName
  art?: ReactNode
  hint?: string
  keywords?: string
  run: () => void
  alt?: () => void
}

const go = (r: Route) => () => navigate(r)

function baseCommands(): Cmd[] {
  const st = usePlayer.getState()
  const playing = !!st.state?.playing
  const ui = useUi.getState()
  const nav: Array<[string, IconName, Route, string?, string?]> = [
    ['Liked Songs', 'heart', { view: 'liked' }, undefined, 'favorites favourites'],
    ['Albums', 'albums', { view: 'albums' }],
    ['Songs', 'songs', { view: 'songs' }, undefined, 'tracks'],
    ['Artists', 'artists', { view: 'artists' }],
    ['Genres', 'genres', { view: 'genres' }],
    ['Recently Added', 'clock', { view: 'recent' }, undefined, 'new'],
    ['Listening Stats', 'chart', { view: 'stats' }, undefined, 'wrapped history top'],
    ['Now Playing', 'expand', { view: 'nowplaying' }, undefined, 'fullscreen'],
    ['Import', 'inbox', { view: 'import' }],
    ['TIDAL', 'wave', { view: 'tidal' }],
    ['Bandcamp', 'disc', { view: 'bandcamp' }],
    ['SiIvaGunner Seasons', 'star', { view: 'rips', tab: 'seasons' }, undefined, 'rips'],
    ['Get Rips', 'download', { view: 'hqrip' }, undefined, 'rips youtube'],
    ['Settings', 'settings', { view: 'settings' }, `${MOD}+,`, 'preferences options'],
    ['Appearance settings', 'image', { view: 'settings', section: 'appearance' }, undefined, 'theme colors dark light accent'],
    ['Playback settings', 'eq', { view: 'settings', section: 'playback' }, undefined, 'crossfade gapless eq equalizer replaygain'],
  ]
  const cmds: Cmd[] = nav.map(([label, icon, r, hint, keywords]) => ({ id: `go:${label}`, group: 'Go to', label, icon, hint, keywords, run: go(r) }))
  const actions: Cmd[] = [
    { id: 'a:toggle', group: 'Playback', label: playing ? 'Pause' : 'Play', icon: playing ? 'pause' : 'play', hint: 'Space', run: () => cmd({ type: 'toggle' }) },
    { id: 'a:next', group: 'Playback', label: 'Next song', icon: 'next', hint: `${MOD}+→`, run: () => cmd({ type: 'next' }) },
    { id: 'a:prev', group: 'Playback', label: 'Previous song', icon: 'prev', hint: `${MOD}+←`, run: () => cmd({ type: 'prev' }) },
    { id: 'a:shuffle', group: 'Playback', label: st.state?.shuffle ? 'Turn shuffle off' : 'Turn shuffle on', icon: 'shuffle', hint: `${MOD}+S`, run: () => cmd({ type: 'setShuffle', shuffle: !st.state?.shuffle }) },
    { id: 'a:repeat', group: 'Playback', label: 'Change repeat mode', icon: 'repeat', hint: `${MOD}+R`, run: () => cmd({ type: 'cycleRepeat' }) },
    {
      id: 'a:like',
      group: 'Playback',
      label: 'Like / unlike the current song',
      icon: 'heart',
      hint: 'Alt+Shift+B',
      keywords: 'favorite save heart',
      run: () => {
        const id = st.currentTrackId
        if (id != null) void invoke<{ liked: boolean } | null>(LIB.track, id).then((t) => t && setLiked({ kind: 'track', ids: [id] }, !t.liked))
      },
    },
    { id: 'a:sleep30', group: 'Playback', label: 'Sleep timer: 30 minutes', icon: 'moon', keywords: 'sleep timer stop', run: () => setSleepTimer({ mode: 'time', minutes: 30, endsAt: Date.now() + 30 * 60_000 }) },
    { id: 'a:sleep60', group: 'Playback', label: 'Sleep timer: 1 hour', icon: 'moon', keywords: 'sleep timer stop', run: () => setSleepTimer({ mode: 'time', minutes: 60, endsAt: Date.now() + 60 * 60_000 }) },
    { id: 'a:sleeptrack', group: 'Playback', label: 'Sleep timer: end of song', icon: 'moon', keywords: 'sleep timer stop', run: () => setSleepTimer({ mode: 'track' }) },
    { id: 'a:sleepoff', group: 'Playback', label: 'Turn off sleep timer', icon: 'moon', keywords: 'sleep timer cancel', run: () => setSleepTimer({ mode: 'off' }) },
    { id: 'a:stopafter', group: 'Playback', label: 'Stop after current song', icon: 'stop', run: () => setStopAfterCurrent(!(st.state?.stopAfterCurrent ?? st.stopAfterCurrent)) },
    { id: 'p:queue', group: 'View', label: 'Show queue', icon: 'queue', hint: `${MOD}+U`, run: () => ui.setDrawer('queue') },
    { id: 'p:lyrics', group: 'View', label: 'Show lyrics', icon: 'lyrics', hint: `${MOD}+L`, run: () => ui.setDrawer('lyrics') },
    { id: 'p:info', group: 'View', label: 'Show now playing info', icon: 'panel', hint: `${MOD}+I`, run: () => ui.setDrawer('info') },
    { id: 'p:sidebar', group: 'View', label: ui.sidebarCollapsed ? 'Expand Your Library' : 'Collapse Your Library', icon: 'library', hint: 'Alt+Shift+L', run: () => ui.setSidebar({ collapsed: !ui.sidebarCollapsed }) },
    { id: 'p:mini', group: 'View', label: 'Mini player', icon: 'mini', hint: `${MOD}+Shift+M`, run: () => window.valence.send('mini:toggle') },
    {
      id: 'p:art',
      group: 'View',
      label: 'View current album art',
      icon: 'zoomIn',
      keywords: 'cover artwork zoom',
      run: () => {
        const cur = st.state?.current
        if (cur) ui.openArt({ hash: st.currentArtHash, url: st.currentArtHash ? undefined : cur.artUrl, title: cur.album || cur.title, sub: cur.artist })
      },
    },
    { id: 'x:newpl', group: 'Library', label: 'New playlist…', icon: 'plus', hint: `${MOD}+N`, run: () => window.dispatchEvent(new CustomEvent('valence:new-playlist', { detail: [] })) },
    { id: 'x:smart', group: 'Library', label: 'New smart playlist', icon: 'smart', run: go({ view: 'smart' }) },
    { id: 'x:rescan', group: 'Library', label: 'Rescan library', icon: 'refresh', run: () => void invoke(LIB.rescan, false) },
    { id: 'x:keys', group: 'Help', label: 'Keyboard shortcuts', icon: 'keyboard', hint: '?', run: () => ui.setShortcuts(true) },
    { id: 'x:onboard', group: 'Help', label: 'Run setup again', icon: 'sparkle', keywords: 'onboarding welcome tour', run: () => ui.setOnboarding(true) },
  ]
  const playlists: Cmd[] = useLib.getState().playlists.map((p) => ({
    id: `pl:${p.id}`,
    group: 'Playlists',
    label: p.name,
    icon: p.kind === 'smart' ? 'smart' : 'playlist',
    sub: p.kind === 'smart' ? 'Smart playlist' : 'Playlist',
    run: go({ view: 'playlist', id: p.id }),
  }))
  return [...cmds, ...actions, ...playlists]
}

/** Every query word must start a word in the label/keywords (or appear inside, scored lower). */
function score(c: Cmd, q: string): number {
  const hay = `${c.label} ${c.sub ?? ''} ${c.keywords ?? ''}`.toLowerCase()
  let total = 0
  for (const w of q.toLowerCase().split(/\s+/).filter(Boolean)) {
    const i = hay.indexOf(w)
    if (i < 0) return 0
    total += i === 0 ? 3 : /\s/.test(hay[i - 1]) ? 2 : 1
  }
  return total
}

export function CommandPalette() {
  const open = useUi((s) => s.palette)
  if (!open) return null
  return <Palette />
}

function Palette() {
  const close = () => useUi.getState().setPalette(false)
  const [q, setQ] = useState('')
  const [sel, setSel] = useState(0)
  const [found, setFound] = useState<SearchResult | null>(null)
  const list = useRef<HTMLDivElement>(null)
  const base = useMemo(baseCommands, [])

  useEffect(() => {
    const t = q.trim()
    if (t.length < 2) return setFound(null)
    let live = true
    const timer = setTimeout(() => void invoke<SearchResult>(LIB.search, t).then((r) => live && setFound(r)), 120)
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [q])

  const items = useMemo(() => {
    const t = q.trim()
    if (!t) return base
    const cmds = base
      .map((c) => [c, score(c, t)] as const)
      .filter(([, s]) => s > 0)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([c]) => c)
    const lib: Cmd[] = []
    if (found) {
      for (const a of found.artists.slice(0, 3))
        lib.push({ id: `ar:${a.name}`, group: 'Artists', label: a.name, sub: 'Artist', art: <Artwork hash={a.artHash} px={96} title={a.name} className="round" />, run: go({ view: 'artist', artist: a.name }) })
      for (const a of found.albums.slice(0, 4))
        lib.push({ id: `al:${a.id}`, group: 'Albums', label: a.title, sub: `Album · ${a.albumArtist}`, art: <Artwork hash={a.artHash} px={96} title={a.title} />, run: go(albumRoute(a.id, a.hqRip)) })
      for (const tr of found.tracks.slice(0, 6))
        lib.push({
          id: `tr:${tr.id}`,
          group: 'Songs',
          label: tr.title,
          sub: `${tr.artist} · ${tr.album}`,
          art: <Artwork hash={tr.artHash} px={96} title={tr.album} />,
          hint: 'Enter plays · Shift+Enter plays next',
          run: () => void playTracks([tr.id], 0, { kind: 'search', id: t, title: `“${t}”` }),
          alt: () => void playNext([tr.id]),
        })
    }
    const searchAll: Cmd = { id: 'search', group: 'Search', label: `Search for “${t}”`, icon: 'search', run: () => navigate({ view: 'search', q: t }) }
    return [...lib.filter((c) => c.group === 'Songs' || c.group === 'Artists' || c.group === 'Albums'), ...cmds, searchAll]
  }, [q, base, found])

  useEffect(() => setSel(0), [q, found])
  useEffect(() => {
    list.current?.querySelector<HTMLElement>(`[data-i="${sel}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [sel])

  const run = (c: Cmd | undefined, alt = false) => {
    if (!c) return
    close()
    ;(alt && c.alt ? c.alt : c.run)()
  }

  let lastGroup = ''
  return (
    <div className="palette-scrim" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="palette" role="dialog" aria-label="Command palette">
        <label className="palette-input">
          <Icon name="search" size={20} />
          <input
            autoFocus
            placeholder="Search songs, albums, artists, or type a command…"
            value={q}
            spellCheck={false}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault()
                setSel((i) => Math.min(items.length - 1, i + 1))
              } else if (e.key === 'ArrowUp') {
                e.preventDefault()
                setSel((i) => Math.max(0, i - 1))
              } else if (e.key === 'Enter') {
                e.preventDefault()
                run(items[sel], e.shiftKey)
              } else if (e.key === 'Escape') {
                e.preventDefault()
                e.stopPropagation()
                close()
              }
            }}
          />
          <span className="kbd">Esc</span>
        </label>
        <div className="palette-list" ref={list}>
          {items.map((c, i) => {
            const head = c.group !== lastGroup ? <div className="palette-group">{c.group}</div> : null
            lastGroup = c.group
            return (
              <div key={c.id}>
                {head}
                <button data-i={i} className={cx('palette-item', i === sel && 'on')} onMouseMove={() => setSel(i)} onClick={(e) => run(c, e.shiftKey)}>
                  {c.art ?? (
                    <span className="palette-icon">
                      <Icon name={c.icon ?? 'chevronRight'} size={18} />
                    </span>
                  )}
                  <span style={{ minWidth: 0 }}>
                    <div className="ellipsis">{c.label}</div>
                    {c.sub && <div className="faint ellipsis" style={{ fontSize: 12.5 }}>{c.sub}</div>}
                  </span>
                  {c.hint && i === sel ? <span className="palette-hint">{c.hint}</span> : c.hint && !c.hint.includes(' ') ? <span className="palette-hint kbd">{c.hint}</span> : null}
                </button>
              </div>
            )
          })}
          {!items.length && <div className="empty">No matches</div>}
        </div>
        <div className="palette-foot">
          <span>↑↓ to move</span>
          <span>Enter to open</span>
          <span>Shift+Enter to play next</span>
        </div>
      </div>
    </div>
  )
}
