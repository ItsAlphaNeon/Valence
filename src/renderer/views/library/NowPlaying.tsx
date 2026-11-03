import { LIB, type SearchResult } from '@shared/ipc/library'
import { invoke } from '../../lib/ipc'
import { cx, quality } from '../../lib/format'
import { usePlayer } from '../../state/player'
import { useCurrentLyrics, useCurrentTrack } from '../../state/current'
import { navigate } from '../../state/ui'
import { useLibData } from '../../state/library'
import { LyricsView } from '../../shell/LyricsView'
import { AlbumTile } from '../../components/AlbumGrid'
import { TrackTable } from '../../components/TrackTable'
import { Artwork, Button, Empty, Spinner, Stars } from '../../components/ui'
import { ArtistTile } from './Artists'

export function NowPlayingView() {
  const cur = usePlayer((s) => s.state?.current)
  const playing = usePlayer((s) => !!s.state?.playing)
  const hash = usePlayer((s) => s.currentArtHash)
  const track = useCurrentTrack()
  const { lyrics } = useCurrentLyrics()
  if (!cur) return <div className="view"><Empty icon="songs" title="Nothing playing">Pick an album or song to start listening.</Empty></div>
  return (
    <div className="nowplaying">
      <div className="np-left">
        <Artwork hash={hash} url={hash ? undefined : cur.artUrl} px={1000} className={cx('np-art', !playing && 'paused')} title={cur.album} />
        <div>
          <div className="np-title">{cur.title}</div>
          <div className="np-sub">
            <a className="link-muted" onClick={() => navigate({ view: 'artist', artist: track?.albumArtist || cur.artist })}>
              {cur.artist}
            </a>
            {cur.album && (
              <>
                {' — '}
                <a className="link-muted" onClick={() => track?.albumId != null && navigate({ view: 'album', id: track.albumId })}>
                  {cur.album}
                </a>
              </>
            )}
          </div>
          {track && (
            <div className="row" style={{ marginTop: 8 }}>
              <Stars rating={track.rating} size={14} onRate={(s) => void invoke(LIB.setRating, [track.id], s)} />
              <span className="chip">{quality(track)}</span>
              {track.year && <span className="chip">{track.year}</span>}
            </div>
          )}
        </div>
      </div>
      <div className="np-right lyrics-scroll">{lyrics ? <LyricsView big /> : <Empty icon="lyrics" title="No lyrics for this song" />}</div>
    </div>
  )
}

export function SearchView({ q }: { q: string }) {
  const { data, loading } = useLibData(() => invoke<SearchResult>(LIB.search, q), [q])
  const src = { kind: 'search' as const, id: q, title: `“${q}”` }
  const none = data && !data.tracks.length && !data.albums.length && !data.artists.length
  return (
    <div className="view">
      <div className="view-head">
        <div>
          <h1 className="view-title">Results for “{q}”</h1>
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
      {none && <Empty icon="search" title="No matches in your library">Try TIDAL, or check the spelling.</Empty>}
      {data && data.artists.length > 0 && (
        <div className="section">
          <h2 className="section-title">Artists</h2>
          <div className="search-artists">
            {data.artists.map((a) => (
              <ArtistTile key={a.name} a={a} />
            ))}
          </div>
        </div>
      )}
      {data && data.albums.length > 0 && (
        <div className="section">
          <h2 className="section-title">Albums</h2>
          <div className="search-albums">
            {data.albums.map((a) => (
              <AlbumTile key={a.id} a={a} />
            ))}
          </div>
        </div>
      )}
      {data && data.tracks.length > 0 && (
        <div className="section">
          <h2 className="section-title">Songs</h2>
          <TrackTable rows={data.tracks} source={src} showArt columns={['title', 'artist', 'album', 'time', 'rating']} />
        </div>
      )}
    </div>
  )
}
