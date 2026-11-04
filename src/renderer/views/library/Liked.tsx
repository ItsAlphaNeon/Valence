// Liked Songs and the rest of your saved library: songs, albums and artists you've hearted.

import { useState } from 'react'
import type { TrackQuery } from '@shared/types'
import { cx, plural } from '../../lib/format'
import { playQuery } from '../../state/player'
import { navigate } from '../../state/ui'
import { useFavorites } from '../../state/favorites'
import { useViewHeader } from '../../shell/header'
import { AlbumGrid } from '../../components/AlbumGrid'
import { TrackTable } from '../../components/TrackTable'
import { VirtualGrid } from '../../components/VirtualGrid'
import { ActionBar, PlayButton, useSourcePlaying } from '../../components/Hero'
import { Empty, IconButton } from '../../components/ui'
import { Icon } from '../../components/Icon'
import { ArtistTile } from './Artists'

type Tab = 'songs' | 'albums' | 'artists'
const LIKED_SRC = { kind: 'other' as const, id: 'liked', title: 'Liked Songs' }
/** Liked Songs' header color: a deep violet like the tile. */
const LIKED_COLOR = '80 56 160'

export function LikedView({ tab = 'songs' }: { tab?: Tab }) {
  const counts = useFavorites((s) => s.counts)
  const artists = useFavorites((s) => s.artists)
  const [sort, setSort] = useState<TrackQuery['sort']>()
  const query: TrackQuery = { liked: true, sort }
  const now = useSourcePlaying((s) => s?.kind === 'other' && s.id === 'liked')
  const play = () => void playQuery({ liked: true, sort }, undefined, LIKED_SRC)
  const title = tab === 'songs' ? 'Liked Songs' : tab === 'albums' ? 'Your albums' : 'Your artists'
  useViewHeader({ color: LIKED_COLOR, strong: true, title, play: tab === 'songs' ? play : undefined })
  const info = tab === 'songs' ? plural(counts.tracks, 'song') : tab === 'albums' ? plural(counts.albums, 'album') : plural(counts.artists, 'artist')

  return (
    <div className="view">
      <div className="hero">
        <span className="hero-art liked-tile">
          <Icon name="heart" size={84} filled />
        </span>
        <div className="hero-meta">
          <span className="hero-kicker">Your library</span>
          <h1 className="hero-title">{title}</h1>
          <span className="hero-info">{info}</span>
        </div>
      </div>
      <ActionBar>
        {tab === 'songs' && (
          <>
            <PlayButton onPlay={play} current={now.current} playing={now.playing} title="Play Liked Songs" />
            <IconButton icon="shuffle" size={26} title="Shuffle" onClick={() => void playQuery({ liked: true }, undefined, LIKED_SRC, true)} />
          </>
        )}
        <div className="pill-row inline">
          {(['songs', 'albums', 'artists'] as const).map((t) => (
            <button key={t} className={cx('pill', tab === t && 'on')} onClick={() => navigate({ view: 'liked', tab: t })}>
              {t === 'songs' ? 'Songs' : t === 'albums' ? 'Albums' : 'Artists'}
              <span className="pill-count">{t === 'songs' ? counts.tracks : t === 'albums' ? counts.albums : counts.artists}</span>
            </button>
          ))}
        </div>
      </ActionBar>
      {tab === 'songs' &&
        (counts.tracks === 0 ? (
          <Empty icon="heart" title="Songs you like will appear here">
            Tap the heart next to any song, or press Alt+Shift+B while it plays.
          </Empty>
        ) : (
          <TrackTable query={query} source={LIKED_SRC} sort={sort} onSort={setSort} showArt columns={['index', 'title', 'album', 'likedAt', 'heart', 'time']} />
        ))}
      {tab === 'albums' &&
        (counts.albums === 0 ? (
          <Empty icon="albums" title="Save albums to find them here">
            Use the heart on an album page, or right-click an album and choose Save to your library.
          </Empty>
        ) : (
          <AlbumGrid query={{ liked: true }} subtitle={(a) => a.albumArtist} />
        ))}
      {tab === 'artists' &&
        (artists.length === 0 ? (
          <Empty icon="artists" title="Follow artists you love">
            Use the heart on an artist page to keep them in your sidebar.
          </Empty>
        ) : (
          <VirtualGrid items={artists} keyOf={(a) => a.name} extraH={66} render={(a) => <ArtistTile a={a} sub={plural(a.albumCount, 'album')} />} />
        ))}
    </div>
  )
}
