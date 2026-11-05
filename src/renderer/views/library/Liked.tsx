// Favorites (as on the phone): the songs, albums and artists you've hearted. A plain page header
// with the Music | SiivaGunner switch beside the title, then Songs / Albums / Artists chips. The
// switch keeps rips and normal music apart, and this computer remembers which side was open.

import { useEffect, useState } from 'react'
import { LIB } from '@shared/ipc/library'
import type { ArtistRow, TrackQuery } from '@shared/types'
import { invoke } from '../../lib/ipc'
import { cx, plural } from '../../lib/format'
import { playQuery } from '../../state/player'
import { useUi } from '../../state/ui'
import { setFavSide, useFavorites, type FavSide } from '../../state/favorites'
import { useViewHeader } from '../../shell/header'
import { AlbumGrid } from '../../components/AlbumGrid'
import { TrackTable } from '../../components/TrackTable'
import { VirtualGrid } from '../../components/VirtualGrid'
import { Icon } from '../../components/Icon'
import { Button, Empty, Segmented } from '../../components/ui'
import { ArtistTile } from './Artists'

type Tab = 'songs' | 'albums' | 'artists'

const SIDE_NAME: Record<FavSide, string> = { main: 'Music', rips: 'SiivaGunner' }
const source = (side: FavSide) => ({ kind: 'other' as const, id: 'liked', title: side === 'rips' ? 'SiivaGunner favorites' : 'Favorites' })

/** Favorite artists on one side of the switch (rip and music artists are listed apart). */
function useSideArtists(side: FavSide): ArtistRow[] {
  const sides = useFavorites((s) => s.sides)
  const [rows, setRows] = useState<ArtistRow[]>([])
  useEffect(() => {
    let live = true
    invoke<ArtistRow[]>(LIB.artists, { liked: true, collection: side })
      .then((r) => live && setRows(r))
      .catch(() => {})
    return () => {
      live = false
    }
    // `sides` changes whenever favorites change, so the list follows hearts made elsewhere.
  }, [side, sides])
  return rows
}

export function LikedView({ tab = 'songs' }: { tab?: Tab }) {
  const side = useFavorites((s) => s.side)
  const sides = useFavorites((s) => s.sides)
  const counts = sides[side]
  const other: FavSide = side === 'main' ? 'rips' : 'main'
  const artists = useSideArtists(side)
  const [sort, setSort] = useState<TrackQuery['sort']>()
  const query: TrackQuery = { liked: true, collection: side, sort }
  const play = () => void playQuery(query, undefined, source(side))
  useViewHeader({ color: null, title: 'Favorites', play: tab === 'songs' ? play : undefined })
  const info = tab === 'songs' ? plural(counts.tracks, side === 'rips' ? 'rip' : 'song') : tab === 'albums' ? plural(counts.albums, 'album') : plural(counts.artists, 'artist')
  const total = (s: FavSide) => sides[s].tracks + sides[s].albums + sides[s].artists

  // When this side is empty, offer the other one if it has something.
  const switchHint =
    total(other) > 0 ? (
      <div>
        <Button icon={other === 'rips' ? 'rips' : 'songs'} onClick={() => setFavSide(other)}>
          Show {SIDE_NAME[other]} favorites
        </Button>
      </div>
    ) : null

  return (
    <div className="view">
      <div className="view-head">
        <div>
          <h1 className="view-title">Favorites</h1>
          <div className="view-sub">
            {SIDE_NAME[side]} · {info}
          </div>
        </div>
        <Segmented<FavSide>
          className="fav-switch"
          label="Show favorites from"
          value={side}
          onChange={setFavSide}
          options={(['main', 'rips'] as const).map((s) => ({
            value: s,
            title: s === 'main' ? 'Your music library' : 'SiivaGunner rips',
            label: (
              <>
                <Icon name={s === 'main' ? 'songs' : 'rips'} size={16} />
                {SIDE_NAME[s]}
                <span className="pill-count">{sides[s].tracks.toLocaleString()}</span>
              </>
            ),
          }))}
        />
        {tab === 'songs' && counts.tracks > 0 && (
          <div className="view-actions">
            <Button kind="primary" icon="play" onClick={play}>
              Play
            </Button>
            <Button icon="shuffle" onClick={() => void playQuery({ liked: true, collection: side }, undefined, source(side), true)}>
              Shuffle
            </Button>
          </div>
        )}
      </div>
      <div className="pill-row">
        {(['songs', 'albums', 'artists'] as const).map((t) => (
          <button key={t} className={cx('pill', tab === t && 'on')} onClick={() => useUi.getState().navigate({ view: 'liked', tab: t }, { replace: true })}>
            {t === 'songs' ? (side === 'rips' ? 'Rips' : 'Songs') : t === 'albums' ? 'Albums' : 'Artists'}
            <span className="pill-count">{t === 'songs' ? counts.tracks : t === 'albums' ? counts.albums : counts.artists}</span>
          </button>
        ))}
      </div>
      {tab === 'songs' &&
        (counts.tracks === 0 ? (
          <Empty icon={side === 'rips' ? 'rips' : 'heart'} title={side === 'rips' ? 'No favorite rips yet' : 'No favorites yet'}>
            {side === 'rips'
              ? 'Click the heart on any rip in SiivaGunner, or press Alt+Shift+B while it plays. Favorites sync with your phone and other computers.'
              : 'Click the heart on any song, or press Alt+Shift+B while it plays. Favorites sync with your phone and other computers.'}
            {switchHint}
          </Empty>
        ) : (
          <TrackTable
            key={side}
            query={query}
            source={source(side)}
            sort={sort}
            onSort={setSort}
            showArt
            columns={['index', 'title', 'album', 'likedAt', 'heart', 'time']}
          />
        ))}
      {tab === 'albums' &&
        (counts.albums === 0 ? (
          <Empty icon="albums" title={side === 'rips' ? 'No favorite rip albums yet' : 'No favorite albums yet'}>
            Click the heart on an album page, or right-click an album.
            {switchHint}
          </Empty>
        ) : (
          <AlbumGrid key={side} query={{ liked: true, collection: side }} subtitle={(a) => a.albumArtist} />
        ))}
      {tab === 'artists' &&
        (counts.artists === 0 ? (
          <Empty icon="artists" title={side === 'rips' ? 'No favorite rip artists yet' : 'No favorite artists yet'}>
            Click the heart on an artist page.
            {switchHint}
          </Empty>
        ) : (
          <VirtualGrid key={side} items={artists} keyOf={(a) => a.name} extraH={51} render={(a) => <ArtistTile a={a} sub={plural(a.albumCount, 'album')} />} />
        ))}
    </div>
  )
}
