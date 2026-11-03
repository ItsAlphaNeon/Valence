import { useMemo, useState } from 'react'
import type { AlbumRow, ArtistRow, GenreRow, TrackRow } from '@shared/types'
import { LIB } from '@shared/ipc/library'
import { invoke } from '../../lib/ipc'
import { plural } from '../../lib/format'
import { useLibData } from '../../state/library'
import { playQuery } from '../../state/player'
import { navigate } from '../../state/ui'
import { AlbumGrid, AlbumTile } from '../../components/AlbumGrid'
import { TrackTable } from '../../components/TrackTable'
import { Artwork, Button, Empty, Spinner, showMenu } from '../../components/ui'

export function ArtistTile({ a }: { a: ArtistRow }) {
  return (
    <div
      className="artist-tile"
      onClick={() => navigate({ view: 'artist', artist: a.name })}
      onContextMenu={(e) =>
        showMenu(e, [
          { label: 'Play', icon: 'play', onClick: () => void playQuery({ albumArtist: a.name }, undefined, { kind: 'artist', id: a.name, title: a.name }) },
          { label: 'Shuffle', icon: 'shuffle', onClick: () => void playQuery({ artist: a.name }, undefined, { kind: 'artist', id: a.name, title: a.name }, true) },
        ])
      }
    >
      <Artwork hash={a.artHash} px={300} title={a.name} />
      <div className="tile-title ellipsis">{a.name}</div>
      <div className="tile-sub">{plural(a.albumCount, 'album')}</div>
    </div>
  )
}

export function ArtistsView() {
  const [filter, setFilter] = useState('')
  const { data } = useLibData(() => invoke<ArtistRow[]>(LIB.artists, {}), [])
  const shown = useMemo(() => {
    const f = filter.trim().toLowerCase()
    return f ? (data ?? []).filter((a) => a.name.toLowerCase().includes(f)) : (data ?? [])
  }, [data, filter])
  return (
    <div className="view">
      <div className="view-head">
        <div>
          <h1 className="view-title">Artists</h1>
          {data && <div className="view-sub">{plural(data.length, 'artist')}</div>}
        </div>
        <div className="view-actions">
          <input type="search" placeholder="Filter" value={filter} onChange={(e) => setFilter(e.target.value)} style={{ width: 180 }} />
        </div>
      </div>
      {!data ? (
        <div className="center-spin">
          <Spinner />
        </div>
      ) : (
        <div className="artist-grid">
          {shown.map((a) => (
            <ArtistTile key={a.name} a={a} />
          ))}
        </div>
      )}
    </div>
  )
}

export function ArtistDetailView({ artist }: { artist: string }) {
  const albums = useLibData(() => invoke<AlbumRow[]>(LIB.albums, { albumArtist: artist, sort: 'year' }), [artist]).data
  const tracks = useLibData(() => invoke<{ rows: TrackRow[] }>(LIB.tracks, { artist, sort: { key: 'playCount', dir: 'desc' } }).then((r) => r.rows), [artist]).data
  const appearsOn = useMemo(() => {
    if (!tracks) return []
    const seen = new Map<number, AlbumRow>()
    for (const t of tracks) {
      if (t.albumId == null || t.albumArtist.toLowerCase() === artist.toLowerCase() || seen.has(t.albumId)) continue
      seen.set(t.albumId, {
        id: t.albumId,
        title: t.album,
        albumArtist: t.albumArtist,
        year: t.year,
        trackCount: 0,
        trackTotal: null,
        durationMs: 0,
        artHash: t.artHash,
        relDir: '',
        genre: t.genre,
        addedAt: t.addedAt,
        compilation: t.compilation,
      })
    }
    return [...seen.values()]
  }, [tracks, artist])
  const art = albums?.find((a) => a.artHash)?.artHash ?? tracks?.find((t) => t.artHash)?.artHash
  const src = { kind: 'artist' as const, id: artist, title: artist }
  if (albums && tracks && !albums.length && !tracks.length) return <div className="view"><Empty icon="artists" title={`No music by ${artist}`} /></div>
  const top = (tracks ?? []).slice(0, 10)
  return (
    <div className="view">
      <div className="hero">
        <Artwork hash={art} px={600} className="hero-art round" title={artist} />
        <div className="hero-meta">
          <span className="hero-kicker">Artist</span>
          <h1 className="hero-title">{artist}</h1>
          <span className="hero-info">
            {albums && plural(albums.length, 'album')}
            {tracks && ` · ${plural(tracks.length, 'song')}`}
          </span>
          <div className="hero-actions">
            <Button kind="primary" icon="play" onClick={() => void playQuery({ albumArtist: artist }, undefined, src)}>
              Play
            </Button>
            <Button icon="shuffle" onClick={() => void playQuery({ artist }, undefined, src, true)}>
              Shuffle
            </Button>
          </div>
        </div>
      </div>
      {top.length > 0 && top.some((t) => t.playCount > 0) && (
        <div className="section">
          <h2 className="section-title">Top Songs</h2>
          <TrackTable rows={top} columns={['title', 'album', 'time', 'plays']} source={src} showArt />
        </div>
      )}
      {albums && albums.length > 0 && (
        <div className="section">
          <h2 className="section-title">Albums</h2>
          <AlbumGrid albums={albums} subtitle={(a) => a.year ?? ''} />
        </div>
      )}
      {appearsOn.length > 0 && (
        <div className="section">
          <h2 className="section-title">Appears On</h2>
          <div className="search-albums">
            {appearsOn.map((a) => (
              <AlbumTile key={a.id} a={a} />
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function hue(s: string): number {
  let h = 0
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) % 360
  return h
}

export function GenresView() {
  const { data } = useLibData(() => invoke<GenreRow[]>(LIB.genres), [])
  return (
    <div className="view">
      <div className="view-head">
        <div>
          <h1 className="view-title">Genres</h1>
          {data && <div className="view-sub">{plural(data.length, 'genre')}</div>}
        </div>
      </div>
      {!data ? (
        <div className="center-spin">
          <Spinner />
        </div>
      ) : !data.length ? (
        <Empty icon="genres" title="No genres yet">Genres come from MusicBrainz, Bandcamp tags or existing file tags on import.</Empty>
      ) : (
        <div className="genre-grid">
          {data.map((g) => {
            const h = hue(g.name)
            return (
              <div
                key={g.name}
                className="genre-tile"
                style={{ background: `linear-gradient(135deg, hsl(${h} 62% 52%), hsl(${(h + 50) % 360} 58% 36%))` }}
                onClick={() => navigate({ view: 'genre', genre: g.name })}
              >
                <b>{g.name}</b>
                <span>
                  {plural(g.albumCount, 'album')} · {plural(g.trackCount, 'song')}
                </span>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

export function GenreDetailView({ genre }: { genre: string }) {
  const albums = useLibData(() => invoke<AlbumRow[]>(LIB.albums, { genre }), [genre]).data
  const src = { kind: 'other' as const, id: genre, title: genre }
  return (
    <div className="view">
      <div className="view-head">
        <div>
          <span className="hero-kicker">Genre</span>
          <h1 className="view-title">{genre}</h1>
          {albums && <div className="view-sub">{plural(albums.length, 'album')}</div>}
        </div>
        <div className="view-actions">
          <Button kind="primary" icon="play" onClick={() => void playQuery({ genre }, undefined, src)}>
            Play
          </Button>
          <Button icon="shuffle" onClick={() => void playQuery({ genre }, undefined, src, true)}>
            Shuffle
          </Button>
        </div>
      </div>
      {albums && <AlbumGrid albums={albums} />}
      <div className="section">
        <h2 className="section-title">Songs</h2>
        <TrackTable query={{ genre }} source={src} columns={['title', 'artist', 'album', 'time', 'year', 'rating']} />
      </div>
    </div>
  )
}
