import { useState } from 'react'
import type { AlbumRow } from '@shared/types'
import { LIB } from '@shared/ipc/library'
import { invoke } from '../../lib/ipc'
import { plural } from '../../lib/format'
import { useLib, useLibData } from '../../state/library'
import { playQuery } from '../../state/player'
import { AlbumGrid } from '../../components/AlbumGrid'
import { Button, Segmented, Spinner } from '../../components/ui'
import { LibraryEmpty } from './Songs'

type Sort = 'artist' | 'title' | 'year' | 'added'
const SORT_KEY = 'valence.albums.sort'

export function AlbumsView() {
  const [sort, setSortState] = useState<Sort>(() => (localStorage.getItem(SORT_KEY) as Sort) || 'artist')
  const setSort = (s: Sort) => {
    setSortState(s)
    localStorage.setItem(SORT_KEY, s)
  }
  const stats = useLib((s) => s.stats)
  const { data } = useLibData(() => invoke<AlbumRow[]>(LIB.albums, { sort }), [sort])
  if (stats && stats.tracks === 0) return <LibraryEmpty />
  return (
    <div className="view">
      <AlbumGrid
        albums={data ?? []}
        subtitle={sort === 'year' ? (a) => `${a.albumArtist}${a.year ? ` · ${a.year}` : ''}` : undefined}
        header={
          <div className="view-head">
            <div>
              <h1 className="view-title">Albums</h1>
              {data && <div className="view-sub">{plural(data.length, 'album')}</div>}
            </div>
            <div className="view-actions">
              <Segmented
                value={sort}
                onChange={setSort}
                options={[
                  { value: 'artist', label: 'Artist' },
                  { value: 'title', label: 'Title' },
                  { value: 'year', label: 'Year' },
                  { value: 'added', label: 'Recent' },
                ]}
              />
              <Button icon="shuffle" onClick={() => void playQuery({}, undefined, { kind: 'library', title: 'Library' }, true)}>
                Shuffle All
              </Button>
            </div>
          </div>
        }
      />
      {!data && (
        <div className="center-spin">
          <Spinner />
        </div>
      )}
    </div>
  )
}

export function RecentView() {
  const { data } = useLibData(() => invoke<AlbumRow[]>(LIB.albums, { sort: 'added', limit: 120 }), [])
  return (
    <div className="view">
      <AlbumGrid
        albums={data ?? []}
        subtitle={(a) => a.albumArtist}
        header={
          <div className="view-head">
            <div>
              <h1 className="view-title">Recently Added</h1>
              <div className="view-sub">Newest imports first</div>
            </div>
            <div className="view-actions">
              <Button kind="primary" icon="play" onClick={() => void playQuery({ recentlyAdded: true }, undefined, { kind: 'library', title: 'Recently Added' })}>
                Play
              </Button>
            </div>
          </div>
        }
      />
      {data && !data.length && <div className="empty">Nothing added yet</div>}
    </div>
  )
}
