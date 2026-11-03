// Sidebar: library sections, playlists (drop tracks onto them), sources, import status.

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { LIB } from '@shared/ipc/library'
import { invoke, errorMessage } from '../lib/ipc'
import { cx, plural } from '../lib/format'
import { useLib } from '../state/library'
import { navigate, toast, useUi, type Route } from '../state/ui'
import { playTracks } from '../state/player'
import { Icon, type IconName } from '../components/Icon'
import { IconButton, ProgressBar, showMenu, usePrompt } from '../components/ui'

const TRACKS_MIME = 'application/x-valence-tracks'

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

function Item({ icon, label, to, extra, onDropTracks, onContextMenu }: { icon: IconName; label: string; to: Route; extra?: ReactNode; onDropTracks?: (ids: number[]) => void; onContextMenu?: (e: React.MouseEvent) => void }) {
  const route = useUi((s) => s.route)
  const [over, setOver] = useState(false)
  return (
    <button
      className={cx('sb-item', same(route, to) && 'on', over && 'drop')}
      onClick={() => navigate(to)}
      onContextMenu={onContextMenu}
      onDragOver={(e) => {
        if (!onDropTracks || !e.dataTransfer.types.includes(TRACKS_MIME)) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'copy'
        setOver(true)
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        setOver(false)
        if (!onDropTracks) return
        const raw = e.dataTransfer.getData(TRACKS_MIME)
        if (!raw) return
        e.preventDefault()
        onDropTracks(JSON.parse(raw) as number[])
      }}
    >
      <Icon name={icon} size={17} />
      <span className="sb-label">{label}</span>
      {extra}
    </button>
  )
}

export function Sidebar() {
  const playlists = useLib((s) => s.playlists)
  const jobs = useLib((s) => s.jobs)
  const paused = useLib((s) => s.pausedSources)
  const stats = useLib((s) => s.stats)
  const scan = useLib((s) => s.scan)
  const [promptNode, prompt] = usePrompt()

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

  const playlistMenu = (e: React.MouseEvent, p: (typeof playlists)[number]) =>
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

  // Expose "New Playlist…" for track context menus.
  useWindowEvent('valence:new-playlist', (e) => void newPlaylist((e as CustomEvent<number[]>).detail ?? []))

  return (
    <nav className="sidebar">
      <div className="sb-top drag">
        <span className="sb-brand">
          <span className="dot" /> Valence
        </span>
      </div>
      <div className="sb-scroll">
        <div className="sb-section">
          <div className="sb-head">Library</div>
          <Item icon="albums" label="Albums" to={{ view: 'albums' }} />
          <Item icon="songs" label="Songs" to={{ view: 'songs' }} />
          <Item icon="artists" label="Artists" to={{ view: 'artists' }} />
          <Item icon="genres" label="Genres" to={{ view: 'genres' }} />
          <Item icon="clock" label="Recently Added" to={{ view: 'recent' }} />
        </div>
        <div className="sb-section">
          <div className="sb-head">SiIvaGunner</div>
          <Item icon="star" label="Seasons" to={{ view: 'rips', tab: 'seasons' }} />
          <Item icon="albums" label="Rip Albums" to={{ view: 'rips', tab: 'albums' }} />
          <Item icon="songs" label="Rip Songs" to={{ view: 'rips', tab: 'songs' }} extra={stats?.ripTracks ? <span className="sb-count">{stats.ripTracks}</span> : undefined} />
        </div>
        <div className="sb-section">
          <div className="sb-head">
            <span>Playlists</span>
            <span className="row" style={{ gap: 0 }}>
              <IconButton icon="smart" size={13} title="New Smart Playlist" onClick={() => navigate({ view: 'smart' })} />
              <IconButton icon="plus" size={14} title="New Playlist" onClick={() => void newPlaylist()} />
            </span>
          </div>
          {playlists.map((p) => (
            <Item
              key={p.id}
              icon={p.kind === 'smart' ? 'smart' : p.kind === 'mirror' ? 'link' : 'playlist'}
              label={p.name}
              to={{ view: 'playlist', id: p.id }}
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
          {!playlists.length && (
            <button className="sb-item faint" onClick={() => void newPlaylist()}>
              <Icon name="plus" size={17} />
              <span className="sb-label">New Playlist</span>
            </button>
          )}
        </div>
        <div className="sb-section">
          <div className="sb-head">Sources</div>
          <Item icon="wave" label="TIDAL" to={{ view: 'tidal' }} extra={paused.tidal ? <span className="sb-pill warn">Paused</span> : undefined} />
          <Item icon="disc" label="Bandcamp" to={{ view: 'bandcamp' }} extra={paused.bandcamp ? <span className="sb-pill warn">Paused</span> : undefined} />
          <Item
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
        </div>
      </div>
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
        <button className="sb-item" style={{ marginLeft: -8 }} onClick={() => navigate({ view: 'settings' })}>
          <Icon name="settings" size={16} />
          <span className="sb-label">Settings</span>
        </button>
      </div>
      {promptNode}
    </nav>
  )
}


function useWindowEvent(name: string, fn: (e: Event) => void): void {
  const ref = useRef(fn)
  ref.current = fn
  useEffect(() => {
    const h = (e: Event) => ref.current(e)
    window.addEventListener(name, h)
    return () => window.removeEventListener(name, h)
  }, [name])
}
