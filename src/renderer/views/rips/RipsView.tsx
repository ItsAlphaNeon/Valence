// SiIvaGunner section of the library: season albums (YouTube rips), rip albums (highquality.rip and
// SGFR) and every rip as one song list. Rips never appear in the main library views.

import { useMemo, useState } from 'react'
import type { AlbumRow, TrackQuery } from '@shared/types'
import { LIB } from '@shared/ipc/library'
import { invoke } from '../../lib/ipc'
import { plural } from '../../lib/format'
import { useLib, useLibData } from '../../state/library'
import { playQuery } from '../../state/player'
import { navigate, type RipTab } from '../../state/ui'
import { AlbumGrid } from '../../components/AlbumGrid'
import { TrackTable } from '../../components/TrackTable'
import { Button, Empty, Segmented, Spinner } from '../../components/ui'

const ALBUM_KINDS = ['SiIvaGunner', 'SGFR']
const SEASON_KINDS = ['YouTube']

export function RipsView({ tab = 'seasons' }: { tab?: RipTab }) {
  const stats = useLib((s) => s.stats)
  if (stats && stats.ripTracks === 0) return <RipsEmpty />
  if (tab === 'songs') return <RipSongs />
  return <RipAlbums seasons={tab === 'seasons'} />
}

function RipsEmpty() {
  return (
    <div className="view">
      <Empty icon="disc" title="No High Quality Rips yet">
        <span>
          Download rip albums and SGFR releases from Get Rips, or set your SiIvaGunner playlist in Settings to fill the season albums. Songs you
          already have can be moved here from Get Info → High Quality Rip.
        </span>
        <span className="row">
          <Button kind="primary" icon="download" onClick={() => navigate({ view: 'hqrip' })}>
            Get Rips
          </Button>
          <Button icon="settings" onClick={() => navigate({ view: 'settings', section: 'siivagunner' })}>
            SiIvaGunner Settings
          </Button>
        </span>
      </Empty>
    </div>
  )
}

type AlbumSort = 'title' | 'year' | 'added'
const SORT_KEY = 'valence.rips.albums.sort'

/** "Season 4 Episode 2" → 4.5, "Season X" → 10; other titles sort after. */
export function seasonOrder(title: string): number {
  const m = /season\s+(x|\d+)(\s+episode\s+(\d+))?/i.exec(title)
  if (!m) return 1000
  const n = m[1].toLowerCase() === 'x' ? 10 : Number(m[1])
  return n + (m[3] ? Number(m[3]) / 10 : 0)
}

function RipAlbums({ seasons }: { seasons: boolean }) {
  const [sort, setSortState] = useState<AlbumSort>(() => (localStorage.getItem(SORT_KEY) as AlbumSort) || 'title')
  const setSort = (s: AlbumSort) => {
    setSortState(s)
    localStorage.setItem(SORT_KEY, s)
  }
  const kinds = seasons ? SEASON_KINDS : ALBUM_KINDS
  const { data } = useLibData(() => invoke<AlbumRow[]>(LIB.albums, { collection: 'rips', ripKinds: kinds, sort: seasons ? 'title' : sort }), [seasons, sort])
  // Seasons read in channel order (Season 1 … Season X), not alphabetically.
  const albums = useMemo(() => (seasons && data ? [...data].sort((a, b) => seasonOrder(a.title) - seasonOrder(b.title)) : data), [data, seasons])
  const src = { kind: 'library' as const, title: seasons ? 'Seasons' : 'Rip Albums' }
  const query: TrackQuery = { collection: 'rips', ripKinds: kinds }
  return (
    <div className="view">
      <AlbumGrid
        albums={albums ?? []}
        subtitle={(a) => (seasons ? plural(a.trackCount, 'rip') : [a.albumArtist, a.year].filter(Boolean).join(' · '))}
        header={
          <div className="view-head">
            <div>
              <h1 className="view-title">{seasons ? 'Seasons' : 'Rip Albums'}</h1>
              <div className="view-sub">
                {albums
                  ? seasons
                    ? `${plural(albums.length, 'season')} from your YouTube playlist`
                    : `${plural(albums.length, 'album')} from highquality.rip and SGFR`
                  : ' '}
              </div>
            </div>
            <div className="view-actions">
              {!seasons && (
                <Segmented
                  value={sort}
                  onChange={setSort}
                  options={[
                    { value: 'title', label: 'Title' },
                    { value: 'year', label: 'Year' },
                    { value: 'added', label: 'Recent' },
                  ]}
                />
              )}
              <Button icon="shuffle" onClick={() => void playQuery(query, undefined, src, true)}>
                Shuffle All
              </Button>
            </div>
          </div>
        }
      />
      {!albums && (
        <div className="center-spin">
          <Spinner />
        </div>
      )}
      {albums && !albums.length && (
        <div className="empty">
          {seasons ? 'No season rips yet: set your SiIvaGunner playlist in Settings → SiIvaGunner.' : 'No rip albums yet: download some from Get Rips.'}
        </div>
      )}
    </div>
  )
}

const SONG_SORT_KEY = 'valence.rips.songs.sort'

function loadSort(): TrackQuery['sort'] {
  try {
    return JSON.parse(localStorage.getItem(SONG_SORT_KEY) ?? 'null') ?? undefined
  } catch {
    return undefined
  }
}

function RipSongs() {
  const stats = useLib((s) => s.stats)
  const [sort, setSort] = useState<TrackQuery['sort']>(loadSort)
  const query: TrackQuery = { collection: 'rips', sort }
  const src = { kind: 'library' as const, title: 'Rip Songs' }
  return (
    <div className="view">
      <div className="view-head">
        <div>
          <h1 className="view-title">Rip Songs</h1>
          {stats && <div className="view-sub">{plural(stats.ripTracks, 'rip')}</div>}
        </div>
        <div className="view-actions">
          <Button kind="primary" icon="play" onClick={() => void playQuery(query, undefined, src)}>
            Play
          </Button>
          <Button icon="shuffle" onClick={() => void playQuery(query, undefined, src, true)}>
            Shuffle
          </Button>
        </div>
      </div>
      <TrackTable
        query={query}
        source={src}
        sort={sort}
        onSort={(s) => {
          setSort(s)
          localStorage.setItem(SONG_SORT_KEY, JSON.stringify(s ?? null))
        }}
        columns={['title', 'game', 'album', 'composer', 'time', 'rating', 'plays', 'added']}
      />
    </div>
  )
}
