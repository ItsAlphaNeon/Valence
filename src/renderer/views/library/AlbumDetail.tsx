import type { AlbumRow } from '@shared/types'
import { LIB, type AlbumDetail } from '@shared/ipc/library'
import { invoke, revealLabel } from '../../lib/ipc'
import { longDuration, plural, quality } from '../../lib/format'
import { useLibData } from '../../state/library'
import { addToQueue, playNext, playShuffled, playTracks } from '../../state/player'
import { navigate, useUi } from '../../state/ui'
import { TrackTable, type ColumnKey } from '../../components/TrackTable'
import { AlbumTile } from '../../components/AlbumGrid'
import { Artwork, Button, Empty, IconButton, Spinner, showMenu } from '../../components/ui'

function kindOf(a: AlbumRow): string {
  if (a.compilation) return 'Compilation'
  // trackTotal is per disc (from the tags), so a multi-disc set can have a small one.
  const n = Math.max(a.trackCount, a.trackTotal ?? 0)
  if (n <= 3 && a.durationMs < 30 * 60_000) return 'Single'
  if (n <= 6 && a.durationMs < 30 * 60_000) return 'EP'
  return 'Album'
}

export function AlbumDetailView({ id }: { id: number }) {
  const { data, loading } = useLibData(() => invoke<AlbumDetail | null>(LIB.album, id), [id])
  const album = data?.album
  const more = useLibData(
    () => (album ? invoke<AlbumRow[]>(LIB.albums, { albumArtist: album.albumArtist, sort: 'year' }) : Promise.resolve([])),
    [album?.albumArtist],
  ).data?.filter((a) => a.id !== id)

  if (!data) return loading ? <div className="view center-spin"><Spinner /></div> : <div className="view"><Empty icon="albums" title="Album not found" /></div>
  const { tracks } = data
  const a = data.album
  const ids = tracks.map((t) => t.id)
  const src = { kind: 'album' as const, id: String(a.id), title: a.title }
  const variousArtists = tracks.some((t) => t.artist !== a.albumArtist)
  const columns: ColumnKey[] = variousArtists ? ['index', 'title', 'artist', 'time', 'rating', 'plays'] : ['index', 'title', 'time', 'rating', 'plays']
  const qualities = [...new Set(tracks.map((t) => quality(t)))]
  const partial = a.trackTotal && a.trackTotal > tracks.length ? `${tracks.length} of ${a.trackTotal} songs` : plural(tracks.length, 'song')

  return (
    <div className="view">
      <div className="hero">
        <Artwork hash={a.artHash} px={600} className="hero-art" title={a.title} />
        <div className="hero-meta">
          <span className="hero-kicker">{kindOf(a)}</span>
          <h1 className="hero-title">{a.title}</h1>
          <span className="hero-sub">
            <a className="link-muted" onClick={() => navigate({ view: 'artist', artist: a.albumArtist })}>
              {a.albumArtist}
            </a>
          </span>
          <span className="hero-info">
            {[a.genre, a.year, partial, longDuration(a.durationMs)].filter(Boolean).join(' · ')}
          </span>
          <span className="hero-info faint">{qualities.slice(0, 2).join(', ')}</span>
          <div className="hero-actions">
            <Button kind="primary" icon="play" onClick={() => void playTracks(ids, 0, src)}>
              Play
            </Button>
            <Button icon="shuffle" onClick={() => void playShuffled(ids, src)}>
              Shuffle
            </Button>
            <IconButton
              icon="more"
              title="More"
              onClick={(e) =>
                showMenu(e, [
                  { label: 'Play Next', icon: 'queue', onClick: () => void playNext(ids) },
                  { label: 'Add to Up Next', onClick: () => void addToQueue(ids) },
                  { label: 'Add to Playlist…', icon: 'playlist', onClick: () => window.dispatchEvent(new CustomEvent('valence:new-playlist', { detail: ids })) },
                  { separator: true },
                  { label: 'Get Info', icon: 'info', onClick: () => useUi.getState().openGetInfo(ids) },
                  { label: revealLabel, icon: 'folder', onClick: () => void invoke(LIB.reveal, ids[0]) },
                ])
              }
            />
          </div>
        </div>
      </div>
      <TrackTable rows={tracks} columns={columns} source={src} discHeaders />
      <div className="faint" style={{ fontSize: 12, margin: '18px 0 0' }}>
        {a.relDir}
      </div>
      {more && more.length > 0 && (
        <div className="section">
          <h2 className="section-title">More by {a.albumArtist}</h2>
          <div className="search-albums">
            {more.slice(0, 12).map((m) => (
              <AlbumTile key={m.id} a={m} sub={m.year ?? ''} />
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
