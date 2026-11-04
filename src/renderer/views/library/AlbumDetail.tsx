import type { AlbumRow } from '@shared/types'
import { LIB, type AlbumDetail } from '@shared/ipc/library'
import { invoke, revealLabel } from '../../lib/ipc'
import { longDuration, plural, quality } from '../../lib/format'
import { useLib, useLibData } from '../../state/library'
import { addToQueue, playNext, playShuffled, playTracks } from '../../state/player'
import { navigate, toast, useUi } from '../../state/ui'
import { TrackTable, type ColumnKey } from '../../components/TrackTable'
import { AlbumTile } from '../../components/AlbumGrid'
import { ActionBar, Hero, PlayButton, Shelf, useSourcePlaying } from '../../components/Hero'
import { HeartButton } from '../../components/Heart'
import { Empty, IconButton, Spinner, showMenu, type MenuItem } from '../../components/ui'

function kindOf(a: AlbumRow): string {
  if (a.hqRip === 'YouTube') return 'High Quality Rips · Season'
  if (a.hqRip) return `High Quality Rips · ${a.hqRip === 'SGFR' ? 'SGFR' : 'Album'}`
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
  const playlists = useLib((s) => s.playlists)
  const more = useLibData(
    () =>
      album
        ? invoke<AlbumRow[]>(LIB.albums, { albumArtist: album.albumArtist, sort: 'year', collection: album.hqRip ? 'rips' : 'main' })
        : Promise.resolve([]),
    [album?.albumArtist, album?.hqRip],
  ).data?.filter((a) => a.id !== id)
  const src = { kind: 'album' as const, id: String(id), title: album?.title }
  const now = useSourcePlaying((s) => s?.kind === 'album' && s.id === String(id))

  if (!data)
    return loading ? (
      <div className="view center-spin">
        <Spinner />
      </div>
    ) : (
      <div className="view">
        <Empty icon="albums" title="Album not found" />
      </div>
    )
  const { tracks } = data
  const a = data.album
  const ids = tracks.map((t) => t.id)
  const variousArtists = tracks.some((t) => t.artist !== a.albumArtist)
  const columns: ColumnKey[] = variousArtists ? ['index', 'title', 'artist', 'heart', 'time', 'rating', 'plays'] : ['index', 'title', 'heart', 'time', 'rating', 'plays']
  const qualities = [...new Set(tracks.map((t) => quality(t)))]
  const partial = a.trackTotal && a.trackTotal > tracks.length ? `${tracks.length} of ${a.trackTotal} songs` : plural(tracks.length, 'song')
  const play = () => void playTracks(ids, 0, { ...src, title: a.title })

  const moreMenu = (e: React.MouseEvent) =>
    showMenu(e, [
      { label: 'Play next', icon: 'queue', onClick: () => void playNext(ids) },
      { label: 'Add to queue', onClick: () => void addToQueue(ids) },
      {
        label: 'Add to playlist',
        icon: 'playlist',
        submenu: [
          { label: 'New playlist…', icon: 'plus', onClick: () => window.dispatchEvent(new CustomEvent('valence:new-playlist', { detail: ids })) },
          ...(playlists.some((p) => p.kind === 'static') ? [{ separator: true } as MenuItem] : []),
          ...playlists
            .filter((p) => p.kind === 'static')
            .map((p) => ({ label: p.name, onClick: () => void invoke(LIB.addToPlaylist, p.id, ids).then(() => toast(`Added to “${p.name}”`, 'ok')) })),
        ],
      },
      { separator: true },
      { label: 'View artwork', icon: 'zoomIn', onClick: () => useUi.getState().openArt({ hash: a.artHash, albumId: a.id, title: a.title, sub: a.albumArtist }) },
      { label: 'Get Info', icon: 'info', onClick: () => useUi.getState().openGetInfo(ids) },
      { label: 'Go to artist', icon: 'artists', onClick: () => navigate({ view: 'artist', artist: a.albumArtist }) },
      { label: revealLabel, icon: 'folder', onClick: () => void invoke(LIB.reveal, ids[0]) },
    ])

  return (
    <div className="view">
      <Hero
        art={{ hash: a.artHash, albumId: a.id, title: a.title, sub: a.albumArtist }}
        kicker={kindOf(a)}
        title={a.title}
        play={play}
        sub={
          <>
            <a onClick={() => navigate({ view: 'artist', artist: a.albumArtist })}>{a.albumArtist}</a>
            {[a.year, partial, longDuration(a.durationMs)].filter(Boolean).map((x) => (
              <span key={String(x)} className="hero-dim">
                <span className="dot-sep" />
                {x}
              </span>
            ))}
          </>
        }
        info={[a.genre, qualities.slice(0, 2).join(', ')].filter(Boolean).join(' · ')}
      />
      <ActionBar>
        <PlayButton onPlay={play} current={now.current} playing={now.playing} title={`Play ${a.title}`} />
        <IconButton icon="shuffle" size={26} title="Shuffle" onClick={() => void playShuffled(ids, { ...src, title: a.title })} />
        <HeartButton target={{ kind: 'album', id: a.id }} liked={a.liked} size={28} />
        <IconButton icon="more" size={26} title={`More options for ${a.title}`} onClick={moreMenu} />
      </ActionBar>
      <TrackTable rows={tracks} columns={columns} source={{ ...src, title: a.title }} discHeaders />
      <div className="album-foot">
        {a.year && <div>{tracks[0]?.date && tracks[0].date.length > 4 ? new Date(tracks[0].date).toLocaleDateString(undefined, { dateStyle: 'long' }) : a.year}</div>}
        <div className="faint mono">{a.relDir}</div>
      </div>
      {more && more.length > 0 && (
        <Shelf title={`More by ${a.albumArtist}`} onMore={() => navigate({ view: 'artist', artist: a.albumArtist })}>
          {more.slice(0, 12).map((m) => (
            <AlbumTile key={m.id} a={m} sub={m.year ?? kindOf(m)} />
          ))}
        </Shelf>
      )}
    </div>
  )
}
