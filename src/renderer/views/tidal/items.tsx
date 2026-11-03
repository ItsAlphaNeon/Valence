// TIDAL tiles and track lists with in-library badges, live queue state and one-click downloads.

import { memo, type ReactNode } from 'react'
import type { TidalAlbumSummary, TidalArtistSummary, TidalPlaylistSummary, TidalTrackSummary } from '@shared/ipc/tidal'
import { cx, plural } from '../../lib/format'
import { navigate } from '../../state/ui'
import { showMenu, type MenuItem } from '../../components/ui'
import { copyLink, openLink, DownloadControl, SourceTile, TrackListHead, TrackRow, trackBadge, useQueueState } from './source-kit'
import { tidalAlbumKeys, tidalPlaylistKey, tidalReleaseType, tidalTrackKeys } from './source-helpers'
import { downloadAlbum, downloadTidalPlaylist, downloadTrack } from './tidal-state'

export const openAlbum = (id: string) => navigate({ view: 'tidal', tab: 'album', id })
export const openArtist = (id: string) => navigate({ view: 'tidal', tab: 'artist', id })
export const openPlaylist = (uuid: string) => navigate({ view: 'tidal', tab: 'playlist', id: uuid })

/** Artist credit with each named artist linking to its TIDAL page. */
export function ArtistLinks({ artists, fallback }: { artists: TidalAlbumSummary['artists']; fallback: string }) {
  if (!artists.length) return <>{fallback}</>
  return (
    <>
      {artists.map((a, i) => (
        <span key={a.id}>
          {i > 0 && ', '}
          <a
            className="link-muted"
            onClick={(e) => {
              e.stopPropagation()
              openArtist(a.id)
            }}
          >
            {a.name}
          </a>
        </span>
      ))}
    </>
  )
}

export function albumMenu(e: React.MouseEvent, a: TidalAlbumSummary): void {
  const items: MenuItem[] = [
    { label: 'Open Album', icon: 'albums', onClick: () => openAlbum(a.id) },
    { label: a.badge.status === 'in-library' ? 'Download Again' : 'Download Album', icon: 'download', onClick: () => void downloadAlbum(a) },
  ]
  if (a.badge.status === 'partial') items.push({ label: `Download ${a.badge.total - a.badge.have} Missing Tracks`, onClick: () => void downloadAlbum(a, true) })
  items.push({ separator: true })
  if (a.artists[0]) items.push({ label: 'Go to Artist', icon: 'artists', onClick: () => openArtist(a.artists[0].id) })
  items.push({ label: 'Open on TIDAL', icon: 'link', onClick: () => openLink(a.url) }, { label: 'Copy TIDAL Link', icon: 'link', onClick: () => copyLink(a.url) })
  showMenu(e, items)
}

export const AlbumTile = memo(function AlbumTile({ a, sub }: { a: TidalAlbumSummary; sub?: ReactNode }) {
  const queue = useQueueState(tidalAlbumKeys(a), a.queue)
  const type = tidalReleaseType(a.type, a.numberOfTracks)
  return (
    <SourceTile
      art={a.cover}
      title={a.title}
      explicit={a.explicit}
      sub={sub ?? [a.artist, type !== 'Album' ? type : null, a.year].filter(Boolean).join(' · ')}
      onOpen={() => openAlbum(a.id)}
      onContextMenu={(e) => albumMenu(e, a)}
      footer={<DownloadControl badge={a.badge} queue={queue} onDownload={() => downloadAlbum(a)} label="Download Album" />}
    />
  )
})

export const PlaylistTile = memo(function PlaylistTile({ p }: { p: TidalPlaylistSummary }) {
  const queue = useQueueState([tidalPlaylistKey(p.uuid)], p.queue)
  return (
    <SourceTile
      art={p.image}
      title={p.title}
      sub={[p.creator, plural(p.numberOfTracks, 'track')].filter(Boolean).join(' · ')}
      onOpen={() => openPlaylist(p.uuid)}
      onContextMenu={(e) =>
        showMenu(e, [
          { label: 'Open Playlist', icon: 'playlist', onClick: () => openPlaylist(p.uuid) },
          { label: 'Download Playlist', icon: 'download', onClick: () => void downloadTidalPlaylist(p) },
          { separator: true },
          { label: 'Open on TIDAL', icon: 'link', onClick: () => openLink(p.url) }, { label: 'Copy TIDAL Link', icon: 'link', onClick: () => copyLink(p.url) },
        ])
      }
      footer={<DownloadControl badge={p.badge} queue={queue} onDownload={() => downloadTidalPlaylist(p)} label="Download Playlist" />}
    />
  )
})

export const ArtistTile = memo(function ArtistTile({ a }: { a: TidalArtistSummary }) {
  return (
    <SourceTile
      round
      art={a.picture}
      title={a.name}
      onOpen={() => openArtist(a.id)}
      onContextMenu={(e) =>
        showMenu(e, [
          { label: 'Open Artist', icon: 'artists', onClick: () => openArtist(a.id) },
          { label: 'Open on TIDAL', icon: 'link', onClick: () => openLink(a.url) }, { label: 'Copy TIDAL Link', icon: 'link', onClick: () => copyLink(a.url) },
        ])
      }
    />
  )
})

export function AlbumGrid({ albums }: { albums: TidalAlbumSummary[] }) {
  return (
    <div className="src-grid">
      {albums.map((a) => (
        <AlbumTile key={a.id} a={a} />
      ))}
    </div>
  )
}

// ---- Tracks ----

function trackMenu(e: React.MouseEvent, t: TidalTrackSummary): void {
  const items: MenuItem[] = [{ label: t.inLibrary ? 'Download Again' : 'Download Track', icon: 'download', disabled: !t.streamable, onClick: () => void downloadTrack(t) }]
  if (t.album) {
    const album = t.album
    items.push({ label: 'Go to Album', icon: 'albums', onClick: () => openAlbum(album.id) })
  }
  if (t.artists[0]) items.push({ label: 'Go to Artist', icon: 'artists', onClick: () => openArtist(t.artists[0].id) })
  items.push({ separator: true }, { label: 'Open on TIDAL', icon: 'link', onClick: () => openLink(t.url) }, { label: 'Copy TIDAL Link', icon: 'link', onClick: () => copyLink(t.url) })
  showMenu(e, items)
}

const TidalTrackRow = memo(function TidalTrackRow({
  t,
  index,
  showArt,
  showAlbum,
  showArtist,
}: {
  t: TidalTrackSummary
  index: number
  showArt?: boolean
  showAlbum?: boolean
  showArtist?: boolean
}) {
  const queue = useQueueState(tidalTrackKeys(t), t.queue)
  const album = t.album
  return (
    <TrackRow
      lead={index}
      art={showArt ? (album?.cover ?? null) : undefined}
      title={t.title}
      explicit={t.explicit}
      sub={showArtist ? <ArtistLinks artists={t.artists} fallback={t.artist} /> : undefined}
      album={
        showAlbum ? (
          album ? (
            <a className="link-muted" onClick={() => openAlbum(album.id)}>
              {album.title}
            </a>
          ) : (
            ''
          )
        ) : undefined
      }
      durationSec={t.durationSec}
      dim={!t.streamable}
      dimReason="Not available on TIDAL in your region"
      onContextMenu={(e) => trackMenu(e, t)}
      right={
        t.streamable ? (
          <DownloadControl badge={trackBadge(t.inLibrary)} queue={queue} compact onDownload={() => downloadTrack(t)} label="Download Track" />
        ) : (
          <span className="chip" title="TIDAL doesn’t offer this track for streaming in your region">
            Unavailable
          </span>
        )
      }
    />
  )
})

/**
 * Track list. `album` mode numbers by track number with disc headers; otherwise rows show artwork and
 * an album column.
 */
export function TidalTrackList({ tracks, mode, albumArtist }: { tracks: TidalTrackSummary[]; mode: 'album' | 'list'; albumArtist?: string }) {
  if (mode === 'album') {
    const discs = new Set(tracks.map((t) => t.volumeNumber || 1))
    const multi = discs.size > 1
    const various = albumArtist != null && tracks.some((t) => t.artist !== albumArtist)
    const out: ReactNode[] = []
    let disc = -1
    for (const t of tracks) {
      const v = t.volumeNumber || 1
      if (multi && v !== disc) {
        disc = v
        out.push(
          <div key={`d${v}`} className="src-disc">
            Disc {v}
          </div>,
        )
      }
      out.push(<TidalTrackRow key={t.id} t={t} index={t.trackNumber} showArtist={various} />)
    }
    return (
      <div className="src-tl">
        <TrackListHead />
        {out}
      </div>
    )
  }
  return (
    <div className={cx('src-tl', 'has-album')}>
      <TrackListHead album lead="" />
      {tracks.map((t, i) => (
        <TidalTrackRow key={`${t.id}:${i}`} t={t} index={i + 1} showArt showAlbum showArtist />
      ))}
    </div>
  )
}
