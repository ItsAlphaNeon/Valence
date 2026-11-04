// Home: a greeting, quick picks you can jump back into, and shelves built from your listening.

import { useEffect, useState } from 'react'
import type { AlbumRow } from '@shared/types'
import { LIB, type HomeData } from '@shared/ipc/library'
import { invoke } from '../../lib/ipc'
import { cx, plural } from '../../lib/format'
import { useLib, useLibData } from '../../state/library'
import { playQuery, playTracks } from '../../state/player'
import { albumRoute, navigate } from '../../state/ui'
import { useHeaderColor } from '../../theme/accent'
import { useViewHeader } from '../../shell/header'
import { AlbumTile, albumMenu } from '../../components/AlbumGrid'
import { PlayButton, Shelf, useSourcePlaying } from '../../components/Hero'
import { TrackTable } from '../../components/TrackTable'
import { Artwork, Button, Spinner } from '../../components/ui'
import { Icon } from '../../components/Icon'
import { ArtistTile } from './Artists'
import { LibraryEmpty } from './Songs'

function greeting(d = new Date()): string {
  const h = d.getHours()
  if (h < 5) return 'Up late'
  if (h < 12) return 'Good morning'
  if (h < 18) return 'Good afternoon'
  return 'Good evening'
}

/** Re-renders when the hour changes so the greeting stays right on a long session. */
function useHourly(): Date {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const ms = 3_600_000 - (Date.now() % 3_600_000) + 500
    const t = setTimeout(() => setNow(new Date()), ms)
    return () => clearTimeout(t)
  }, [now])
  return now
}

function QuickCard({ a, onHover }: { a: AlbumRow; onHover: (hash: string | null) => void }) {
  const now = useSourcePlaying((s) => s?.kind === 'album' && s.id === String(a.id))
  return (
    <div
      className={cx('quick-card', now.current && 'playing')}
      onClick={() => navigate(albumRoute(a.id, a.hqRip))}
      onContextMenu={(e) => albumMenu(e, a)}
      onMouseEnter={() => onHover(a.artHash)}
    >
      <Artwork hash={a.artHash} px={160} className="quick-art" title={a.title} />
      <div className="quick-title ellipsis" title={a.title}>
        {a.title}
      </div>
      <PlayButton
        size="sm"
        current={now.current}
        playing={now.playing}
        title={`Play ${a.title}`}
        onPlay={() => void invoke<number[]>(LIB.trackIds, { albumId: a.id }).then((ids) => playTracks(ids, 0, { kind: 'album', id: String(a.id), title: a.title }))}
      />
    </div>
  )
}

function LikedQuickCard({ count, onHover }: { count: number; onHover: (hash: string | null) => void }) {
  const now = useSourcePlaying((s) => s?.kind === 'other' && s.id === 'liked')
  return (
    <div className={cx('quick-card', now.current && 'playing')} onClick={() => navigate({ view: 'liked' })} onMouseEnter={() => onHover(null)}>
      <span className="quick-art liked-tile">
        <Icon name="heart" size={22} filled />
      </span>
      <div className="quick-title ellipsis">
        Liked Songs
        <span className="quick-sub">{plural(count, 'song')}</span>
      </div>
      <PlayButton size="sm" current={now.current} playing={now.playing} title="Play Liked Songs" onPlay={() => void playQuery({ liked: true }, undefined, { kind: 'other', id: 'liked', title: 'Liked Songs' })} />
    </div>
  )
}

export function HomeView() {
  const stats = useLib((s) => s.stats)
  const { data } = useLibData(() => invoke<HomeData>(LIB.home), [])
  const now = useHourly()
  const [hover, setHover] = useState<string | null | undefined>(undefined)
  const quick = data ? dedupe([...data.recentlyPlayed, ...data.favoriteAlbums, ...data.recentlyAdded]).slice(0, data.likedCount ? 7 : 8) : []
  const color = useHeaderColor(hover === undefined ? quick[0]?.artHash : hover)
  useViewHeader({ color, title: greeting(now) })

  if (stats && stats.tracks === 0 && stats.ripTracks === 0) return <LibraryEmpty />
  if (!data)
    return (
      <div className="view center-spin">
        <Spinner />
      </div>
    )
  const fresh = !data.recentlyPlayed.length && !data.mostPlayed.length
  return (
    <div className="view home">
      <h1 className="home-greeting">{greeting(now)}</h1>
      {quick.length > 0 && (
        <div className="quick-grid" onMouseLeave={() => setHover(undefined)}>
          {data.likedCount > 0 && <LikedQuickCard count={data.likedCount} onHover={setHover} />}
          {quick.map((a) => (
            <QuickCard key={a.id} a={a} onHover={setHover} />
          ))}
        </div>
      )}
      {fresh && (
        <div className="home-welcome">
          <Icon name="sparkle" size={20} />
          <div>
            <b>Start listening to fill this page.</b>
            <span>Valence learns what you play: recent albums, your top artists, songs on repeat and albums worth coming back to will show up here.</span>
          </div>
          <Button kind="primary" icon="shuffle" onClick={() => void playQuery({}, undefined, { kind: 'library', title: 'Library' }, true)}>
            Shuffle library
          </Button>
        </div>
      )}
      {data.recentlyPlayed.length > 0 && (
        <Shelf title="Jump back in" sub="Albums you played recently">
          {data.recentlyPlayed.map((a) => (
            <AlbumTile key={a.id} a={a} sub={a.albumArtist} />
          ))}
        </Shelf>
      )}
      {data.mostPlayed.length > 0 && (
        <section className="section">
          <div className="section-head">
            <div>
              <h2 className="section-title">On repeat</h2>
              <div className="section-sub">Your most played songs of the last 90 days</div>
            </div>
            <button className="section-more" onClick={() => navigate({ view: 'stats' })}>
              Listening stats
            </button>
          </div>
          <TrackTable rows={data.mostPlayed.slice(0, 5)} columns={['index', 'title', 'album', 'heart', 'plays', 'time']} source={{ kind: 'other', id: 'home:repeat', title: 'On repeat' }} showArt />
        </section>
      )}
      {data.topArtists.length > 0 && (
        <Shelf title="Your top artists" sub="Most played lately" onMore={() => navigate({ view: 'artists' })}>
          {data.topArtists.map((a) => (
            <ArtistTile key={a.name} a={a} sub={plural(a.plays, 'play')} />
          ))}
        </Shelf>
      )}
      {data.favoriteAlbums.length > 0 && (
        <Shelf title="Your albums" sub="Saved to your library" onMore={() => navigate({ view: 'liked', tab: 'albums' })}>
          {data.favoriteAlbums.map((a) => (
            <AlbumTile key={a.id} a={a} sub={a.albumArtist} />
          ))}
        </Shelf>
      )}
      {data.rediscover.length > 0 && (
        <Shelf title="Rediscover" sub="It's been a while. Fresh picks every day">
          {data.rediscover.map((a) => (
            <AlbumTile key={a.id} a={a} sub={a.albumArtist} />
          ))}
        </Shelf>
      )}
      {data.recentlyAdded.length > 0 && (
        <Shelf title="Recently added" onMore={() => navigate({ view: 'recent' })}>
          {data.recentlyAdded.map((a) => (
            <AlbumTile key={a.id} a={a} sub={a.albumArtist} />
          ))}
        </Shelf>
      )}
    </div>
  )
}

function dedupe(list: AlbumRow[]): AlbumRow[] {
  const seen = new Set<number>()
  return list.filter((a) => !seen.has(a.id) && (seen.add(a.id), true))
}
