import { useState } from 'react'
import type { AlbumQuery } from '@shared/ipc/library'
import { cx, plural } from '../../lib/format'
import { useLib, useSetting } from '../../state/library'
import { playQuery } from '../../state/player'
import { useViewHeader } from '../../shell/header'
import { AlbumGrid } from '../../components/AlbumGrid'
import { Button, Segmented } from '../../components/ui'
import { Icon } from '../../components/Icon'
import { LibraryEmpty } from './Songs'

type Sort = NonNullable<AlbumQuery['sort']>
const SORT_KEY = 'valence.albums.sort'
const SORTS: Array<{ value: Sort; label: string }> = [
  { value: 'artist', label: 'Artist' },
  { value: 'title', label: 'Title' },
  { value: 'year', label: 'Year' },
  { value: 'added', label: 'Recently added' },
]

function loadSort(): Sort {
  try {
    const s = localStorage.getItem(SORT_KEY) as Sort | null
    return s && SORTS.some((x) => x.value === s) ? s : 'artist'
  } catch {
    return 'artist'
  }
}

export function AlbumsView() {
  const [sort, setSortState] = useState<Sort>(loadSort)
  const [liked, setLiked] = useState(false)
  const [size, setSize] = useSetting<string>('ui.tileSize', 'medium')
  const setSort = (s: Sort) => {
    setSortState(s)
    try {
      localStorage.setItem(SORT_KEY, s)
    } catch {
      /* private storage */
    }
  }
  const stats = useLib((s) => s.stats)
  useViewHeader({ color: null })
  if (stats && stats.tracks === 0) return <LibraryEmpty />
  const query: AlbumQuery = liked ? { sort, liked: true } : { sort }
  return (
    <div className="view">
      <AlbumGrid
        query={query}
        subtitle={sort === 'year' ? (a) => [a.year, a.albumArtist].filter(Boolean).join(' · ') : (a) => a.albumArtist}
        header={
          <>
            <div className="view-head">
              <div>
                <h1 className="view-title">Albums</h1>
                {stats && <div className="view-sub">{plural(stats.albums, 'album')}</div>}
              </div>
              <div className="view-actions">
                <Button icon="shuffle" onClick={() => void playQuery({}, undefined, { kind: 'library', title: 'Library' }, true)}>
                  Shuffle all
                </Button>
              </div>
            </div>
            <div className="filter-bar">
              <button className={cx('pill', liked && 'on')} onClick={() => setLiked(!liked)}>
                <Icon name="heart" size={13} filled={liked} /> Saved
              </button>
              <span className="filter-sep" />
              {SORTS.map((s) => (
                <button key={s.value} className={cx('pill', sort === s.value && 'on')} onClick={() => setSort(s.value)}>
                  {s.label}
                </button>
              ))}
              <span className="grow" />
              <Segmented
                className="tile-size"
                value={size}
                onChange={setSize}
                options={[
                  { value: 'small', label: <Icon name="grid" size={12} /> },
                  { value: 'medium', label: <Icon name="grid" size={15} /> },
                  { value: 'large', label: <Icon name="grid" size={18} /> },
                ]}
              />
            </div>
          </>
        }
      />
    </div>
  )
}

export function RecentView() {
  useViewHeader({ color: null })
  return (
    <div className="view">
      <AlbumGrid
        query={{ sort: 'added' }}
        subtitle={(a) => a.albumArtist}
        header={
          <div className="view-head">
            <div>
              <h1 className="view-title">Recently added</h1>
              <div className="view-sub">Newest imports first</div>
            </div>
            <div className="view-actions">
              <Button kind="primary" icon="play" onClick={() => void playQuery({ recentlyAdded: true }, undefined, { kind: 'library', title: 'Recently added' })}>
                Play
              </Button>
            </div>
          </div>
        }
      />
    </div>
  )
}
