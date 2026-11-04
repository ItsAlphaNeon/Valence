// Favorites (as on the phone): the songs, albums and artists you've hearted. A plain page header,
// then Songs / Albums / Artists chips.

import { useState } from 'react'
import type { TrackQuery } from '@shared/types'
import { cx, plural } from '../../lib/format'
import { playQuery } from '../../state/player'
import { useUi } from '../../state/ui'
import { useFavorites } from '../../state/favorites'
import { useViewHeader } from '../../shell/header'
import { AlbumGrid } from '../../components/AlbumGrid'
import { TrackTable } from '../../components/TrackTable'
import { VirtualGrid } from '../../components/VirtualGrid'
import { Button, Empty } from '../../components/ui'
import { ArtistTile } from './Artists'

type Tab = 'songs' | 'albums' | 'artists'
const FAV_SRC = { kind: 'other' as const, id: 'liked', title: 'Favorites' }

export function LikedView({ tab = 'songs' }: { tab?: Tab }) {
  const counts = useFavorites((s) => s.counts)
  const artists = useFavorites((s) => s.artists)
  const [sort, setSort] = useState<TrackQuery['sort']>()
  const query: TrackQuery = { liked: true, sort }
  const play = () => void playQuery({ liked: true, sort }, undefined, FAV_SRC)
  useViewHeader({ color: null, title: 'Favorites', play: tab === 'songs' ? play : undefined })
  const info = tab === 'songs' ? plural(counts.tracks, 'song') : tab === 'albums' ? plural(counts.albums, 'album') : plural(counts.artists, 'artist')

  return (
    <div className="view">
      <div className="view-head">
        <div>
          <h1 className="view-title">Favorites</h1>
          <div className="view-sub">{info}</div>
        </div>
        {tab === 'songs' && counts.tracks > 0 && (
          <div className="view-actions">
            <Button kind="primary" icon="play" onClick={play}>
              Play
            </Button>
            <Button icon="shuffle" onClick={() => void playQuery({ liked: true }, undefined, FAV_SRC, true)}>
              Shuffle
            </Button>
          </div>
        )}
      </div>
      <div className="pill-row">
        {(['songs', 'albums', 'artists'] as const).map((t) => (
          <button key={t} className={cx('pill', tab === t && 'on')} onClick={() => useUi.getState().navigate({ view: 'liked', tab: t }, { replace: true })}>
            {t === 'songs' ? 'Songs' : t === 'albums' ? 'Albums' : 'Artists'}
            <span className="pill-count">{t === 'songs' ? counts.tracks : t === 'albums' ? counts.albums : counts.artists}</span>
          </button>
        ))}
      </div>
      {tab === 'songs' &&
        (counts.tracks === 0 ? (
          <Empty icon="heart" title="No favorites yet">
            Click the heart on any song, or press Alt+Shift+B while it plays. Favorites sync with your phone and other computers.
          </Empty>
        ) : (
          <TrackTable query={query} source={FAV_SRC} sort={sort} onSort={setSort} showArt columns={['index', 'title', 'album', 'likedAt', 'heart', 'time']} />
        ))}
      {tab === 'albums' &&
        (counts.albums === 0 ? (
          <Empty icon="albums" title="No favorite albums yet">
            Click the heart on an album page, or right-click an album.
          </Empty>
        ) : (
          <AlbumGrid query={{ liked: true }} subtitle={(a) => a.albumArtist} />
        ))}
      {tab === 'artists' &&
        (artists.length === 0 ? (
          <Empty icon="artists" title="No favorite artists yet">
            Click the heart on an artist page.
          </Empty>
        ) : (
          <VirtualGrid items={artists} keyOf={(a) => a.name} extraH={51} render={(a) => <ArtistTile a={a} sub={plural(a.albumCount, 'album')} />} />
        ))}
    </div>
  )
}
