import { LIB, type SearchResult } from '@shared/ipc/library'
import type { AlbumRow, ArtistRow, TrackRow } from '@shared/types'
import { errorMessage, invoke, revealLabel } from '../../lib/ipc'
import { cx, duration, quality } from '../../lib/format'
import { cmd, playQuery, playTracks, usePlayer } from '../../state/player'
import { useCurrentLyrics, useCurrentTrack } from '../../state/current'
import { albumRoute, navigate, toast, useUi } from '../../state/ui'
import { useLib, useLibData, useSetting } from '../../state/library'
import { useHeaderColor } from '../../theme/accent'
import { useViewHeader } from '../../shell/header'
import { LyricsView } from '../../shell/LyricsView'
import { AlbumTile, albumMenu } from '../../components/AlbumGrid'
import { PlayButton, Shelf, useSourcePlaying } from '../../components/Hero'
import { TrackTable } from '../../components/TrackTable'
import { HeartButton } from '../../components/Heart'
import { Artwork, Button, Empty, IconButton, Spinner, showMenu } from '../../components/ui'
import { QueueList } from '../../components/QueueList'
import { Seek, sleepMenuItems } from '../../shell/PlayerBar'
import { Icon } from '../../components/Icon'
import { ArtistTile, artistMenu } from './Artists'

/**
 * The phone's Now playing screen: big cover, the title with artist and album under it, heart / info
 * / add to playlist / options and repeat / shuffle, the seek row and the controls. Lyrics (or what's
 * up next) sit beside it on wide windows. The blurred cover behind it comes from the shell
 * (NowPlayingBackdrop), so it reaches under the player bar too.
 */
export function NowPlayingView() {
  const cur = usePlayer((s) => s.state?.current)
  const playing = usePlayer((s) => !!s.state?.playing)
  const shuffle = usePlayer((s) => !!s.state?.shuffle)
  const repeat = usePlayer((s) => s.state?.repeat ?? 'off')
  const hash = usePlayer((s) => s.currentArtHash)
  const track = useCurrentTrack()
  const { lyrics } = useCurrentLyrics()
  const playlists = useLib((s) => s.playlists)
  const [side, setSide] = useSetting<'lyrics' | 'next'>('ui.np.side', 'lyrics')
  useViewHeader({ color: null, title: cur?.title ?? 'Now playing' })
  if (!cur)
    return (
      <div className="view">
        <Empty icon="playCircle" title="Nothing playing">
          Pick a song in Albums, Artists or Playlists.
        </Empty>
      </div>
    )
  const openArt = () => useUi.getState().openArt({ hash, url: hash ? undefined : cur.artUrl, albumId: track?.albumId, title: cur.album || cur.title, sub: cur.artist })
  const rip = !!track?.hqRip
  const line2 = rip && track?.ripGame ? track.ripGame : cur.artist
  const goLine2 = () => (rip && track?.ripGame ? navigate({ view: 'game', game: track.ripGame }) : navigate({ view: 'artist', artist: track?.albumArtist || cur.artist }))
  const goAlbum = () => track?.albumId != null && navigate(albumRoute(track.albumId, track.hqRip))
  const addTo = (e: React.MouseEvent) => {
    if (!track) return
    showMenu(e, [
      { label: 'New playlist…', icon: 'plus', onClick: () => window.dispatchEvent(new CustomEvent('valence:new-playlist', { detail: [track.id] })) },
      ...(playlists.some((p) => p.kind !== 'smart') ? [{ separator: true } as const] : []),
      ...playlists
        .filter((p) => p.kind !== 'smart')
        .map((p) => ({
          label: p.name,
          icon: 'playlist' as const,
          onClick: () => void invoke(LIB.addToPlaylist, p.id, [track.id]).then(() => toast(`Added to “${p.name}”`, 'ok'), (err) => toast(errorMessage(err), 'error')),
        })),
    ])
  }
  const options = (e: React.MouseEvent) =>
    showMenu(e, [
      ...(track?.albumId != null ? [{ label: 'Go to album', icon: 'albums' as const, onClick: goAlbum }] : []),
      { label: rip && track?.ripGame ? 'Go to game' : 'Go to artist', icon: rip ? ('rips' as const) : ('artists' as const), onClick: goLine2 },
      { label: 'View artwork', icon: 'image', onClick: openArt },
      ...(track ? [{ label: revealLabel, icon: 'folder' as const, onClick: () => void invoke(LIB.reveal, track.id) }] : []),
      { separator: true },
      ...sleepMenuItems(usePlayer.getState().state?.sleep ?? { mode: 'off' }, !!usePlayer.getState().state?.stopAfterCurrent),
    ])
  return (
    <div className={cx('nowplaying', side === 'next' && 'side-next')}>
      <div className="np-player">
        <button className="np-art-btn" title="View artwork" onClick={openArt}>
          <Artwork hash={hash} url={hash ? undefined : cur.artUrl} px={1000} className={cx('np-art', !playing && 'paused')} title={cur.album} />
        </button>
        <div className="np-title" title={cur.title}>
          {cur.title}
        </div>
        <a className="np-line" onClick={goLine2}>
          {line2}
        </a>
        {cur.album && (
          <a className="np-line" onClick={goAlbum}>
            {cur.album}
          </a>
        )}
        <div className="np-quick">
          {track && <HeartButton target={{ kind: 'track', id: track.id }} liked={track.liked} size={24} />}
          <IconButton icon="info" size={24} title="Song info" disabled={!track} onClick={() => track && useUi.getState().openGetInfo([track.id])} />
          <IconButton icon="playlistAdd" size={24} title="Add to playlists" disabled={!track} onClick={addTo} />
          <IconButton icon="more" size={24} title="Options for this song" onClick={options} />
          <span className="grow" />
          <IconButton
            icon={repeat === 'one' ? 'repeatOne' : 'repeat'}
            size={24}
            active={repeat !== 'off'}
            title={repeat === 'off' ? 'Repeat: off' : repeat === 'all' ? 'Repeat: queue' : 'Repeat: this song'}
            onClick={() => cmd({ type: 'cycleRepeat' })}
          />
          <IconButton icon="shuffle" size={24} active={shuffle} title={shuffle ? 'Shuffle: on' : 'Shuffle: off'} onClick={() => cmd({ type: 'setShuffle', shuffle: !shuffle })} />
        </div>
        <Seek />
        <div className="np-controls">
          <NpVolume />
          <IconButton icon="prev" size={40} title="Previous" onClick={() => cmd({ type: 'prev' })} />
          <IconButton className="np-play" icon={playing ? 'pause' : 'play'} size={64} title={playing ? 'Pause' : 'Play'} onClick={() => cmd({ type: 'toggle' })} />
          <IconButton icon="next" size={40} title="Next" onClick={() => cmd({ type: 'next' })} />
          <IconButton icon="eq" size={22} title="Equalizer" onClick={() => navigate({ view: 'settings', section: 'playback' })} />
        </div>
      </div>
      <div className="np-side">
        <div className="pill-row np-side-tabs">
          <button className={cx('pill', side === 'lyrics' && 'on')} onClick={() => setSide('lyrics')}>
            Lyrics
          </button>
          <button className={cx('pill', side === 'next' && 'on')} onClick={() => setSide('next')}>
            Up next
          </button>
        </div>
        <div className="np-side-body lyrics-scroll">
          {side === 'next' ? (
            <QueueList />
          ) : lyrics ? (
            <LyricsView big />
          ) : (
            <Empty icon="lyrics" title="No lyrics for this song">
              Valence looks lyrics up on import. You can add them in Get Info.
            </Empty>
          )}
        </div>
      </div>
    </div>
  )
}

/** Volume on the player screen: the speaker mutes; scroll on it to change the volume. */
function NpVolume() {
  const volume = usePlayer((s) => s.state?.volume ?? 1)
  const muted = usePlayer((s) => !!s.state?.muted)
  return (
    <span onWheel={(e) => cmd({ type: 'setVolume', volume: Math.min(1, Math.max(0, volume - Math.sign(e.deltaY) * 0.05)) })}>
      <IconButton
        icon={muted || volume === 0 ? 'mute' : volume < 0.5 ? 'volumeLow' : 'volume'}
        size={22}
        title={`${muted ? 'Unmute' : 'Mute'} · volume ${Math.round(volume * 100)}% (scroll to change)`}
        onClick={() => cmd({ type: 'setMuted', muted: !muted })}
      />
    </span>
  )
}

/** The blurred, darkened cover behind Now playing (main area and player bar), as on the phone. */
export function NowPlayingBackdrop() {
  const cur = usePlayer((s) => s.state?.current)
  const hash = usePlayer((s) => s.currentArtHash)
  return (
    <div className="np-backdrop" aria-hidden>
      {cur && <Artwork hash={hash} url={hash ? undefined : cur.artUrl} px={300} className="np-backdrop-art" title={cur.album} />}
    </div>
  )
}

type Top = { kind: 'artist'; a: ArtistRow } | { kind: 'album'; a: AlbumRow } | { kind: 'track'; t: TrackRow }

function topResult(q: string, d: SearchResult): Top | null {
  const n = q.trim().toLowerCase()
  const artist = d.artists.find((a) => a.name.toLowerCase() === n)
  if (artist) return { kind: 'artist', a: artist }
  const album = d.albums.find((a) => a.title.toLowerCase() === n)
  if (album) return { kind: 'album', a: album }
  const track = d.tracks.find((t) => t.title.toLowerCase() === n)
  if (track) return { kind: 'track', t: track }
  if (d.artists[0]?.name.toLowerCase().startsWith(n)) return { kind: 'artist', a: d.artists[0] }
  if (d.albums[0]) return { kind: 'album', a: d.albums[0] }
  if (d.artists[0]) return { kind: 'artist', a: d.artists[0] }
  return d.tracks[0] ? { kind: 'track', t: d.tracks[0] } : null
}

function TopResult({ top, q }: { top: Top; q: string }) {
  const match = (s: { kind: string; id?: string } | null | undefined) =>
    top.kind === 'artist' ? s?.kind === 'artist' && s.id === top.a.name : top.kind === 'album' ? s?.kind === 'album' && s.id === String(top.a.id) : s?.kind === 'search' && s.id === q
  const now = useSourcePlaying(match)
  const art = top.kind === 'track' ? top.t.artHash : top.a.artHash
  const title = top.kind === 'artist' ? top.a.name : top.kind === 'album' ? top.a.title : top.t.title
  const open = () => (top.kind === 'artist' ? navigate({ view: 'artist', artist: top.a.name }) : top.kind === 'album' ? navigate(albumRoute(top.a.id, top.a.hqRip)) : top.t.albumId != null && navigate(albumRoute(top.t.albumId, top.t.hqRip)))
  const play = () => {
    if (top.kind === 'artist') void playQuery({ albumArtist: top.a.name }, undefined, { kind: 'artist', id: top.a.name, title: top.a.name })
    else if (top.kind === 'album') void invoke<number[]>(LIB.trackIds, { albumId: top.a.id }).then((ids) => playTracks(ids, 0, { kind: 'album', id: String(top.a.id), title: top.a.title }))
    else void playTracks([top.t.id], 0, { kind: 'search', id: q, title: `“${q}”` })
  }
  return (
    <div
      className="top-result"
      onClick={open}
      onContextMenu={(e) => (top.kind === 'artist' ? artistMenu(e, top.a) : top.kind === 'album' ? albumMenu(e, top.a) : undefined)}
    >
      <Artwork hash={art} px={300} className={cx('top-art', top.kind === 'artist' && 'round')} title={title} />
      <div className="top-title ellipsis">{title}</div>
      <div className="top-sub">
        <span className="chip">{top.kind === 'artist' ? 'Artist' : top.kind === 'album' ? 'Album' : 'Song'}</span>
        {top.kind === 'album' && <span className="ellipsis">{top.a.albumArtist}</span>}
        {top.kind === 'track' && <span className="ellipsis">{top.t.artist}</span>}
      </div>
      <span className="top-play">
        <PlayButton onPlay={play} current={now.current} playing={now.playing} title={`Play ${title}`} />
      </span>
    </div>
  )
}

export function SearchView({ q }: { q: string }) {
  const { data, loading } = useLibData(() => invoke<SearchResult>(LIB.search, q), [q])
  useViewHeader({ color: null, title: `“${q}”` })
  const src = { kind: 'search' as const, id: q, title: `“${q}”` }
  const none = data && !data.tracks.length && !data.albums.length && !data.artists.length
  const top = data ? topResult(q, data) : null
  return (
    <div className={cx('view search-view', loading && data && 'refetching')}>
      <div className="view-head">
        <div>
          <h1 className="view-title">Results for “{q}”</h1>
          {data && !none && (
            <div className="view-sub">
              {[data.artists.length && `${data.artists.length} artists`, data.albums.length && `${data.albums.length} albums`, data.tracks.length && `${data.tracks.length} songs`].filter(Boolean).join(' · ')}
            </div>
          )}
        </div>
        <div className="view-actions">
          <Button icon="wave" onClick={() => navigate({ view: 'tidal', tab: 'search', id: q })}>
            Search TIDAL
          </Button>
        </div>
      </div>
      {!data && loading && (
        <div className="center-spin">
          <Spinner />
        </div>
      )}
      {none && (
        <Empty icon="search" title={`No matches for “${q}” in your library`}>
          Check the spelling, try fewer words, or search TIDAL.
        </Empty>
      )}
      {data && top && (
        <div className="search-top">
          <section>
            <h2 className="section-title">Top result</h2>
            <TopResult top={top} q={q} />
          </section>
          {data.tracks.length > 0 && (
            <section className="search-top-songs">
              <h2 className="section-title">Songs</h2>
              <div className="mini-tracks">
                {data.tracks.slice(0, 4).map((t, i) => (
                  <div
                    key={t.id}
                    className="mini-track"
                    onDoubleClick={() => void playTracks(data.tracks.map((x) => x.id), i, src)}
                    onClick={() => void playTracks(data.tracks.map((x) => x.id), i, src)}
                  >
                    <Artwork hash={t.artHash} px={96} size={40} radius={4} title={t.album} />
                    <span className="mini-track-text">
                      <span className="ellipsis">{t.title}</span>
                      <span className="faint ellipsis">{t.artist}</span>
                    </span>
                    <HeartButton target={{ kind: 'track', id: t.id }} liked={t.liked} className="tt-heart" />
                    <span className="faint tnum mini-track-time">{duration(t.durationMs)}</span>
                  </div>
                ))}
              </div>
            </section>
          )}
        </div>
      )}
      {data && data.artists.length > 0 && (
        <Shelf title="Artists">
          {data.artists.map((a) => (
            <ArtistTile key={a.name} a={a} />
          ))}
        </Shelf>
      )}
      {data && data.albums.length > 0 && (
        <Shelf title="Albums">
          {data.albums.map((a) => (
            <AlbumTile key={a.id} a={a} sub={[a.year, a.albumArtist].filter(Boolean).join(' · ')} />
          ))}
        </Shelf>
      )}
      {data && data.tracks.length > 4 && (
        <section className="section">
          <h2 className="section-title">All songs</h2>
          <TrackTable rows={data.tracks} source={src} showArt columns={['index', 'title', 'album', 'heart', 'time', 'rating']} />
        </section>
      )}
    </div>
  )
}
