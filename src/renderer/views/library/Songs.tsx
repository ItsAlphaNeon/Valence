import { useState } from 'react'
import type { TrackQuery } from '@shared/types'
import { longDuration, plural } from '../../lib/format'
import { useLib } from '../../state/library'
import { playQuery } from '../../state/player'
import { TrackTable } from '../../components/TrackTable'
import { Button, Empty } from '../../components/ui'
import { navigate } from '../../state/ui'

const SORT_KEY = 'valence.songs.sort'

function loadSort(): TrackQuery['sort'] {
  try {
    return JSON.parse(localStorage.getItem(SORT_KEY) ?? 'null') ?? undefined
  } catch {
    return undefined
  }
}

export function SongsView() {
  const stats = useLib((s) => s.stats)
  const [sort, setSort] = useState<TrackQuery['sort']>(loadSort)
  const query: TrackQuery = { sort }
  const src = { kind: 'library' as const, title: 'Songs' }
  if (stats && stats.tracks === 0) return <LibraryEmpty />
  return (
    <div className="view">
      <div className="view-head">
        <div>
          <h1 className="view-title">Songs</h1>
          {stats && (
            <div className="view-sub">
              {plural(stats.tracks, 'song')} · {longDuration(stats.durationMs)}
            </div>
          )}
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
          localStorage.setItem(SORT_KEY, JSON.stringify(s ?? null))
        }}
        columns={['title', 'artist', 'album', 'time', 'genre', 'year', 'rating', 'plays', 'added']}
      />
    </div>
  )
}

export function LibraryEmpty() {
  return (
    <div className="view">
      <Empty icon="songs" title="Your library is empty">
        <span>Drop music files or folders anywhere on this window, put them in your Valence Inbox, or download from TIDAL and Bandcamp.</span>
        <span className="row">
          <Button kind="primary" icon="inbox" onClick={() => navigate({ view: 'import' })}>
            Import
          </Button>
          <Button icon="wave" onClick={() => navigate({ view: 'tidal' })}>
            TIDAL
          </Button>
          <Button icon="disc" onClick={() => navigate({ view: 'bandcamp' })}>
            Bandcamp
          </Button>
        </span>
      </Empty>
    </div>
  )
}
