import { useState, type ReactNode } from 'react'
import { LIB, type SearchResult } from '@shared/ipc/library'
import type { AlbumRow, ArtistRow, RipGameRow, TrackRow } from '@shared/types'
import { errorMessage, invoke, revealLabel } from '../../lib/ipc'
import { cx, duration, plural, quality } from '../../lib/format'
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
import { Artwork, Button, Empty, IconButton, Segmented, Spinner, showMenu } from '../../components/ui'
import { QueueList } from '../../components/QueueList'
import { Seek, sleepMenuItems } from '../../shell/PlayerBar'
import { Icon, type IconName } from '../../components/Icon'
import { ArtistTile, artistMenu } from './Artists'
import { GameTile, gameSource } from '../rips/RipsView'

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

type Top =
  | { kind: 'artist'; a: ArtistRow }
  | { kind: 'album'; a: AlbumRow }
  | { kind: 'track'; t: TrackRow }
  | { kind: 'game'; g: RipGameRow }

/** The search box looks in both halves of the library unless you narrow it (remembered here). */
type Scope = 'all' | 'main' | 'rips'
const SCOPE_KEY = 'valence.search.scope'
const SCOPES: Array<{ value: Scope; label: string; icon: IconName; title: string }> = [
  { value: 'all', label: 'Everything', icon: 'library', title: 'Your music and your SiivaGunner rips' },
  { value: 'main', label: 'Music', icon: 'songs', title: 'Only your music library' },
  { value: 'rips', label: 'SiivaGunner', icon: 'rips', title: 'Only SiivaGunner rips' },
]
const loadScope = (): Scope => {
  const v = localStorage.getItem(SCOPE_KEY)
  return v === 'main' || v === 'rips' ? v : 'all'
}
const NONE: SearchResult = { tracks: [], trackTotal: 0, albums: [], artists: [], games: [] }
const resultCount = (d: SearchResult | undefined) => (d ? d.trackTotal + d.albums.length + d.artists.length + d.games.length : 0)

/** An exact name wins, then the best artist, album or game; music comes before rips. */
function topResult(q: string, m: SearchResult, r: SearchResult): Top | null {
  const n = q.trim().toLowerCase()
  const is = (s: string) => s.toLowerCase() === n
  const artist = m.artists.find((a) => is(a.name))
  if (artist) return { kind: 'artist', a: artist }
  const album = m.albums.find((a) => is(a.title)) ?? r.albums.find((a) => is(a.title))
  if (album) return { kind: 'album', a: album }
  const game = r.games.find((g) => is(g.name))
  if (game) return { kind: 'game', g: game }
  const track = m.tracks.find((t) => is(t.title)) ?? r.tracks.find((t) => is(t.title))
  if (track) return { kind: 'track', t: track }
  if (m.artists[0]?.name.toLowerCase().startsWith(n)) return { kind: 'artist', a: m.artists[0] }
  if (r.games[0]?.name.toLowerCase().startsWith(n)) return { kind: 'game', g: r.games[0] }
  if (m.albums[0]) return { kind: 'album', a: m.albums[0] }
  if (m.artists[0]) return { kind: 'artist', a: m.artists[0] }
  if (m.tracks[0]) return { kind: 'track', t: m.tracks[0] }
  if (r.games[0]) return { kind: 'game', g: r.games[0] }
  if (r.albums[0]) return { kind: 'album', a: r.albums[0] }
  return r.tracks[0] ? { kind: 'track', t: r.tracks[0] } : null
}

function TopResult({ top, q }: { top: Top; q: string }) {
  const match = (s: { kind: string; id?: string } | null | undefined) =>
    top.kind === 'artist'
      ? s?.kind === 'artist' && s.id === top.a.name
      : top.kind === 'album'
        ? s?.kind === 'album' && s.id === String(top.a.id)
        : top.kind === 'game'
          ? s?.kind === 'other' && s.id === gameSource(top.g.name).id
          : s?.kind === 'search' && s.id === q
  const now = useSourcePlaying(match)
  const art = top.kind === 'track' ? top.t.artHash : top.kind === 'game' ? top.g.artHash : top.a.artHash
  const title = top.kind === 'artist' ? top.a.name : top.kind === 'album' ? top.a.title : top.kind === 'game' ? top.g.name : top.t.title
  const open = () =>
    top.kind === 'artist'
      ? navigate({ view: 'artist', artist: top.a.name })
      : top.kind === 'album'
        ? navigate(albumRoute(top.a.id, top.a.hqRip))
        : top.kind === 'game'
          ? navigate({ view: 'game', game: top.g.name })
          : top.t.albumId != null && navigate(albumRoute(top.t.albumId, top.t.hqRip))
  const play = () => {
    if (top.kind === 'artist') void playQuery({ albumArtist: top.a.name }, undefined, { kind: 'artist', id: top.a.name, title: top.a.name })
    else if (top.kind === 'album') void invoke<number[]>(LIB.trackIds, { albumId: top.a.id }).then((ids) => playTracks(ids, 0, { kind: 'album', id: String(top.a.id), title: top.a.title }))
    else if (top.kind === 'game') void playQuery({ ripGame: top.g.name }, undefined, gameSource(top.g.name))
    else void playTracks([top.t.id], 0, { kind: 'search', id: q, title: `“${q}”` })
  }
  const chip = top.kind === 'artist' ? 'Artist' : top.kind === 'album' ? 'Album' : top.kind === 'game' ? 'Game' : top.t.hqRip ? 'Rip' : 'Song'
  return (
    <div
      className="top-result"
      onClick={open}
      onContextMenu={(e) => (top.kind === 'artist' ? artistMenu(e, top.a) : top.kind === 'album' ? albumMenu(e, top.a) : undefined)}
    >
      <Artwork hash={art} px={300} className={cx('top-art', top.kind === 'artist' && 'round')} title={title} />
      <div className="top-title ellipsis">{title}</div>
      <div className="top-sub">
        <span className="chip">{chip}</span>
        {top.kind === 'album' && <span className="ellipsis">{top.a.albumArtist}</span>}
        {top.kind === 'game' && <span className="ellipsis">{plural(top.g.trackCount, 'rip')}</span>}
        {top.kind === 'track' && <span className="ellipsis">{top.t.hqRip ? (top.t.ripGame ?? top.t.album) : top.t.artist}</span>}
      </div>
      <span className="top-play">
        <PlayButton onPlay={play} current={now.current} playing={now.playing} title={`Play ${title}`} />
      </span>
    </div>
  )
}

/** A song list section; "Show all" narrows the search to that half when only the first 50 fit. */
function ResultSongs(props: { title: string; sub: string; onMore?: () => void; children: ReactNode }) {
  return (
    <section className="section">
      <div className="section-head">
        <div>
          <h2 className="section-title">{props.title}</h2>
          <div className="section-sub">{props.sub}</div>
        </div>
        {props.onMore && (
          <button className="section-more" onClick={props.onMore}>
            Show all
          </button>
        )}
      </div>
      {props.children}
    </section>
  )
}

export function SearchView({ q }: { q: string }) {
  const [scope, setScopeState] = useState<Scope>(loadScope)
  const setScope = (s: Scope) => {
    setScopeState(s)
    localStorage.setItem(SCOPE_KEY, s)
  }
  // Both halves are searched either way, so the switch can show what each one found.
  const music = useLibData(() => invoke<SearchResult>(LIB.search, q, 'main'), [q])
  const rips = useLibData(() => invoke<SearchResult>(LIB.search, q, 'rips'), [q])
  useViewHeader({ color: null, title: `“${q}”` })
  const src = { kind: 'search' as const, id: q, title: `“${q}”` }
  const loaded = !!music.data && !!rips.data
  const loading = music.loading || rips.loading
  const m = scope !== 'rips' ? (music.data ?? NONE) : NONE
  const r = scope !== 'main' ? (rips.data ?? NONE) : NONE
  const counts: Record<Scope, number> = { all: resultCount(music.data) + resultCount(rips.data), main: resultCount(music.data), rips: resultCount(rips.data) }
  const none = loaded && counts[scope] === 0
  const top = loaded ? topResult(q, m, r) : null
  // The short list beside the top result: songs, or rips when no song matched.
  const mini = m.tracks.length ? m.tracks : r.tracks
  const miniRips = !m.tracks.length
  const single = scope !== 'all'
  const sub = [
    m.artists.length && plural(m.artists.length, 'artist'),
    m.albums.length + r.albums.length && plural(m.albums.length + r.albums.length, 'album'),
    m.trackTotal && plural(m.trackTotal, 'song'),
    r.games.length && plural(r.games.length, 'game'),
    r.trackTotal && plural(r.trackTotal, 'rip'),
  ]
    .filter(Boolean)
    .join(' · ')
  const other: Scope | null = scope === 'main' && counts.rips ? 'rips' : scope === 'rips' && counts.main ? 'main' : null

  return (
    <div className={cx('view search-view', loading && loaded && 'refetching')}>
      <div className="view-head">
        <div>
          <h1 className="view-title">Results for “{q}”</h1>
          <div className="view-sub">{loaded && !none ? sub : ' '}</div>
        </div>
        <Segmented<Scope>
          className="scope-switch"
          label="Search in"
          value={scope}
          onChange={setScope}
          options={SCOPES.map((s) => ({
            value: s.value,
            title: s.title,
            label: (
              <>
                <Icon name={s.icon} size={16} />
                {s.label}
                {loaded && <span className="pill-count">{counts[s.value].toLocaleString()}</span>}
              </>
            ),
          }))}
        />
        <div className="view-actions">
          <Button icon="wave" onClick={() => navigate({ view: 'tidal', tab: 'search', id: q })}>
            Search TIDAL
          </Button>
        </div>
      </div>
      {!loaded && loading && (
        <div className="center-spin">
          <Spinner />
        </div>
      )}
      {none && (
        <Empty icon="search" title={scope === 'rips' ? `No SiivaGunner rips match “${q}”` : scope === 'main' ? `No music matches “${q}”` : `No matches for “${q}” in your library`}>
          Check the spelling, try fewer words, or search TIDAL.
          {other && (
            <div>
              <Button icon={other === 'rips' ? 'rips' : 'songs'} onClick={() => setScope(other)}>
                {other === 'rips' ? `Show ${plural(counts.rips, 'SiivaGunner result')}` : `Show ${plural(counts.main, 'music result')}`}
              </Button>
            </div>
          )}
        </Empty>
      )}
      {loaded && top && (
        <div className="search-top">
          <section>
            <h2 className="section-title">Top result</h2>
            <TopResult top={top} q={q} />
          </section>
          {mini.length > 0 && (
            <section className="search-top-songs">
              <h2 className="section-title">{miniRips ? 'Rips' : 'Songs'}</h2>
              <div className="mini-tracks">
                {mini.slice(0, 4).map((t, i) => (
                  <div key={t.id} className="mini-track" onClick={() => void playTracks(mini.map((x) => x.id), i, src)}>
                    <Artwork hash={t.artHash} px={96} size={40} radius={4} title={t.album} />
                    <span className="mini-track-text">
                      <span className="ellipsis">{t.title}</span>
                      <span className="faint ellipsis">{t.hqRip ? (t.ripGame ?? t.album) : t.artist}</span>
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
      {m.artists.length > 0 && (
        <Shelf title="Artists">
          {m.artists.map((a) => (
            <ArtistTile key={a.name} a={a} />
          ))}
        </Shelf>
      )}
      {m.albums.length > 0 && (
        <Shelf title="Albums">
          {m.albums.map((a) => (
            <AlbumTile key={a.id} a={a} sub={[a.year, a.albumArtist].filter(Boolean).join(' · ')} />
          ))}
        </Shelf>
      )}
      {r.games.length > 0 && (
        <Shelf title="Games" sub="SiivaGunner rips by game">
          {r.games.map((g) => (
            <GameTile key={g.name} g={g} />
          ))}
        </Shelf>
      )}
      {r.albums.length > 0 && (
        <Shelf title="SiivaGunner albums">
          {r.albums.map((a) => (
            <AlbumTile key={a.id} a={a} sub={plural(a.trackCount, 'rip')} />
          ))}
        </Shelf>
      )}
      {m.trackTotal > 4 && (
        <ResultSongs title="All songs" sub={plural(m.trackTotal, 'song')} onMore={!single && m.trackTotal > m.tracks.length ? () => setScope('main') : undefined}>
          {single ? (
            <TrackTable query={{ search: q, collection: 'main' }} source={src} showArt columns={['index', 'title', 'album', 'heart', 'time', 'rating']} />
          ) : (
            <TrackTable rows={m.tracks} source={src} showArt columns={['index', 'title', 'album', 'heart', 'time', 'rating']} />
          )}
        </ResultSongs>
      )}
      {r.trackTotal > (miniRips ? 4 : 0) && (
        <ResultSongs title="SiivaGunner rips" sub={plural(r.trackTotal, 'rip')} onMore={!single && r.trackTotal > r.tracks.length ? () => setScope('rips') : undefined}>
          {single ? (
            <TrackTable query={{ search: q, collection: 'rips' }} source={src} showArt columns={['index', 'title', 'game', 'album', 'heart', 'time']} />
          ) : (
            <TrackTable rows={r.tracks} source={src} showArt columns={['index', 'title', 'game', 'album', 'heart', 'time']} />
          )}
        </ResultSongs>
      )}
    </div>
  )
}
