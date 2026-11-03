// Bandcamp purchase detail: hero + tracklist with per-track in-library state + Download.

import { useEffect, useRef } from 'react'
import { BANDCAMP_CHANNELS as CH, type BandcampItemDetail } from '@shared/ipc/bandcamp'
import { invoke } from '../../lib/ipc'
import { longDuration, plural } from '../../lib/format'
import { navigate } from '../../state/ui'
import { Artwork, IconButton, LibraryBadge, showMenu } from '../../components/ui'
import { CenterSpin, copyLink, openLink, DownloadControl, ErrorState, JobProgress, TrackListHead, TrackRow, trackBadge, useQueueJob, useQueueState, useRemote } from '../tidal/source-kit'
import { bandcampLogin, downloadPurchase, isAuthError, refreshBandcampStatus, useBandcampSession, useCollectionPrefs } from './bandcamp-state'
import { bcArtAt, purchasedLabel, releaseKeyOf, unavailableReason } from './helpers'

const KIND: Record<BandcampItemDetail['itemType'], string> = { album: 'Album', track: 'Track', package: 'Package' }

export function ItemPage({ id }: { id: string }) {
  const version = useBandcampSession((s) => s.collectionVersion)
  const r = useRemote(`item:${id}`, () => invoke<BandcampItemDetail>(CH.item, id), { refetchOnLibrary: true })
  const seenVersion = useRef(version)
  useEffect(() => {
    if (version === seenVersion.current) return
    seenVersion.current = version
    r.refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version])
  useEffect(() => {
    if (r.error && isAuthError(r.error)) void refreshBandcampStatus()
  }, [r.error])
  if (!r.data) {
    if (r.error) return <ErrorState source="bandcamp" error={r.error} onRetry={r.reload} onLogin={() => void bandcampLogin()} />
    return <CenterSpin />
  }
  return <ItemBody i={r.data} />
}

export function ItemBody({ i }: { i: BandcampItemDetail }) {
  const keys = [releaseKeyOf(i)]
  const queue = useQueueState(keys, i.queue)
  const job = useQueueJob(keys)
  const why = unavailableReason(i)
  const totalMs = i.tracks.reduce((s, t) => s + (t.durationMs || 0), 0)
  const released = i.releaseDate ? new Date(`${i.releaseDate}T00:00:00`).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' }) : null
  const bought = purchasedLabel(i.purchased)
  const tracks = i.trackCount ?? i.tracks.length
  const various = i.tracks.some((t) => t.artist && t.artist !== i.artist)
  const showArtist = () => {
    useCollectionPrefs.getState().set({ text: i.artist, scope: 'all' })
    navigate({ view: 'bandcamp' })
  }
  return (
    <>
      <div className="hero src-hero">
        <Artwork url={bcArtAt(i.artUrl, 16) ?? i.artUrl} className="hero-art" title={i.title} />
        <div className="hero-meta">
          <span className="hero-kicker">
            {KIND[i.itemType]}
            {i.itemType === 'package' && i.tralbumType === 'album' ? ' (with album)' : ''} · Bandcamp
          </span>
          <h1 className="hero-title">{i.title}</h1>
          <span className="hero-sub">
            <a className="link-muted" onClick={showArtist} title={`Show ${i.artist} in your collection`}>
              {i.artist}
            </a>
          </span>
          <span className="hero-info">{[released, i.label, tracks ? plural(tracks, 'song') : null, totalMs ? longDuration(totalMs) : null].filter(Boolean).join(' · ')}</span>
          {bought && <span className="hero-info faint">Purchased {bought}</span>}
          <div className="src-chips">
            <LibraryBadge badge={i.badge} queued={queue} />
            {why && (
              <span className={i.preorder ? 'chip accent' : 'chip'} title={why.detail}>
                {why.label}
              </span>
            )}
            {i.hidden && (
              <span className="chip" title="Hidden in your Bandcamp collection">
                Hidden
              </span>
            )}
            {i.tags?.slice(0, 6).map((t) => (
              <span key={t} className="chip bc-tag">
                {t}
              </span>
            ))}
          </div>
          <div className="hero-actions">
            {!why && !queue && <DownloadControl big badge={i.badge} queue={null} onDownload={() => downloadPurchase(i)} label="Download" />}
            <IconButton
              icon="more"
              title="More"
              onClick={(e) =>
                showMenu(e, [
                  { label: `More by ${i.artist}`, icon: 'artists', onClick: showArtist },
                  { label: 'Open on Bandcamp', icon: 'link', disabled: !i.itemUrl, onClick: () => openLink(i.itemUrl) }, { label: 'Copy Bandcamp Link', icon: 'link', disabled: !i.itemUrl, onClick: () => copyLink(i.itemUrl) },
                ])
              }
            />
          </div>
          {why && <span className="src-note">{why.detail}</span>}
          {!why && !queue && <span className="src-note">Downloads the FLAC release from Bandcamp and imports it into your library.</span>}
          <JobProgress job={queue ? job : null} />
        </div>
      </div>
      {i.tracks.length ? (
        <div className="src-tl">
          <TrackListHead />
          {i.tracks.map((t) => (
            <TrackRow
              key={`${t.trackId}:${t.trackNum}`}
              lead={t.trackNum || ''}
              title={t.title}
              sub={various ? t.artist : undefined}
              durationSec={t.durationMs ? t.durationMs / 1000 : undefined}
              right={<LibraryBadge badge={trackBadge(t.inLibrary)} compact />}
            />
          ))}
        </div>
      ) : (
        <div className="src-note">Bandcamp didn’t list the tracks for this purchase.</div>
      )}
    </>
  )
}
