import { useMemo, useState } from 'react'
import type { AlbumRow, ArtistRow, GenreRow, TrackRow } from '@shared/types'
import { LIB } from '@shared/ipc/library'
import { invoke } from '../../lib/ipc'
import { cx, plural } from '../../lib/format'
import { useLibData } from '../../state/library'
import { playQuery } from '../../state/player'
import { navigate } from '../../state/ui'
import { setLiked } from '../../state/favorites'
import { useViewHeader } from '../../shell/header'
import { AlbumGrid, AlbumTile } from '../../components/AlbumGrid'
import { TrackTable } from '../../components/TrackTable'
import { VirtualGrid } from '../../components/VirtualGrid'
import { ActionBar, Hero, PlayButton, Shelf, useSourcePlaying } from '../../components/Hero'
import { HeartButton } from '../../components/Heart'
import { Artwork, Empty, IconButton, Spinner, showMenu } from '../../components/ui'
import { Icon } from '../../components/Icon'

const artistSource = (name: string) => ({ kind: 'artist' as const, id: name, title: name })

export function artistMenu(e: React.MouseEvent, a: Pick<ArtistRow, 'name' | 'liked'>): void {
  showMenu(e, [
    { label: 'Play', icon: 'play', onClick: () => void playQuery({ albumArtist: a.name }, undefined, artistSource(a.name)) },
    { label: 'Shuffle', icon: 'shuffle', onClick: () => void playQuery({ artist: a.name }, undefined, artistSource(a.name), true) },
    { separator: true },
    a.liked
      ? { label: 'Remove from your library', icon: 'heart', onClick: () => void setLiked({ kind: 'artist', names: [a.name] }, false) }
      : { label: 'Save to your library', icon: 'heart', onClick: () => void setLiked({ kind: 'artist', names: [a.name] }, true) },
  ])
}

export function ArtistTile({ a, sub }: { a: ArtistRow; sub?: string }) {
  const now = useSourcePlaying((s) => s?.kind === 'artist' && s.id === a.name)
  return (
    <div className={cx('artist-tile', now.current && 'playing')} onClick={() => navigate({ view: 'artist', artist: a.name })} onContextMenu={(e) => artistMenu(e, a)}>
      <div className="tile-art round">
        <Artwork hash={a.artHash} px={300} title={a.name} />
        <span className="tile-play-wrap">
          <PlayButton size="sm" onPlay={() => void playQuery({ albumArtist: a.name }, undefined, artistSource(a.name))} current={now.current} playing={now.playing} title={`Play ${a.name}`} />
        </span>
      </div>
      <div className="tile-title ellipsis">{a.name}</div>
      <div className="tile-sub">{sub ?? 'Artist'}</div>
    </div>
  )
}

export function ArtistsView() {
  const [filter, setFilter] = useState('')
  const [onlyLiked, setOnlyLiked] = useState(false)
  const { data } = useLibData(() => invoke<ArtistRow[]>(LIB.artists, {}), [])
  useViewHeader({ color: null })
  const shown = useMemo(() => {
    const f = filter.trim().toLowerCase()
    let list = data ?? []
    if (onlyLiked) list = list.filter((a) => a.liked)
    return f ? list.filter((a) => a.name.toLowerCase().includes(f)) : list
  }, [data, filter, onlyLiked])
  return (
    <div className="view">
      <div className="view-head">
        <div>
          <h1 className="view-title">Artists</h1>
          {data && <div className="view-sub">{plural(data.length, 'artist')}</div>}
        </div>
        <div className="view-actions">
          <button className={cx('pill', onlyLiked && 'on')} onClick={() => setOnlyLiked(!onlyLiked)}>
            <Icon name="heart" size={13} filled={onlyLiked} /> Liked
          </button>
          <label className="filter-input">
            <Icon name="search" size={15} />
            <input type="search" placeholder="Filter artists" value={filter} onChange={(e) => setFilter(e.target.value)} />
          </label>
        </div>
      </div>
      {!data ? (
        <div className="center-spin">
          <Spinner />
        </div>
      ) : !shown.length ? (
        <Empty icon="artists" title={filter ? 'No artists match' : onlyLiked ? 'No liked artists yet' : 'No artists yet'} />
      ) : (
        <VirtualGrid items={shown} keyOf={(a) => a.name} extraH={66} render={(a) => <ArtistTile a={a} sub={plural(a.albumCount, 'album')} />} />
      )}
    </div>
  )
}

type Kind = 'all' | 'albums' | 'singles' | 'compilations'
function kindOfAlbum(a: AlbumRow): Exclude<Kind, 'all'> {
  if (a.compilation) return 'compilations'
  const n = Math.max(a.trackCount, a.trackTotal ?? 0)
  return n <= 6 && a.durationMs < 30 * 60_000 ? 'singles' : 'albums'
}

export function ArtistDetailView({ artist }: { artist: string }) {
  // An artist's own page shows everything by them, rips included (rip artists are only reachable from rips).
  const albums = useLibData(() => invoke<AlbumRow[]>(LIB.albums, { albumArtist: artist, sort: 'year', collection: 'all' }), [artist]).data
  const tracks = useLibData(
    () => invoke<{ rows: TrackRow[] }>(LIB.tracks, { artist, sort: { key: 'playCount', dir: 'desc' }, collection: 'all' }).then((r) => r.rows),
    [artist],
  ).data
  const me = useLibData(() => invoke<ArtistRow[]>(LIB.artists, { names: [artist] }).then((r) => r[0] ?? null), [artist]).data
  const [kind, setKind] = useState<Kind>('all')
  const [showAll, setShowAll] = useState(false)
  const now = useSourcePlaying((s) => s?.kind === 'artist' && s.id === artist)
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
        hqRip: t.hqRip,
        liked: false,
      })
    }
    return [...seen.values()]
  }, [tracks, artist])
  const art = me?.artHash ?? albums?.find((a) => a.artHash)?.artHash ?? tracks?.find((t) => t.artHash)?.artHash
  const src = artistSource(artist)
  const play = () => void playQuery({ albumArtist: artist }, undefined, src)
  const kinds = useMemo(() => new Set((albums ?? []).map(kindOfAlbum)), [albums])
  const shownAlbums = useMemo(() => (albums ?? []).filter((a) => kind === 'all' || kindOfAlbum(a) === kind).reverse(), [albums, kind])
  const totalPlays = useMemo(() => (tracks ?? []).reduce((n, t) => n + t.playCount, 0), [tracks])

  if (albums && tracks && !albums.length && !tracks.length)
    return (
      <div className="view">
        <Empty icon="artists" title={`No music by ${artist}`} />
      </div>
    )
  const top = (tracks ?? []).slice(0, showAll ? 10 : 5)
  return (
    <div className="view">
      <Hero
        art={{ hash: art, title: artist }}
        round
        kicker="Artist"
        title={artist}
        play={play}
        info={[albums && plural(albums.length, 'album'), tracks && plural(tracks.length, 'song'), totalPlays ? plural(totalPlays, 'play') : null].filter(Boolean).join(' · ')}
      />
      <ActionBar>
        <PlayButton onPlay={play} current={now.current} playing={now.playing} title={`Play ${artist}`} />
        <IconButton icon="shuffle" size={26} title="Shuffle" onClick={() => void playQuery({ artist }, undefined, src, true)} />
        <HeartButton target={{ kind: 'artist', name: artist }} liked={me?.liked} size={28} />
        <IconButton icon="more" size={26} title={`More options for ${artist}`} onClick={(e) => artistMenu(e, { name: artist, liked: !!me?.liked })} />
      </ActionBar>
      {top.length > 0 && (
        <section className="section">
          <h2 className="section-title">{top.some((t) => t.playCount > 0) ? 'Popular in your library' : 'Songs'}</h2>
          <TrackTable rows={top} columns={['index', 'title', 'heart', 'plays', 'time']} source={src} showArt />
          {(tracks?.length ?? 0) > 5 && (
            <button className="link-btn" onClick={() => setShowAll(!showAll)}>
              {showAll ? 'Show less' : 'See more'}
            </button>
          )}
        </section>
      )}
      {albums && albums.length > 0 && (
        <section className="section">
          <div className="section-head">
            <h2 className="section-title">Discography</h2>
          </div>
          {kinds.size > 1 && (
            <div className="pill-row">
              {(['all', 'albums', 'singles', 'compilations'] as const)
                .filter((k) => k === 'all' || kinds.has(k))
                .map((k) => (
                  <button key={k} className={cx('pill', kind === k && 'on')} onClick={() => setKind(k)}>
                    {k === 'all' ? 'All' : k === 'albums' ? 'Albums' : k === 'singles' ? 'Singles and EPs' : 'Compilations'}
                  </button>
                ))}
            </div>
          )}
          <AlbumGrid albums={shownAlbums} subtitle={(a) => [a.year, kindOfAlbum(a) === 'singles' ? (a.trackCount <= 3 ? 'Single' : 'EP') : kindOfAlbum(a) === 'compilations' ? 'Compilation' : 'Album'].filter(Boolean).join(' · ')} />
        </section>
      )}
      {appearsOn.length > 0 && (
        <Shelf title="Appears on">
          {appearsOn.map((a) => (
            <AlbumTile key={a.id} a={a} />
          ))}
        </Shelf>
      )}
    </div>
  )
}

export function hue(s: string): number {
  let h = 0
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) % 360
  return h
}

/** "r g b" for a genre name (stable). */
export function genreColor(name: string): string {
  const h = hue(name) / 360
  const s = 0.55
  const l = 0.42
  const k = (n: number) => (n + h * 12) % 12
  const a = s * Math.min(l, 1 - l)
  const f = (n: number) => Math.round(255 * (l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)))))
  return `${f(0)} ${f(8)} ${f(4)}`
}

export function GenresView() {
  const { data } = useLibData(() => invoke<GenreRow[]>(LIB.genres), [])
  useViewHeader({ color: null })
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
        <Empty icon="genres" title="No genres yet">
          Genres come from MusicBrainz, Bandcamp tags or existing file tags on import.
        </Empty>
      ) : (
        <div className="genre-grid">
          {data.map((g) => (
            <div key={g.name} className="genre-tile" style={{ background: `rgb(${genreColor(g.name)})` }} onClick={() => navigate({ view: 'genre', genre: g.name })}>
              <b>{g.name}</b>
              <span>
                {plural(g.albumCount, 'album')} · {plural(g.trackCount, 'song')}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export function GenreDetailView({ genre }: { genre: string }) {
  const albums = useLibData(() => invoke<AlbumRow[]>(LIB.albums, { genre }), [genre]).data
  const src = { kind: 'other' as const, id: `genre:${genre}`, title: genre }
  const now = useSourcePlaying((s) => s?.kind === 'other' && s.id === `genre:${genre}`)
  const play = () => void playQuery({ genre }, undefined, src)
  useViewHeader({ color: genreColor(genre), strong: true, title: genre, play })
  return (
    <div className="view">
      <div className="hero hero-plain">
        <div className="hero-meta">
          <span className="hero-kicker">Genre</span>
          <h1 className="hero-title">{genre}</h1>
          {albums && <span className="hero-info">{plural(albums.length, 'album')}</span>}
        </div>
      </div>
      <ActionBar>
        <PlayButton onPlay={play} current={now.current} playing={now.playing} title={`Play ${genre}`} />
        <IconButton icon="shuffle" size={26} title="Shuffle" onClick={() => void playQuery({ genre }, undefined, src, true)} />
      </ActionBar>
      {albums && albums.length > 0 && (
        <section className="section">
          <h2 className="section-title">Albums</h2>
          <AlbumGrid albums={albums} />
        </section>
      )}
      <section className="section">
        <h2 className="section-title">Songs</h2>
        <TrackTable query={{ genre }} source={src} columns={['index', 'title', 'artist', 'album', 'heart', 'time', 'year']} showArt />
      </section>
    </div>
  )
}
