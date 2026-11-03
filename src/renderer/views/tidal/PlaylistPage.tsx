// TIDAL playlist page: tracklist with badges and a "Download playlist" action that queues every
// missing track and mirrors the playlist into the library as a relative .m3u8.

import { useMemo } from 'react'
import { TIDAL_IPC, type TidalPlaylistDetail } from '@shared/ipc/tidal'
import { invoke } from '../../lib/ipc'
import { longDuration, plural } from '../../lib/format'
import { Artwork, IconButton, LibraryBadge, showMenu } from '../../components/ui'
import { CenterSpin, copyLink, DownloadControl, ErrorState, useQueueCount, useQueueState, useRemote } from './source-kit'
import { tidalPlaylistKey, tidalTrackKeys } from './source-helpers'
import { TidalTrackList } from './items'
import { downloadTidalPlaylist, tidalLogin } from './tidal-state'

export function PlaylistPage({ uuid }: { uuid: string }) {
  const r = useRemote(`playlist:${uuid}`, () => invoke<TidalPlaylistDetail>(TIDAL_IPC.playlist, uuid), { refetchOnLibrary: true })
  if (!r.data) {
    if (r.error) return <ErrorState source="tidal" error={r.error} onRetry={r.reload} onLogin={() => void tidalLogin()} />
    return <CenterSpin />
  }
  return <PlaylistBody d={r.data} onDone={r.refresh} />
}

export function PlaylistBody({ d, onDone }: { d: TidalPlaylistDetail; onDone: () => void }) {
  const { playlist: p, tracks } = d
  const keySets = useMemo(() => tracks.map((t) => tidalTrackKeys(t)), [tracks])
  const active = useQueueCount(keySets)
  const pseudo = useQueueState([tidalPlaylistKey(p.uuid)], p.queue)
  const busy = active.queued + active.running
  const queue = active.running ? 'running' : busy || pseudo ? (pseudo ?? 'queued') : null
  const unavailable = tracks.filter((t) => !t.streamable).length
  const totalSec = p.durationSec || tracks.reduce((s, t) => s + t.durationSec, 0)
  const download = async () => {
    const r = await downloadTidalPlaylist(p)
    // The .m3u8 mirror and badges changed: re-read quietly.
    if (r) onDone()
  }
  return (
    <>
      <div className="hero src-hero">
        <Artwork url={p.image} className="hero-art" title={p.title} />
        <div className="hero-meta">
          <span className="hero-kicker">Playlist · TIDAL</span>
          <h1 className="hero-title">{p.title}</h1>
          {p.creator && <span className="hero-sub tidal-plain-sub">{p.creator}</span>}
          {p.description && <span className="src-hero-desc">{p.description}</span>}
          <span className="hero-info">{[plural(p.numberOfTracks || tracks.length, 'song'), totalSec ? longDuration(totalSec * 1000) : null].filter(Boolean).join(' · ')}</span>
          <div className="src-chips">
            {p.badge && <LibraryBadge badge={p.badge} />}
            {busy > 0 && (
              <span className="badge badge-queued">
                {active.running ? 'Downloading' : 'Queued'} · {plural(busy, 'track')}
              </span>
            )}
            {!busy && pseudo && <LibraryBadge badge={p.badge ?? { status: 'missing', have: 0, total: 0 }} queued={pseudo} />}
            {unavailable > 0 && <span className="chip warn">{plural(unavailable, 'track')} unavailable</span>}
          </div>
          <div className="hero-actions">
            {!queue && <DownloadControl big badge={p.badge} queue={null} onDownload={download} label="Download Playlist" />}
            <IconButton icon="more" title="More" onClick={(e) => showMenu(e, [{ label: 'Copy TIDAL Link', icon: 'link', onClick: () => copyLink(p.url) }])} />
          </div>
          <span className="src-note">
            Downloads every track that isn’t already in your library (one job per track) and writes a relative .m3u8 playlist into your library, so the playlist travels with your files.
          </span>
        </div>
      </div>
      <TidalTrackList tracks={tracks} mode="list" />
    </>
  )
}
