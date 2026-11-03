// TIDAL catalog search: top result, artists, albums (incl. EPs and singles), tracks, playlists.

import { useState } from 'react'
import { TIDAL_IPC, type TidalSearchResult, type TidalTrackSummary } from '@shared/ipc/tidal'
import { invoke } from '../../lib/ipc'
import { plural } from '../../lib/format'
import { Artwork, Button, Empty } from '../../components/ui'
import { CenterSpin, DownloadControl, ErrorState, Explicit, trackBadge, useQueueState, useRemote } from './source-kit'
import { tidalAlbumKeys, tidalReleaseType, tidalTrackKeys } from './source-helpers'
import { AlbumTile, ArtistLinks, ArtistTile, openAlbum, openArtist, openPlaylist, PlaylistTile, TidalTrackList } from './items'
import { downloadAlbum, downloadTrack, tidalLogin } from './tidal-state'

const TRACKS_COLLAPSED = 10

export function Search({ query }: { query: string }) {
  const r = useRemote(query ? `search:${query}` : null, () => invoke<TidalSearchResult>(TIDAL_IPC.search, query), { refetchOnLibrary: true })
  if (!query) return <Empty icon="search" title="Search TIDAL">Find artists, albums, tracks and playlists in the TIDAL catalog.</Empty>
  if (!r.data) {
    if (r.error) return <ErrorState source="tidal" error={r.error} onRetry={r.reload} onLogin={() => void tidalLogin()} />
    return <CenterSpin label={`Searching for “${query}”…`} />
  }
  return <SearchResults d={r.data} query={query} />
}

export function SearchResults({ d, query }: { d: TidalSearchResult; query: string }) {
  const [allTracks, setAllTracks] = useState(false)
  const nothing = !d.artists.length && !d.albums.length && !d.tracks.length && !d.playlists.length
  if (nothing)
    return (
      <Empty icon="search" title={`No results for “${query}”`}>
        Check the spelling or try fewer words. You can also paste a TIDAL link.
      </Empty>
    )
  const tracks = allTracks ? d.tracks : d.tracks.slice(0, TRACKS_COLLAPSED)
  return (
    <>
      <TopResult d={d} />
      {d.artists.length > 0 && (
        <section className="section">
          <h2 className="section-title">Artists</h2>
          <div className="tidal-artist-row">
            {d.artists.map((a) => (
              <ArtistTile key={a.id} a={a} />
            ))}
          </div>
        </section>
      )}
      {d.albums.length > 0 && (
        <section className="section">
          <h2 className="section-title">Albums, EPs &amp; Singles</h2>
          <div className="src-grid">
            {d.albums.map((a) => (
              <AlbumTile key={a.id} a={a} />
            ))}
          </div>
        </section>
      )}
      {d.tracks.length > 0 && (
        <section className="section">
          <h2 className="section-title">
            Tracks
            {d.tracks.length > TRACKS_COLLAPSED && (
              <Button small kind="ghost" onClick={() => setAllTracks((x) => !x)}>
                {allTracks ? 'Show Less' : `Show All ${d.tracks.length}`}
              </Button>
            )}
          </h2>
          <TidalTrackList tracks={tracks} mode="list" />
        </section>
      )}
      {d.playlists.length > 0 && (
        <section className="section">
          <h2 className="section-title">Playlists</h2>
          <div className="src-grid">
            {d.playlists.map((p) => (
              <PlaylistTile key={p.uuid} p={p} />
            ))}
          </div>
        </section>
      )}
    </>
  )
}

function TopResult({ d }: { d: TidalSearchResult }) {
  const hit = d.topHit
  if (!hit) return null
  let card: React.ReactNode = null
  if (hit.kind === 'artist') {
    const a = d.artists.find((x) => x.id === hit.id)
    if (a)
      card = (
        <div className="tidal-top card-plain" onClick={() => openArtist(a.id)}>
          <Artwork url={a.picture} size={112} radius={999} title={a.name} />
          <div className="tidal-top-meta">
            <span className="hero-kicker">Artist</span>
            <div className="tidal-top-title">{a.name}</div>
          </div>
        </div>
      )
  } else if (hit.kind === 'album') {
    const a = d.albums.find((x) => x.id === hit.id)
    if (a) card = <TopAlbum a={a} />
  } else if (hit.kind === 'track') {
    const t = d.tracks.find((x) => x.id === hit.id)
    if (t) card = <TopTrack t={t} />
  } else if (hit.kind === 'playlist') {
    const p = d.playlists.find((x) => x.uuid === hit.id)
    if (p)
      card = (
        <div className="tidal-top card-plain" onClick={() => openPlaylist(p.uuid)}>
          <Artwork url={p.image} size={112} radius={8} title={p.title} />
          <div className="tidal-top-meta">
            <span className="hero-kicker">Playlist</span>
            <div className="tidal-top-title">{p.title}</div>
            <div className="muted">{[p.creator, plural(p.numberOfTracks, 'track')].filter(Boolean).join(' · ')}</div>
          </div>
        </div>
      )
  }
  if (!card) return null
  return (
    <section className="section">
      <h2 className="section-title">Top Result</h2>
      {card}
    </section>
  )
}

function TopAlbum({ a }: { a: TidalSearchResult['albums'][number] }) {
  const queue = useQueueState(tidalAlbumKeys(a), a.queue)
  return (
    <div className="tidal-top card-plain" onClick={() => openAlbum(a.id)}>
      <Artwork url={a.cover} size={112} radius={8} title={a.title} />
      <div className="tidal-top-meta">
        <span className="hero-kicker">{tidalReleaseType(a.type, a.numberOfTracks)}</span>
        <div className="tidal-top-title">
          <span className="ellipsis">{a.title}</span>
          {a.explicit && <Explicit />}
        </div>
        <div className="muted ellipsis">
          <ArtistLinks artists={a.artists} fallback={a.artist} />
          {a.year ? ` · ${a.year}` : ''}
        </div>
        <div onClick={(e) => e.stopPropagation()}>
          <DownloadControl badge={a.badge} queue={queue} onDownload={() => downloadAlbum(a)} label="Download Album" />
        </div>
      </div>
    </div>
  )
}

function TopTrack({ t }: { t: TidalTrackSummary }) {
  const queue = useQueueState(tidalTrackKeys(t), t.queue)
  const album = t.album
  return (
    <div className="tidal-top card-plain" onClick={() => album && openAlbum(album.id)}>
      <Artwork url={album?.cover ?? null} size={112} radius={8} title={t.title} />
      <div className="tidal-top-meta">
        <span className="hero-kicker">Track</span>
        <div className="tidal-top-title">
          <span className="ellipsis">{t.title}</span>
          {t.explicit && <Explicit />}
        </div>
        <div className="muted ellipsis">
          <ArtistLinks artists={t.artists} fallback={t.artist} />
          {album ? ` · ${album.title}` : ''}
        </div>
        <div onClick={(e) => e.stopPropagation()}>
          {t.streamable ? (
            <DownloadControl badge={trackBadge(t.inLibrary)} queue={queue} onDownload={() => downloadTrack(t)} label="Download Track" />
          ) : (
            <span className="chip">Unavailable</span>
          )}
        </div>
      </div>
    </div>
  )
}
