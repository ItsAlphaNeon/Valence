// The phone's Playlists tab: built-in lists (All songs, Favorites, Recently added, Recently played,
// Most played, Not played, Listening history), then your playlists and "New Playlist". Also the
// pages for the built-in lists the desktop didn't have before.

import { LIB } from '@shared/ipc/library'
import type { HistoryEntry, TrackQuery } from '@shared/types'
import { errorMessage, invoke } from '../../lib/ipc'
import { cx, duration, plural, relativeTime } from '../../lib/format'
import { useLib, useLibData } from '../../state/library'
import { useFavorites } from '../../state/favorites'
import { navigate, toast, useUi, type AutoList, type Route } from '../../state/ui'
import { playQuery, playTracks, usePlayer } from '../../state/player'
import { useViewHeader } from '../../shell/header'
import { TrackTable } from '../../components/TrackTable'
import { Artwork, Button, Empty, Spinner, showMenu } from '../../components/ui'
import { Icon, type IconName } from '../../components/Icon'
import type { PlaylistInfo } from '@main/library/playlists'

const BUILTINS: Array<{ label: string; icon: IconName; to: Route }> = [
  { label: 'All songs', icon: 'library', to: { view: 'songs' } },
  { label: 'Favorites', icon: 'heart', to: { view: 'liked' } },
  { label: 'Recently added', icon: 'moreTime', to: { view: 'recent' } },
  { label: 'Recently played', icon: 'history', to: { view: 'auto', list: 'recentlyPlayed' } },
  { label: 'Most played', icon: 'fire', to: { view: 'auto', list: 'mostPlayed' } },
  { label: 'Not played', icon: 'block', to: { view: 'auto', list: 'notPlayed' } },
  { label: 'Listening history', icon: 'clock', to: { view: 'auto', list: 'history' } },
]

function playlistMenu(e: React.MouseEvent, p: PlaylistInfo) {
  showMenu(e, [
    { label: 'Play', icon: 'play', onClick: () => void playQuery({ playlistId: p.id }, undefined, { kind: 'playlist', id: p.id, title: p.name }) },
    { label: 'Shuffle', icon: 'shuffle', onClick: () => void playQuery({ playlistId: p.id }, undefined, { kind: 'playlist', id: p.id, title: p.name }, true) },
    ...(p.kind === 'smart' ? [{ label: 'Edit Rules…', icon: 'smart' as const, onClick: () => navigate({ view: 'smart', id: p.id }) }] : []),
    { separator: true },
    {
      label: 'Delete Playlist',
      icon: 'trash',
      danger: true,
      onClick: () => void invoke(LIB.deletePlaylist, p.id).then(() => toast(`Deleted “${p.name}”`), (err) => toast(errorMessage(err), 'error')),
    },
  ])
}

export function PlaylistsView() {
  const playlists = useLib((s) => s.playlists)
  const favCount = useFavorites((s) => s.counts.tracks)
  const source = usePlayer((s) => s.state?.queue.context.source)
  useViewHeader({ color: null, title: 'Playlists' })
  return (
    <div className="view">
      <div className="view-head">
        <div>
          <h1 className="view-title">Playlists</h1>
          <div className="view-sub">{plural(playlists.length, 'playlist')}</div>
        </div>
      </div>
      <div className="pl-list">
        {BUILTINS.map((b) => (
          <button key={b.label} className="pl-row" onClick={() => navigate(b.to)}>
            <Icon name={b.icon} size={28} filled />
            <span className="grow ellipsis">{b.label}</span>
            {b.to.view === 'liked' && favCount ? <span className="faint tnum">{favCount.toLocaleString()}</span> : null}
          </button>
        ))}
      </div>
      <div className="pl-label">Your playlists</div>
      <div className="pl-list">
        {playlists.map((p) => {
          const playing = source?.kind === 'playlist' && source.id === p.id
          return (
            <button key={p.id} className={cx('pl-row', playing && 'playing')} onClick={() => navigate({ view: 'playlist', id: p.id })} onContextMenu={(e) => playlistMenu(e, p)}>
              <Icon name={p.kind === 'smart' ? 'smart' : 'playlist'} size={28} />
              <span className="grow ellipsis">{p.name}</span>
              <span className="faint">{p.kind === 'smart' ? 'Smart · ' : p.kind === 'mirror' ? 'Mirrored · ' : ''}</span>
              <span className="faint tnum">{plural(p.count, 'song')}</span>
            </button>
          )
        })}
      </div>
      <div className="pl-new">
        <Button icon="plus" onClick={() => window.dispatchEvent(new CustomEvent('valence:new-playlist', { detail: [] }))}>
          New Playlist
        </Button>
        <Button icon="smart" kind="ghost" onClick={() => navigate({ view: 'smart' })}>
          New Smart Playlist
        </Button>
      </div>
    </div>
  )
}

const AUTO: Record<Exclude<AutoList, 'history'>, { title: string; query: TrackQuery; empty: string }> = {
  recentlyPlayed: { title: 'Recently played', query: { played: 'recent' }, empty: 'Songs you play on any of your devices show up here.' },
  mostPlayed: { title: 'Most played', query: { played: 'most' }, empty: 'Songs you play on any of your devices show up here.' },
  notPlayed: { title: 'Not played', query: { played: 'never' }, empty: 'You have played every song in your library.' },
}

export function AutoListView({ list }: { list: AutoList }) {
  if (list === 'history') return <HistoryView />
  return <AutoTracks list={list} />
}

function AutoTracks({ list }: { list: Exclude<AutoList, 'history'> }) {
  const def = AUTO[list]
  const query = def.query
  const src = { kind: 'other' as const, id: list, title: def.title }
  const count = useLibData(() => invoke<{ total: number }>(LIB.tracks, { ...query, limit: 0 }), [list]).data
  useViewHeader({ color: null, title: def.title })
  return (
    <div className="view">
      <div className="view-head">
        <div>
          <h1 className="view-title">{def.title}</h1>
          {count && <div className="view-sub">{plural(count.total, 'song')}</div>}
        </div>
        <div className="view-actions">
          <Button kind="primary" icon="play" onClick={() => void playQuery(query, undefined, src)}>
            Play
          </Button>
          <Button icon="shuffle" onClick={() => void playQuery(query, undefined, src, true)}>
            Shuffle
          </Button>
        </div>
      </div>
      <TrackTable
        query={query}
        source={src}
        showArt
        emptyText={def.empty}
        columns={list === 'mostPlayed' ? ['index', 'title', 'album', 'heart', 'time', 'plays', 'lastPlayed'] : list === 'recentlyPlayed' ? ['index', 'title', 'album', 'heart', 'time', 'lastPlayed', 'plays'] : ['index', 'title', 'album', 'heart', 'time', 'genre', 'year', 'added']}
      />
    </div>
  )
}

/** Every play from every device, newest first (the phone's Listening history). */
function HistoryView() {
  const history = useLibData(() => invoke<HistoryEntry[]>(LIB.history, 500), []).data
  const currentTrackId = usePlayer((s) => s.currentTrackId)
  useViewHeader({ color: null, title: 'Listening history' })
  const ids = history?.map((h) => h.track.id) ?? []
  return (
    <div className="view">
      <div className="view-head">
        <div>
          <h1 className="view-title">Listening history</h1>
          <div className="view-sub">Every play, from all your devices</div>
        </div>
        {ids.length > 0 && (
          <div className="view-actions">
            <Button kind="primary" icon="play" onClick={() => void playTracks(ids, 0, { kind: 'other', id: 'history', title: 'Listening history' })}>
              Play
            </Button>
          </div>
        )}
      </div>
      {!history ? (
        <div className="center-spin">
          <Spinner />
        </div>
      ) : !history.length ? (
        <Empty icon="history" title="Nothing played yet">
          Plays from all your devices show up here.
        </Empty>
      ) : (
        <div className="hist-list">
          {history.map((h, i) => (
            <div
              key={`${h.playedAt}-${i}`}
              className={cx('hist-row', h.track.id === currentTrackId && 'current')}
              onDoubleClick={() => void playTracks(ids, i, { kind: 'other', id: 'history', title: 'Listening history' })}
              onContextMenu={(e) =>
                showMenu(e, [
                  { label: 'Play from here', icon: 'play', onClick: () => void playTracks(ids, i, { kind: 'other', id: 'history', title: 'Listening history' }) },
                  { label: 'Get Info', icon: 'info', onClick: () => useUi.getState().openGetInfo([h.track.id]) },
                ])
              }
            >
              <Artwork hash={h.track.artHash} px={96} title={h.track.album || h.track.title} className="hist-art" />
              <div className="list-main">
                <div className="list-title">{h.track.title}</div>
                <div className="list-sub">{h.track.artist}</div>
                <div className="list-sub">{h.track.album}</div>
              </div>
              <div className="hist-when">
                <span>{relativeTime(h.playedAt)}</span>
                <span className="faint tnum">{duration(h.track.durationMs)}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
