// Left sidebar: the Android app's (Musicolet's) tabs, top to bottom (Queue, Now playing, Albums,
// Artists, Genres, SiivaGunner, Playlists), then the desktop's sources, then your playlists by name
// (Favorites first). Drop songs on a playlist to add them. Resizable; collapses to an icon rail.

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { LIB } from '@shared/ipc/library'
import { errorMessage, invoke } from '../lib/ipc'
import { cx, plural } from '../lib/format'
import { useLib } from '../state/library'
import { useFavorites, setLiked } from '../state/favorites'
import { navigate, toast, useUi, SIDEBAR_MIN, type Route } from '../state/ui'
import { playTracks, usePlayer } from '../state/player'
import { Icon, type IconName } from '../components/Icon'
import { IconButton, ProgressBar, showMenu, usePrompt } from '../components/ui'
import type { PlaylistInfo } from '@main/library/playlists'

export const TRACKS_MIME = 'application/x-valence-tracks'
const RAIL_W = 64

/** Which sidebar item a route belongs to (detail pages light up their tab). */
function sectionOf(r: Route): string {
  switch (r.view) {
    case 'album':
      return r.rip ? 'rips' : 'albums'
    case 'artist':
      return 'artists'
    case 'genre':
      return 'genres'
    case 'rips':
    case 'game':
      return 'rips'
    case 'songs':
    case 'recent':
    case 'auto':
    case 'smart':
    case 'playlists':
      return 'playlists'
    case 'liked':
      return 'liked'
    case 'playlist':
      return `playlist:${r.id}`
    default:
      return r.view
  }
}

function useDropTracks(onDrop?: (ids: number[]) => void) {
  const [over, setOver] = useState(false)
  if (!onDrop) return { over: false, props: {} }
  return {
    over,
    props: {
      onDragOver: (e: React.DragEvent) => {
        if (!e.dataTransfer.types.includes(TRACKS_MIME)) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'copy'
        setOver(true)
      },
      onDragLeave: () => setOver(false),
      onDrop: (e: React.DragEvent) => {
        setOver(false)
        const raw = e.dataTransfer.getData(TRACKS_MIME)
        if (!raw) return
        e.preventDefault()
        onDrop(JSON.parse(raw) as number[])
      },
    },
  }
}

function Item({
  icon,
  label,
  to,
  section,
  extra,
  rail,
  filled,
  playing,
  onContextMenu,
  onDropTracks,
}: {
  icon: IconName
  label: string
  to: Route
  /** Defaults to the section of `to`. */
  section?: string
  extra?: ReactNode
  rail: boolean
  filled?: boolean
  /** It's the source of what's playing (a playlist): shows the playing icon. */
  playing?: boolean
  onContextMenu?: (e: React.MouseEvent) => void
  onDropTracks?: (ids: number[]) => void
}) {
  const current = useUi((s) => sectionOf(s.route))
  const drop = useDropTracks(onDropTracks)
  const on = current === (section ?? sectionOf(to))
  return (
    <button
      className={cx('sb-item', on && 'on', drop.over && 'drop', playing && 'playing')}
      onClick={() => navigate(to)}
      onContextMenu={onContextMenu}
      title={rail ? label : undefined}
      {...drop.props}
    >
      <Icon name={icon} size={rail ? 26 : 24} filled={filled} />
      <span className="sb-label">{label}</span>
      {playing && !rail ? <Icon name="volume" size={16} className="sb-playing" /> : extra}
    </button>
  )
}

function Group({ id, title, children, rail, action }: { id: string; title: string; children: ReactNode; rail: boolean; action?: ReactNode }) {
  const [closed, setClosed] = useState(() => {
    try {
      return (JSON.parse(localStorage.getItem('valence.ui.sbClosed') ?? '[]') as string[]).includes(id)
    } catch {
      return false
    }
  })
  const toggle = () => {
    const next = !closed
    setClosed(next)
    try {
      const all = new Set(JSON.parse(localStorage.getItem('valence.ui.sbClosed') ?? '[]') as string[])
      if (next) all.add(id)
      else all.delete(id)
      localStorage.setItem('valence.ui.sbClosed', JSON.stringify([...all]))
    } catch {
      /* storage unavailable */
    }
  }
  return (
    <div className="sb-group">
      {!rail && (
        <div className="sb-group-row">
          <button className={cx('sb-group-head', closed && 'closed')} onClick={toggle}>
            {title}
            <Icon name="chevronDown" size={16} />
          </button>
          {action}
        </div>
      )}
      {(!closed || rail) && children}
    </div>
  )
}

export function Sidebar() {
  const playlists = useLib((s) => s.playlists)
  const jobs = useLib((s) => s.jobs)
  const paused = useLib((s) => s.pausedSources)
  const stats = useLib((s) => s.stats)
  const scan = useLib((s) => s.scan)
  const counts = useFavorites((s) => s.counts)
  const rail = useUi((s) => s.sidebarCollapsed)
  const source = usePlayer((s) => s.state?.queue.context.source)
  const [promptNode, prompt] = usePrompt()
  const [shadow, setShadow] = useState(false)

  const active = jobs.filter((j) => j.status === 'running' || j.status === 'queued').length
  const review = jobs.filter((j) => j.status === 'review').length
  const failed = jobs.filter((j) => j.status === 'failed').length

  const newPlaylist = async (ids: number[] = []) => {
    const name = await prompt({ title: 'New Playlist', label: 'Name', initial: '', ok: 'Create' })
    if (!name) return
    try {
      const id = await invoke<string>(LIB.createPlaylist, name, ids)
      navigate({ view: 'playlist', id })
    } catch (e) {
      toast(errorMessage(e), 'error')
    }
  }

  const playlistMenu = (e: React.MouseEvent, p: PlaylistInfo) =>
    showMenu(e, [
      { label: 'Play', icon: 'play', onClick: () => void invoke<{ id: number }[]>(LIB.playlistTracks, p.id).then((rows) => playTracks(rows.map((r) => r.id), 0, { kind: 'playlist', id: p.id, title: p.name })) },
      ...(p.kind === 'smart' ? [{ label: 'Edit Rules…', icon: 'smart' as const, onClick: () => navigate({ view: 'smart', id: p.id }) }] : []),
      {
        label: 'Rename…',
        icon: 'edit',
        disabled: p.kind === 'mirror',
        onClick: async () => {
          const name = await prompt({ title: 'Rename Playlist', label: 'Name', initial: p.name, ok: 'Rename' })
          if (name && name !== p.name) {
            if (p.kind === 'smart') await invoke(LIB.saveSmartPlaylist, name, p.rules, p.id)
            else await invoke(LIB.renamePlaylist, p.id, name).catch((err) => toast(errorMessage(err), 'error'))
          }
        },
      },
      { separator: true },
      {
        label: 'Delete Playlist',
        icon: 'trash',
        danger: true,
        onClick: () => {
          void invoke(LIB.deletePlaylist, p.id).then(() => {
            toast(`Deleted “${p.name}”`)
            const r = useUi.getState().route
            if ((r.view === 'playlist' || r.view === 'smart') && r.id === p.id) navigate({ view: 'playlists' })
          })
        },
      },
    ])

  const create = (e: React.MouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
    showMenu({ clientX: r.left, clientY: r.bottom + 6 }, [
      { label: 'Playlist', icon: 'playlistAdd', onClick: () => void newPlaylist() },
      { label: 'Smart Playlist', icon: 'smart', onClick: () => navigate({ view: 'smart' }) },
    ])
  }

  useWindowEvent('valence:new-playlist', (e) => void newPlaylist((e as CustomEvent<number[]>).detail ?? []))

  const pill = (text: ReactNode, warn = false) => <span className={cx('sb-pill', warn && 'warn')}>{text}</span>

  return (
    <nav className={cx('sidebar', rail && 'rail')} aria-label="Navigation">
      <div className={cx('sb-scroll', shadow && 'shadowed')} onScroll={(e) => setShadow((e.target as HTMLElement).scrollTop > 2)}>
        <div className="sb-group sb-tabs">
          <Item rail={rail} icon="queue" label="Queue" to={{ view: 'queue' }} />
          <Item rail={rail} icon="playCircle" label="Now playing" to={{ view: 'nowplaying' }} />
          <Item rail={rail} icon="albums" label="Albums" to={{ view: 'albums' }} />
          <Item rail={rail} icon="artists" label="Artists" to={{ view: 'artists' }} />
          <Item rail={rail} icon="genres" label="Genres" to={{ view: 'genres' }} />
          <Item rail={rail} icon="rips" label="SiivaGunner" to={{ view: 'rips' }} />
          <Item rail={rail} icon="library" label="Playlists" to={{ view: 'playlists' }} />
          <Item rail={rail} icon="chart" label="Listening stats" to={{ view: 'stats' }} />
        </div>
        <Group id="sources" title="Get music" rail={rail}>
          <Item rail={rail} icon="download" label="Get Rips" to={{ view: 'hqrip' }} extra={paused.hqrip || paused.youtube ? pill('Paused', true) : undefined} />
          <Item rail={rail} icon="wave" label="TIDAL" to={{ view: 'tidal' }} extra={paused.tidal ? pill('Paused', true) : undefined} />
          <Item rail={rail} icon="store" label="Bandcamp" to={{ view: 'bandcamp' }} extra={paused.bandcamp ? pill('Paused', true) : undefined} />
          <Item
            rail={rail}
            icon="inbox"
            label="Import"
            to={{ view: 'import' }}
            extra={review ? pill(review, true) : active ? pill(active) : failed ? <span className="sb-count danger">{failed} failed</span> : undefined}
          />
        </Group>
        <Group id="playlists" title="Your playlists" rail={rail} action={<IconButton icon="plus" size={20} title="New playlist" onClick={create} />}>
          <Item
            rail={rail}
            icon="heart"
            filled
            label="Favorites"
            to={{ view: 'liked' }}
            playing={source?.kind === 'playlist' && source.id === 'liked'}
            extra={counts.tracks ? <span className="sb-count">{counts.tracks.toLocaleString()}</span> : undefined}
            onDropTracks={(ids) => void setLiked({ kind: 'track', ids }, true)}
          />
          {playlists.map((p) => (
            <Item
              key={p.id}
              rail={rail}
              icon={p.kind === 'smart' ? 'smart' : 'playlist'}
              label={p.name}
              to={{ view: 'playlist', id: p.id }}
              playing={source?.kind === 'playlist' && source.id === p.id}
              extra={<span className="sb-count">{p.count.toLocaleString()}</span>}
              onContextMenu={(e) => playlistMenu(e, p)}
              onDropTracks={
                p.kind !== 'smart'
                  ? (ids) =>
                      void invoke(LIB.addToPlaylist, p.id, ids).then(
                        () => toast(`Added ${plural(ids.length, 'song')} to “${p.name}”`, 'ok'),
                        (err) => toast(errorMessage(err), 'error'),
                      )
                  : undefined
              }
            />
          ))}
          {!rail && (
            <button className="sb-item faint" onClick={() => void newPlaylist()}>
              <Icon name="plus" size={24} />
              <span className="sb-label">New Playlist</span>
            </button>
          )}
        </Group>
      </div>
      <div className="sb-foot">
        {!rail &&
          (scan && scan.total > 0 ? (
            <span className="grow">
              Scanning {scan.done.toLocaleString()} / {scan.total.toLocaleString()}
              <ProgressBar value={scan.done / scan.total} />
            </span>
          ) : stats ? (
            <span className="grow">
              {plural(stats.tracks, 'song')} · {plural(stats.albums, 'album')}
            </span>
          ) : (
            <span className="grow" />
          ))}
        <IconButton
          icon={rail ? 'chevronRight' : 'collapse'}
          size={20}
          title={rail ? 'Expand the sidebar' : 'Collapse the sidebar'}
          onClick={() => useUi.getState().setSidebar({ collapsed: !rail })}
        />
      </div>
      <ResizeHandle />
      {promptNode}
    </nav>
  )
}

function ResizeHandle() {
  const [drag, setDrag] = useState(false)
  return (
    <div
      className={cx('sb-resize', drag && 'dragging')}
      title="Drag to resize · double-click to collapse"
      onDoubleClick={() => useUi.getState().setSidebar({ collapsed: !useUi.getState().sidebarCollapsed })}
      onPointerDown={(e) => {
        const el = e.currentTarget
        el.setPointerCapture(e.pointerId)
        setDrag(true)
        const left = el.parentElement!.getBoundingClientRect().left
        const move = (ev: PointerEvent) => {
          const w = ev.clientX - left
          if (w < SIDEBAR_MIN - 60) useUi.getState().setSidebar({ collapsed: true })
          else useUi.getState().setSidebar({ collapsed: false, width: w })
        }
        const up = () => {
          setDrag(false)
          el.removeEventListener('pointermove', move)
          el.removeEventListener('pointerup', up)
        }
        el.addEventListener('pointermove', move)
        el.addEventListener('pointerup', up)
      }}
    />
  )
}

export const sidebarWidth = (collapsed: boolean, w: number) => (collapsed ? RAIL_W : w)

function useWindowEvent(name: string, fn: (e: Event) => void): void {
  const ref = useRef(fn)
  ref.current = fn
  useEffect(() => {
    const h = (e: Event) => ref.current(e)
    window.addEventListener(name, h)
    return () => window.removeEventListener(name, h)
  }, [name])
}
