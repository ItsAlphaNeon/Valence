// Left panel ("Your Library"): browse links, SiIvaGunner and sources, then the user's collection —
// Liked Songs, playlists and liked albums/artists with their art. Resizable; collapses to a rail.

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { LIB } from '@shared/ipc/library'
import type { AlbumRow, ArtistRow } from '@shared/types'
import { errorMessage, invoke } from '../lib/ipc'
import { cx, plural } from '../lib/format'
import { useLib } from '../state/library'
import { useFavorites, setLiked } from '../state/favorites'
import { albumRoute, navigate, toast, useUi, SIDEBAR_MIN, type Route } from '../state/ui'
import { playQuery, playTracks, usePlayer } from '../state/player'
import { Icon, type IconName } from '../components/Icon'
import { Artwork, IconButton, ProgressBar, showMenu, usePrompt } from '../components/ui'
import { albumMenu } from '../components/AlbumGrid'
import type { PlaylistInfo } from '@main/library/playlists'

export const TRACKS_MIME = 'application/x-valence-tracks'
const RAIL_W = 72

function same(a: Route, b: Route): boolean {
  // Rip albums highlight the SiIvaGunner list they came from, not the main Albums.
  if (a.view === 'album' && a.rip) return b.view === 'rips' && (b.tab ?? 'seasons') === a.rip
  if (a.view === 'rips' && b.view === 'rips') return (a.tab ?? 'seasons') === (b.tab ?? 'seasons')
  if (a.view !== b.view) {
    // Album/artist/genre detail pages highlight their parent section.
    const parent: Partial<Record<Route['view'], Route['view']>> = { album: 'albums', artist: 'artists', genre: 'genres' }
    return parent[a.view] === b.view
  }
  if (a.view === 'playlist' && b.view === 'playlist') return a.id === b.id
  if (a.view === 'smart' && b.view === 'smart') return a.id === b.id
  return true
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

function Item({ icon, label, to, extra, rail }: { icon: IconName; label: string; to: Route; extra?: ReactNode; rail: boolean }) {
  const route = useUi((s) => s.route)
  const on = same(route, to)
  return (
    <button className={cx('sb-item', on && 'on')} onClick={() => navigate(to)} title={rail ? label : undefined}>
      <Icon name={icon} size={rail ? 24 : 22} />
      <span className="sb-label">{label}</span>
      {extra}
    </button>
  )
}

function Group({ id, title, children, rail }: { id: string; title: string; children: ReactNode; rail: boolean }) {
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
      <button className={cx('sb-group-head', closed && 'closed')} onClick={toggle}>
        <Icon name="chevronDown" size={12} />
        {title}
      </button>
      {(!closed || rail) && children}
    </div>
  )
}

/** A collection entry with art (Liked Songs, a playlist, an album, an artist). */
function Entry({
  art,
  title,
  sub,
  to,
  playing,
  onContextMenu,
  onDropTracks,
  rail,
}: {
  art: ReactNode
  title: string
  sub: ReactNode
  to: Route
  playing?: boolean
  onContextMenu?: (e: React.MouseEvent) => void
  onDropTracks?: (ids: number[]) => void
  rail: boolean
}) {
  const route = useUi((s) => s.route)
  const drop = useDropTracks(onDropTracks)
  const isPlaying = usePlayer((s) => !!s.state?.playing)
  return (
    <button
      className={cx('sb-entry', same(route, to) && JSON.stringify(route) === JSON.stringify(to) && 'on', drop.over && 'drop', playing && 'playing')}
      onClick={() => navigate(to)}
      onContextMenu={onContextMenu}
      title={rail ? title : undefined}
      {...drop.props}
    >
      {art}
      <span className="sb-entry-text">
        <span className="sb-entry-title">{title}</span>
        <span className="sb-entry-sub">{sub}</span>
      </span>
      {playing && !rail && (
        <span className={cx('now-bars', isPlaying && 'on')}>
          <i />
          <i />
          <i />
        </span>
      )}
    </button>
  )
}

type Filter = 'playlists' | 'albums' | 'artists' | null

export function Sidebar() {
  const playlists = useLib((s) => s.playlists)
  const jobs = useLib((s) => s.jobs)
  const paused = useLib((s) => s.pausedSources)
  const stats = useLib((s) => s.stats)
  const scan = useLib((s) => s.scan)
  const counts = useFavorites((s) => s.counts)
  const favAlbums = useFavorites((s) => s.albums)
  const favArtists = useFavorites((s) => s.artists)
  const rail = useUi((s) => s.sidebarCollapsed)
  const source = usePlayer((s) => s.state?.queue.context.source)
  const albumKey = usePlayer((s) => s.state?.current?.albumKey)
  const [filter, setFilter] = useState<Filter>(null)
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
            if ((r.view === 'playlist' || r.view === 'smart') && r.id === p.id) navigate({ view: 'albums' })
          })
        },
      },
    ])

  const favAlbumMenu = (e: React.MouseEvent, a: AlbumRow) => albumMenu(e, a)
  const favArtistMenu = (e: React.MouseEvent, a: ArtistRow) =>
    showMenu(e, [
      { label: 'Play', icon: 'play', onClick: () => void playQuery({ albumArtist: a.name }, undefined, { kind: 'artist', id: a.name, title: a.name }) },
      { label: 'Shuffle', icon: 'shuffle', onClick: () => void playQuery({ albumArtist: a.name }, undefined, { kind: 'artist', id: a.name, title: a.name }, true) },
      { separator: true },
      { label: 'Remove from your library', icon: 'heart', onClick: () => void setLiked({ kind: 'artist', names: [a.name] }, false) },
    ])

  const create = (e: React.MouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
    showMenu({ clientX: r.left, clientY: r.bottom + 6 }, [
      { label: 'Playlist', icon: 'playlist', onClick: () => void newPlaylist() },
      { label: 'Smart Playlist', icon: 'smart', onClick: () => navigate({ view: 'smart' }) },
      { separator: true },
      { label: 'Import Music…', icon: 'inbox', onClick: () => navigate({ view: 'import' }) },
    ])
  }

  useWindowEvent('valence:new-playlist', (e) => void newPlaylist((e as CustomEvent<number[]>).detail ?? []))

  const show = (f: Exclude<Filter, null>) => filter === null || filter === f
  const playingPlaylist = (id: string) => source?.kind === 'playlist' && source.id === id

  return (
    <nav className={cx('sidebar', rail && 'rail')} aria-label="Your Library">
      <div className="sb-head">
        <button className="sb-head-title" onClick={() => useUi.getState().setSidebar({ collapsed: !rail })} title={rail ? 'Expand Your Library' : 'Collapse Your Library'}>
          <Icon name="library" size={24} />
          {!rail && <span>Your Library</span>}
        </button>
        {!rail && <IconButton icon="plus" size={18} title="Create playlist or import" onClick={create} />}
      </div>
      <div className={cx('sb-scroll', shadow && 'shadowed')} onScroll={(e) => setShadow((e.target as HTMLElement).scrollTop > 2)}>
        <Group id="browse" title="Browse" rail={rail}>
          <Item rail={rail} icon="heart" label="Liked Songs" to={{ view: 'liked' }} extra={counts.tracks ? <span className="sb-count">{counts.tracks.toLocaleString()}</span> : undefined} />
          <Item rail={rail} icon="albums" label="Albums" to={{ view: 'albums' }} />
          <Item rail={rail} icon="songs" label="Songs" to={{ view: 'songs' }} />
          <Item rail={rail} icon="artists" label="Artists" to={{ view: 'artists' }} />
          <Item rail={rail} icon="genres" label="Genres" to={{ view: 'genres' }} />
          <Item rail={rail} icon="clock" label="Recently Added" to={{ view: 'recent' }} />
          <Item rail={rail} icon="chart" label="Listening Stats" to={{ view: 'stats' }} />
        </Group>
        {!rail && (
          <>
            <Group id="rips" title="SiIvaGunner" rail={rail}>
              <Item rail={rail} icon="star" label="Seasons" to={{ view: 'rips', tab: 'seasons' }} />
              <Item rail={rail} icon="albums" label="Rip Albums" to={{ view: 'rips', tab: 'albums' }} />
              <Item rail={rail} icon="songs" label="Rip Songs" to={{ view: 'rips', tab: 'songs' }} extra={stats?.ripTracks ? <span className="sb-count">{stats.ripTracks.toLocaleString()}</span> : undefined} />
              <Item rail={rail} icon="download" label="Get Rips" to={{ view: 'hqrip' }} extra={paused.hqrip || paused.youtube ? <span className="sb-pill warn">Paused</span> : undefined} />
            </Group>
            <Group id="sources" title="Sources" rail={rail}>
              <Item rail={rail} icon="wave" label="TIDAL" to={{ view: 'tidal' }} extra={paused.tidal ? <span className="sb-pill warn">Paused</span> : undefined} />
              <Item rail={rail} icon="disc" label="Bandcamp" to={{ view: 'bandcamp' }} extra={paused.bandcamp ? <span className="sb-pill warn">Paused</span> : undefined} />
              <Item
                rail={rail}
                icon="inbox"
                label="Import"
                to={{ view: 'import' }}
                extra={
                  review ? (
                    <span className="sb-pill warn" title="Needs review">
                      {review}
                    </span>
                  ) : active ? (
                    <span className="sb-pill">{active}</span>
                  ) : failed ? (
                    <span className="sb-count" style={{ color: 'var(--danger)' }}>
                      {failed} failed
                    </span>
                  ) : undefined
                }
              />
            </Group>
          </>
        )}
        <div className="sb-divider" />
        <div className="sb-lib-head">
          {(['playlists', 'albums', 'artists'] as const).map((f) => (
            <button key={f} className={cx('pill sm', filter === f && 'on')} onClick={() => setFilter(filter === f ? null : f)}>
              {f === 'playlists' ? 'Playlists' : f === 'albums' ? 'Albums' : 'Artists'}
            </button>
          ))}
        </div>
        {show('playlists') && (
          <Entry
            rail={rail}
            art={
              <span className="sb-tile liked">
                <Icon name="heart" size={20} filled />
              </span>
            }
            title="Liked Songs"
            sub={
              <>
                <Icon name="pin" size={12} /> Playlist · {plural(counts.tracks, 'song')}
              </>
            }
            to={{ view: 'liked' }}
            playing={source?.kind === 'playlist' && source.id === 'liked'}
            onDropTracks={(ids) => void setLiked({ kind: 'track', ids }, true)}
          />
        )}
        {show('playlists') &&
          playlists.map((p) => (
            <Entry
              key={p.id}
              rail={rail}
              art={
                <span className="sb-tile">
                  <Icon name={p.kind === 'smart' ? 'smart' : p.kind === 'mirror' ? 'link' : 'playlist'} size={22} />
                </span>
              }
              title={p.name}
              sub={p.kind === 'smart' ? 'Smart playlist' : p.kind === 'mirror' ? 'Mirrored playlist' : 'Playlist'}
              to={{ view: 'playlist', id: p.id }}
              playing={playingPlaylist(p.id)}
              onContextMenu={(e) => playlistMenu(e, p)}
              onDropTracks={
                p.kind === 'static'
                  ? (ids) =>
                      void invoke(LIB.addToPlaylist, p.id, ids).then(
                        () => toast(`Added ${plural(ids.length, 'song')} to “${p.name}”`, 'ok'),
                        (err) => toast(errorMessage(err), 'error'),
                      )
                  : undefined
              }
            />
          ))}
        {show('albums') &&
          favAlbums.map((a) => (
            <Entry
              key={`a${a.id}`}
              rail={rail}
              art={<Artwork hash={a.artHash} px={96} title={a.title} />}
              title={a.title}
              sub={`Album · ${a.albumArtist}`}
              to={albumRoute(a.id, a.hqRip)}
              playing={albumKey === `a${a.id}`}
              onContextMenu={(e) => favAlbumMenu(e, a)}
            />
          ))}
        {show('artists') &&
          favArtists.map((a) => (
            <Entry
              key={`r${a.name}`}
              rail={rail}
              art={<Artwork hash={a.artHash} px={96} title={a.name} className="round" />}
              title={a.name}
              sub="Artist"
              to={{ view: 'artist', artist: a.name }}
              playing={source?.kind === 'artist' && source.id === a.name}
              onContextMenu={(e) => favArtistMenu(e, a)}
            />
          ))}
        {!rail && filter === 'albums' && !favAlbums.length && <div className="sb-foot">Albums you like show up here. Click the heart on any album.</div>}
        {!rail && filter === 'artists' && !favArtists.length && <div className="sb-foot">Artists you like show up here. Click the heart on an artist page.</div>}
        {!rail && filter !== 'albums' && filter !== 'artists' && !playlists.length && (
          <button className="sb-item faint" onClick={() => void newPlaylist()}>
            <Icon name="plus" size={20} />
            <span className="sb-label">New Playlist</span>
          </button>
        )}
      </div>
      {!rail && (
        <div className="sb-foot">
          {scan && scan.total > 0 ? (
            <>
              <span>
                Scanning {scan.done.toLocaleString()} / {scan.total.toLocaleString()}
              </span>
              <ProgressBar value={scan.done / scan.total} />
            </>
          ) : stats ? (
            <span>
              {plural(stats.tracks, 'song')} · {plural(stats.albums, 'album')}
            </span>
          ) : null}
        </div>
      )}
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
