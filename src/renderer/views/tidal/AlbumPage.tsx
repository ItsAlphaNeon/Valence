// TIDAL album page: hero with quality chip and in-library badge, tracklist with per-track downloads.

import { TIDAL_IPC, type TidalAlbumDetail } from '@shared/ipc/tidal'
import { invoke } from '../../lib/ipc'
import { longDuration, plural } from '../../lib/format'
import { Artwork, IconButton, LibraryBadge, showMenu } from '../../components/ui'
import { CenterSpin, copyLink, openLink, DownloadControl, ErrorState, Explicit, JobProgress, useQueueJob, useQueueState, useRemote } from './source-kit'
import { tidalAlbumKeys, tidalQualityChip, tidalReleaseType } from './source-helpers'
import { ArtistLinks, openArtist, TidalTrackList } from './items'
import { downloadAlbum, tidalLogin } from './tidal-state'

export function AlbumPage({ id }: { id: string }) {
  const r = useRemote(`album:${id}`, () => invoke<TidalAlbumDetail>(TIDAL_IPC.album, id), { refetchOnLibrary: true })
  if (!r.data) {
    if (r.error) return <ErrorState source="tidal" error={r.error} onRetry={r.reload} onLogin={() => void tidalLogin()} />
    return <CenterSpin />
  }
  return <AlbumBody d={r.data} />
}

export function AlbumBody({ d }: { d: TidalAlbumDetail }) {
  const { album: a, tracks } = d
  const keys = tidalAlbumKeys(a)
  const queue = useQueueState(keys, a.queue)
  const job = useQueueJob(keys)
  const chip = tidalQualityChip(a.quality, a.mediaTags)
  const type = tidalReleaseType(a.type, a.numberOfTracks)
  const missing = a.badge.status === 'partial' ? a.badge.total - a.badge.have : 0
  const unavailable = tracks.filter((t) => !t.streamable).length
  const totalSec = a.durationSec || tracks.reduce((s, t) => s + t.durationSec, 0)
  const info = [a.year, plural(a.numberOfTracks || tracks.length, 'song'), totalSec ? longDuration(totalSec * 1000) : null, a.numberOfVolumes > 1 ? `${a.numberOfVolumes} discs` : null]
  return (
    <>
      <div className="hero src-hero">
        <Artwork url={a.cover} className="hero-art" title={a.title} />
        <div className="hero-meta">
          <span className="hero-kicker">{type} · TIDAL</span>
          <h1 className="hero-title">
            {a.title}
            {a.explicit && <Explicit />}
          </h1>
          <span className="hero-sub">
            <ArtistLinks artists={a.artists} fallback={a.artist} />
          </span>
          <span className="hero-info">{info.filter(Boolean).join(' · ')}</span>
          <div className="src-chips">
            {chip && (
              <span className={`chip ${chip.kind}`} title={chip.title}>
                {chip.label}
              </span>
            )}
            <LibraryBadge badge={a.badge} queued={queue} />
            {unavailable > 0 && <span className="chip warn">{plural(unavailable, 'track')} unavailable</span>}
          </div>
          <div className="hero-actions">
            {!queue && <DownloadControl big badge={a.badge} queue={null} onDownload={() => downloadAlbum(a)} label={a.badge.status === 'in-library' ? 'Download' : 'Download Album'} />}
            {!queue && missing > 0 && <DownloadControl big kind="default" badge={null} queue={null} onDownload={() => downloadAlbum(a, true)} label={`Download ${missing} Missing`} />}
            <IconButton
              icon="more"
              title="More"
              onClick={(e) =>
                showMenu(e, [
                  ...(a.artists[0] ? [{ label: 'Go to Artist', icon: 'artists' as const, onClick: () => openArtist(a.artists[0].id) }] : []),
                  { label: 'Open on TIDAL', icon: 'link', onClick: () => openLink(a.url) }, { label: 'Copy TIDAL Link', icon: 'link', onClick: () => copyLink(a.url) },
                ])
              }
            />
          </div>
          <JobProgress job={queue ? job : null} />
        </div>
      </div>
      <TidalTrackList tracks={tracks} mode="album" albumArtist={a.artist} />
      <div className="src-note tidal-foot">
        {a.releaseDate && <div>Released {new Date(`${a.releaseDate}T00:00:00`).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })}</div>}
        <div>Downloads as LOSSLESS 16-bit/44.1 kHz FLAC, transcoded to your library format with the FLAC master archived.</div>
      </div>
    </>
  )
}
