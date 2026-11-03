// App shell: sidebar | content (+ floating toolbar and player bar) | drawer. Routes render into a
// single scroll container that virtualized lists use as their scroll parent.

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { IMPORT } from '@shared/ipc/import'
import { errorMessage, invoke, platform } from '../lib/ipc'
import { cx, plural } from '../lib/format'
import { navigate, toast, useUi, type Route } from '../state/ui'
import { cmd, usePlayer } from '../state/player'
import { ScrollParent } from '../components/TrackTable'
import { MenuHost } from '../components/ui'
import { LiquidFilter } from '../theme/LiquidFilter'
import { Backdrop } from './Backdrop'
import { Sidebar } from './Sidebar'
import { Toolbar } from './Toolbar'
import { PlayerBar } from './PlayerBar'
import { Drawer } from './Drawer'
import { Toasts } from './Toasts'
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
    case 'search':
      return `“${r.q}”`
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

function useShortcuts(): void {
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey
      if (e.altKey && e.key === 'ArrowLeft') return useUi.getState().goBack()
      if (e.altKey && e.key === 'ArrowRight') return useUi.getState().goForward()
      if (mod && e.key === ',') return navigate({ view: 'settings' })
      if (mod && e.key.toLowerCase() === 'l') {
        e.preventDefault()
        return useUi.getState().toggleDrawer('lyrics')
      }
      if (mod && e.key.toLowerCase() === 'u') {
        e.preventDefault()
        return useUi.getState().toggleDrawer('queue')
      }
      if (isTyping(e.target)) return
      if (e.key === ' ' && !(e.target instanceof HTMLButtonElement)) {
        e.preventDefault()
        cmd({ type: 'toggle' })
      } else if (mod && e.key === 'ArrowRight') cmd({ type: 'next' })
      else if (mod && e.key === 'ArrowLeft') cmd({ type: 'prev' })
      else if (mod && e.key === 'ArrowUp') cmd({ type: 'setVolume', volume: Math.min(1, (usePlayer.getState().state?.volume ?? 1) + 0.05) })
      else if (mod && e.key === 'ArrowDown') cmd({ type: 'setVolume', volume: Math.max(0, (usePlayer.getState().state?.volume ?? 1) - 0.05) })
      else if (e.key === 'Escape' && useUi.getState().drawer) useUi.getState().setDrawer(null)
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

export function App() {
  const route = useUi((s) => s.route)
  const drawer = useUi((s) => s.drawer)
  const collapsed = useUi((s) => s.sidebarCollapsed)
  const scrollRef = useRef<HTMLDivElement>(null)
  const [scrolled, setScrolled] = useState(false)
  const dropping = useFileDrop()
  useShortcuts()

  // Each route starts at the top; back/forward restore where you were.
  const positions = useRef(new Map<string, number>())
  const routeKey = JSON.stringify(route)
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    el.scrollTop = positions.current.get(routeKey) ?? 0
    setScrolled(el.scrollTop > 4)
    return () => {
      positions.current.set(routeKey, el.scrollTop)
    }
  }, [routeKey])

  return (
    <ScrollParent.Provider value={scrollRef}>
      <LiquidFilter />
      <Backdrop />
      <div className={cx('app', `platform-${platform}`, drawer && 'drawer-open', collapsed && 'sidebar-collapsed')}>
        <Sidebar />
        <main className="main">
          <Toolbar scrolled={scrolled} title={titleOf(route)} />
          <div className="content" ref={scrollRef} onScroll={(e) => setScrolled((e.target as HTMLElement).scrollTop > 4)}>
            {renderRoute(route)}
          </div>
          <PlayerBar />
        </main>
        <Drawer />
      </div>
      <GetInfo />
      <Toasts />
      <MenuHost />
      {dropping && <div className="dropzone">Drop to import into your library</div>}
    </ScrollParent.Provider>
  )
}
