import { LIB, type SearchResult } from '@shared/ipc/library'
import type { AlbumRow, ArtistRow, TrackRow } from '@shared/types'
import { invoke } from '../../lib/ipc'
import { cx, duration, quality } from '../../lib/format'
import { cmd, playQuery, playTracks, usePlayer } from '../../state/player'
import { useCurrentLyrics, useCurrentTrack } from '../../state/current'
import { albumRoute, navigate, useUi } from '../../state/ui'
import { useLibData, useSetting } from '../../state/library'
import { useHeaderColor } from '../../theme/accent'
import { useViewHeader } from '../../shell/header'
import { LyricsView } from '../../shell/LyricsView'
import { AlbumTile, albumMenu } from '../../components/AlbumGrid'
import { PlayButton, Shelf, useSourcePlaying } from '../../components/Hero'
import { TrackTable } from '../../components/TrackTable'
import { HeartButton } from '../../components/Heart'
import { Artwork, Button, Empty, Spinner, Stars } from '../../components/ui'
import { Icon } from '../../components/Icon'
import { ArtistTile, artistMenu } from './Artists'

export function NowPlayingView() {
  const cur = usePlayer((s) => s.state?.current)
  const playing = usePlayer((s) => !!s.state?.playing)
  const hash = usePlayer((s) => s.currentArtHash)
  const next = usePlayer((s) => s.state?.queue.upNext[0] ?? s.state?.queue.context.upcoming[0] ?? s.state?.queue.continuation?.upcoming[0] ?? null)
  const track = useCurrentTrack()
  const { lyrics } = useCurrentLyrics()
  const color = useHeaderColor(hash)
  const [spin] = useSetting<boolean>('ui.np.spin', false)
  useViewHeader({ color, strong: true, title: cur?.title ?? 'Now playing' })
  if (!cur)
    return (
      <div className="view">
        <Empty icon="songs" title="Nothing playing">
          Pick an album or song to start listening.
        </Empty>
      </div>
    )
  const openArt = () => useUi.getState().openArt({ hash, url: hash ? undefined : cur.artUrl, albumId: track?.albumId, title: cur.album || cur.title, sub: cur.artist })
  return (
    <div className="nowplaying">
      <div className="np-left">
        <button className="np-art-btn" title="View artwork" onClick={openArt}>
          <Artwork hash={hash} url={hash ? undefined : cur.artUrl} px={1000} className={cx('np-art', spin && 'spin', !playing && 'paused')} title={cur.album} />
          <span className="np-art-zoom">
            <Icon name="zoomIn" size={18} />
          </span>
        </button>
        <div className="np-meta">
          <div className="np-title-row">
            <div className="np-title" title={cur.title}>
              {cur.title}
            </div>
            {track && <HeartButton target={{ kind: 'track', id: track.id }} liked={track.liked} size={26} />}
          </div>
          <div className="np-sub">
            <a className="link-muted" onClick={() => navigate({ view: 'artist', artist: track?.albumArtist || cur.artist })}>
              {cur.artist}
            </a>
            {cur.album && (
              <>
                <span className="dot-sep" />
                <a className="link-muted" onClick={() => track?.albumId != null && navigate(albumRoute(track.albumId, track.hqRip))}>
                  {cur.album}
                </a>
              </>
            )}
          </div>
          {track && (
            <div className="np-chips">
              <Stars rating={track.rating} size={14} onRate={(s) => void invoke(LIB.setRating, [track.id], s)} />
              <span className="q-badge">{quality(track)}</span>
              {track.year && <span className="chip">{track.year}</span>}
              {track.genre && <span className="chip">{track.genre}</span>}
            </div>
          )}
          {next && (
            <button className="np-next" onClick={() => cmd({ type: 'next' })} title="Skip to the next song">
              <span className="np-next-label">Next</span>
              <span className="ellipsis">
                <b>{next.title}</b> · {next.artist}
              </span>
              <Icon name="next" size={14} />
            </button>
          )}
        </div>
      </div>
      <div className="np-right lyrics-scroll">
        {lyrics ? (
          <LyricsView big />
        ) : (
          <Empty icon="lyrics" title="No lyrics for this song">
            Valence looks lyrics up on import. You can add them in Get Info.
          </Empty>
        )}
      </div>
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
