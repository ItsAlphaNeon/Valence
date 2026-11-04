// App shell: top bar | Your Library | main panel (the route) | right panel | player bar.
// Routes render into one scroll container that virtualized lists use as their scroll parent.

import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { IMPORT } from '@shared/ipc/import'
import { SETTINGS } from '@shared/ipc/settings'
import { errorMessage, invoke, platform } from '../lib/ipc'
import { cx, plural } from '../lib/format'
import { navigate, toast, useUi, type Route } from '../state/ui'
import { cmd, usePlayer } from '../state/player'
import { setting, useLib } from '../state/library'
import { setLiked } from '../state/favorites'
import { ScrollParent } from '../components/TrackTable'
import { MenuHost } from '../components/ui'
import { TopBar } from './TopBar'
import { Sidebar, sidebarWidth } from './Sidebar'
import { PlayerBar } from './PlayerBar'
import { RightPanel } from './RightPanel'
import { Toasts } from './Toasts'
import { ArtViewer } from './ArtViewer'
import { CommandPalette } from './CommandPalette'
import { ShortcutsOverlay } from './Shortcuts'
import { Onboarding } from './Onboarding'
import { usePlaybackChrome } from './system'
import { LikedView } from '../views/library/Liked'
import { StatsView } from '../views/library/Stats'
import { SongsView } from '../views/library/Songs'
import { AlbumsView, RecentView } from '../views/library/Albums'
import { AlbumDetailView } from '../views/library/AlbumDetail'
import { ArtistDetailView, ArtistsView, GenreDetailView, GenresView } from '../views/library/Artists'
import { PlaylistView, SmartEditorView } from '../views/library/Playlist'
import { NowPlayingView, SearchView } from '../views/library/NowPlaying'
import { GetInfo } from '../views/library/GetInfo'
import { SettingsView } from '../views/settings/SettingsView'
import { ImportView } from '../views/import/ImportView'
import { TidalView } from '../views/tidal/TidalView'
import { BandcampView } from '../views/bandcamp/BandcampView'
import { RipsView } from '../views/rips/RipsView'
import { GetRipsView } from '../views/rips/GetRipsView'

/** Title for the sticky header on views that don't set their own. */
function titleOf(r: Route): string | undefined {
  switch (r.view) {
    case 'songs':
      return 'Songs'
    case 'albums':
      return 'Albums'
    case 'artists':
      return 'Artists'
    case 'genres':
      return 'Genres'
    case 'genre':
      return r.genre
    case 'artist':
      return r.artist
    case 'recent':
      return 'Recently Added'
    case 'liked':
      return 'Liked'
    case 'stats':
      return 'Listening Stats'
    case 'search':
      return `Results for “${r.q}”`
    case 'settings':
      return 'Settings'
    case 'import':
      return 'Import'
    case 'tidal':
      return 'TIDAL'
    case 'bandcamp':
      return 'Bandcamp'
    case 'rips':
      return r.tab === 'songs' ? 'Rip Songs' : r.tab === 'albums' ? 'Rip Albums' : 'Seasons'
    case 'hqrip':
      return 'Get Rips'
    default:
      return undefined
  }
}

function renderRoute(r: Route): ReactNode {
  switch (r.view) {
    case 'liked':
      return <LikedView tab={r.tab} />
    case 'stats':
      return <StatsView range={r.range} />
    case 'songs':
      return <SongsView />
    case 'albums':
      return <AlbumsView />
    case 'album':
      return <AlbumDetailView id={r.id} />
    case 'artists':
      return <ArtistsView />
    case 'artist':
      return <ArtistDetailView artist={r.artist} />
    case 'genres':
      return <GenresView />
    case 'genre':
      return <GenreDetailView genre={r.genre} />
    case 'recent':
      return <RecentView />
    case 'playlist':
      return <PlaylistView id={r.id} />
    case 'smart':
      return <SmartEditorView id={r.id} />
    case 'nowplaying':
      return <NowPlayingView />
    case 'search':
      return <SearchView q={r.q} />
    case 'settings':
      return <SettingsView section={r.section} />
    case 'import':
      return <ImportView tab={r.tab} reportId={r.reportId} />
    case 'tidal':
      return <TidalView tab={r.tab} id={r.id} />
    case 'bandcamp':
      return <BandcampView id={r.id} />
    case 'rips':
      return <RipsView tab={r.tab} />
    case 'hqrip':
      return <GetRipsView tab={r.tab} />
  }
}

const isTyping = (t: EventTarget | null) => t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))

const ZOOMS = [0.75, 0.8, 0.9, 1, 1.1, 1.2, 1.3, 1.4, 1.5]
function stepZoom(dir: 1 | -1 | 0): void {
  const cur = Number(setting('ui.zoom', 1)) || 1
  const i = ZOOMS.findIndex((z) => z >= cur - 0.001)
  const next = dir === 0 ? 1 : ZOOMS[Math.min(ZOOMS.length - 1, Math.max(0, (i < 0 ? 3 : i) + dir))]
  useLib.setState((s) => ({ settings: { ...s.settings, 'ui.zoom': next } }))
  void invoke(SETTINGS.set, 'ui.zoom', next)
  toast(`Zoom ${Math.round(next * 100)}%`)
}

function likeCurrent(): void {
  const id = usePlayer.getState().currentTrackId
  if (id == null) return
  void invoke<{ liked: boolean } | null>('library:track', id).then((t) => t && setLiked({ kind: 'track', ids: [id] }, !t.liked))
}

function useShortcuts(): void {
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const ui = useUi.getState()
      const mod = e.ctrlKey || e.metaKey
      const k = e.key.toLowerCase()
      // Overlays first: Escape closes the topmost one.
      if (e.key === 'Escape') {
        if (ui.artView) return ui.openArt(null)
        if (ui.palette) return ui.setPalette(false)
        if (ui.shortcuts) return ui.setShortcuts(false)
        if (ui.onboarding) return
        if (!isTyping(e.target) && ui.drawer) return ui.setDrawer(null)
        return
      }
      if (mod && !e.shiftKey && k === 'k') {
        e.preventDefault()
        return ui.setPalette(!ui.palette)
      }
      if (ui.artView || ui.palette || ui.onboarding) return
      if (e.altKey && e.key === 'ArrowLeft') return ui.goBack()
      if (e.altKey && e.key === 'ArrowRight') return ui.goForward()
      if (mod && e.key === ',') return navigate({ view: 'settings' })
      if (mod && (e.key === '=' || e.key === '+')) {
        e.preventDefault()
        return stepZoom(1)
      }
      if (mod && e.key === '-') {
        e.preventDefault()
        return stepZoom(-1)
      }
      if (mod && e.key === '0') {
        e.preventDefault()
        return stepZoom(0)
      }
      if (mod && !e.shiftKey && k === 'l') {
        e.preventDefault()
        return ui.toggleDrawer('lyrics')
      }
      if (mod && !e.shiftKey && k === 'u') {
        e.preventDefault()
        return ui.toggleDrawer('queue')
      }
      if (mod && !e.shiftKey && k === 'i') {
        e.preventDefault()
        return ui.toggleDrawer('info')
      }
      if (mod && !e.shiftKey && k === 'n') {
        e.preventDefault()
        return window.dispatchEvent(new CustomEvent('valence:new-playlist', { detail: [] }))
      }
      if (e.altKey && e.shiftKey && k === 'b') {
        e.preventDefault()
        return likeCurrent()
      }
      if (e.altKey && e.shiftKey && k === 'l') {
        e.preventDefault()
        return ui.setSidebar({ collapsed: !ui.sidebarCollapsed })
      }
      if (e.altKey && e.shiftKey && k === 'r') {
        e.preventDefault()
        return ui.toggleDrawer(ui.drawer ?? 'info')
      }
      if (mod && e.shiftKey && k === 'm') {
        e.preventDefault()
        return window.valence.send('mini:toggle')
      }
      if (isTyping(e.target)) return
      const st = usePlayer.getState().state
      if (e.key === ' ' && !(e.target instanceof HTMLButtonElement)) {
        e.preventDefault()
        cmd({ type: 'toggle' })
      } else if (mod && e.key === 'ArrowRight') cmd({ type: 'next' })
      else if (mod && e.key === 'ArrowLeft') cmd({ type: 'prev' })
      else if (mod && e.key === 'ArrowUp') {
        e.preventDefault()
        cmd({ type: 'setVolume', volume: Math.min(1, (st?.volume ?? 1) + 0.05) })
      } else if (mod && e.key === 'ArrowDown') {
        e.preventDefault()
        cmd({ type: 'setVolume', volume: Math.max(0, (st?.volume ?? 1) - 0.05) })
      } else if (e.shiftKey && e.key === 'ArrowRight') cmd({ type: 'seekBy', deltaMs: 10_000 })
      else if (e.shiftKey && e.key === 'ArrowLeft') cmd({ type: 'seekBy', deltaMs: -10_000 })
      else if (mod && k === 's') {
        e.preventDefault()
        cmd({ type: 'setShuffle', shuffle: !st?.shuffle })
      } else if (mod && k === 'r') {
        e.preventDefault()
        cmd({ type: 'cycleRepeat' })
      } else if (!mod && !e.altKey && k === 'm') cmd({ type: 'setMuted', muted: !st?.muted })
      else if (!mod && !e.altKey && e.key === '?') ui.setShortcuts(!ui.shortcuts)
    }
    const mouse = (e: MouseEvent) => {
      if (e.button === 3) useUi.getState().goBack()
      if (e.button === 4) useUi.getState().goForward()
    }
    window.addEventListener('keydown', key)
    window.addEventListener('mouseup', mouse)
    return () => {
      window.removeEventListener('keydown', key)
      window.removeEventListener('mouseup', mouse)
    }
  }, [])
}

/** Dropping files or folders anywhere imports them (copies; originals stay put). */
function useFileDrop(): boolean {
  const [over, setOver] = useState(false)
  useEffect(() => {
    let depth = 0
    const hasFiles = (e: DragEvent) => !!e.dataTransfer?.types.includes('Files')
    const enter = (e: DragEvent) => {
      if (!hasFiles(e)) return
      depth++
      setOver(true)
    }
    const leave = (e: DragEvent) => {
      if (!hasFiles(e)) return
      depth = Math.max(0, depth - 1)
      if (!depth) setOver(false)
    }
    const overH = (e: DragEvent) => {
      if (!hasFiles(e)) return
      e.preventDefault()
      e.dataTransfer!.dropEffect = 'copy'
    }
    const drop = (e: DragEvent) => {
      if (!hasFiles(e)) return
      e.preventDefault()
      depth = 0
      setOver(false)
      const paths = [...(e.dataTransfer?.files ?? [])].map((f) => window.valence.pathForFile(f)).filter(Boolean)
      if (!paths.length) return
      invoke<{ jobs?: number; files?: number } | number>(IMPORT.importPaths, paths).then(
        (r) => {
          const n = typeof r === 'number' ? r : (r?.jobs ?? r?.files ?? paths.length)
          toast(`Importing ${plural(n, typeof r === 'object' && r?.jobs != null ? 'release' : 'item')}`, 'ok', { label: 'View', run: () => navigate({ view: 'import' }) })
        },
        (err) => toast(errorMessage(err), 'error'),
      )
    }
    window.addEventListener('dragenter', enter)
    window.addEventListener('dragleave', leave)
    window.addEventListener('dragover', overH)
    window.addEventListener('drop', drop)
    return () => {
      window.removeEventListener('dragenter', enter)
      window.removeEventListener('dragleave', leave)
      window.removeEventListener('dragover', overH)
      window.removeEventListener('drop', drop)
    }
  }, [])
  return over
}

/** First run (and Settings → "Run setup again") shows onboarding; e2e runs skip it. */
function useOnboarding(): void {
  const loaded = useLib((s) => Object.keys(s.settings).length > 0)
  useEffect(() => {
    if (!loaded || location.hash.includes('e2e')) return
    if (!setting('ui.onboarded', false)) useUi.getState().setOnboarding(true)
    // Settings → Appearance → Open Valence to.
    const start = setting<string>('ui.startPage', 'last')
    // 'home' is from before the Home page was removed; it opens Albums now.
    if (start === 'home' || start === 'albums') useUi.getState().navigate({ view: 'albums' }, { replace: true })
    else if (start === 'songs' || start === 'liked') useUi.getState().navigate({ view: start }, { replace: true })
  }, [loaded])
}

export function App() {
  const route = useUi((s) => s.route)
  const collapsed = useUi((s) => s.sidebarCollapsed)
  const sidebarW = useUi((s) => s.sidebarW)
  const rightW = useUi((s) => s.rightW)
  const header = useUi((s) => s.header)
  const scrollRef = useRef<HTMLDivElement>(null)
  const glowRef = useRef<HTMLDivElement>(null)
  // Coarse scroll level (0 top, 1 moved, 2 past a header, 3 past a hero) so scrolling doesn't re-render views.
  const [level, setLevel] = useState(0)
  const levelOf = (top: number) => (top > 250 ? 3 : top > 56 ? 2 : top > 4 ? 1 : 0)
  // The header wash sits behind the scroller (so it also runs under the scrollbar) and moves with it.
  const onScroll = (top: number) => {
    setLevel(levelOf(top))
    const g = glowRef.current
    if (g) g.style.transform = `translate3d(0, ${-Math.min(top, 600)}px, 0)`
  }
  const dropping = useFileDrop()
  useShortcuts()
  usePlaybackChrome()
  useOnboarding()

  // Each route starts at the top; back/forward restore where you were.
  const positions = useRef(new Map<string, number>())
  const routeKey = JSON.stringify(route)
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    el.scrollTop = positions.current.get(routeKey) ?? 0
    onScroll(el.scrollTop)
    return () => {
      positions.current.set(routeKey, el.scrollTop)
    }
  }, [routeKey])

  // A header set by a previous route is stale until the new view sets its own.
  const h = header.key === routeKey ? header : { color: null as string | null, strong: false, title: undefined, play: undefined }
  const title = h.title ?? titleOf(route)
  const past = level >= (h.strong ? 3 : 2)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const view = useMemo(() => renderRoute(route), [routeKey])

  const style = {
    '--sidebar-w': `${sidebarWidth(collapsed, sidebarW)}px`,
    '--right-w': `${rightW}px`,
  } as CSSProperties
  const mainStyle = (h.color ? { '--hdr': h.color } : {}) as CSSProperties

  return (
    <ScrollParent.Provider value={scrollRef}>
      <div className={cx('app', `platform-${platform}`)} style={style}>
        <TopBar />
        <Sidebar />
        <main className={cx('main', level > 0 && 'scrolled', h.strong && 'hdr-strong')} style={mainStyle}>
          <div className={cx('main-head', past && 'scrolled')}>
            {h.play && (
              <button className="play-btn xs" title="Play" onClick={h.play}>
                <PlayGlyph />
              </button>
            )}
            {title && <span className="main-head-title">{title}</span>}
          </div>
          <div className="view-glow" ref={glowRef} />
          <div className="content" ref={scrollRef} onScroll={(e) => onScroll((e.target as HTMLElement).scrollTop)}>
            {view}
          </div>
        </main>
        <RightPanel />
        <PlayerBar />
      </div>
      <GetInfo />
      <ArtViewer />
      <CommandPalette />
      <ShortcutsOverlay />
      <Onboarding />
      <Toasts />
      <MenuHost />
      {dropping && <div className="dropzone">Drop to import into your library</div>}
    </ScrollParent.Provider>
  )
}

function PlayGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden>
      <path d="M7 4.8v14.4a1 1 0 0 0 1.5.86l11.6-7.2a1 1 0 0 0 0-1.72L8.5 3.94A1 1 0 0 0 7 4.8z" fill="currentColor" />
    </svg>
  )
}
