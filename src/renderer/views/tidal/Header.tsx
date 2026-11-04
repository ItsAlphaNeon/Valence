// TIDAL view header: catalog search, "paste a link" field and account menu.

import { useEffect, useState } from 'react'
import { TIDAL_IPC, type TidalLink, type TidalStatus, type TidalTrackSummary } from '@shared/ipc/tidal'
import { invoke } from '../../lib/ipc'
import { cx } from '../../lib/format'
import { navigate, toast } from '../../state/ui'
import { Artwork, Button, IconButton, Modal, Spinner, showMenu } from '../../components/ui'
import { duration } from '../../lib/format'
import { Icon } from '../../components/Icon'
import { looksLikeTidalLink, routeForLink } from './source-helpers'
import { downloadTrackById, tidalError, tidalLogout } from './tidal-state'

export function SearchField({ initial }: { initial: string }) {
  const [q, setQ] = useState(initial)
  useEffect(() => setQ(initial), [initial])
  const [track, setTrack] = useState<string | null>(null)
  return (
    <>
      <form
        className="search-box tidal-search"
        onSubmit={(e) => {
          e.preventDefault()
          const s = q.trim()
          if (!s) return
          // A link typed into search opens it directly.
          if (looksLikeTidalLink(s))
            void resolve(s).then((r) => {
              if (r && typeof r === 'object') setTrack(r.id)
            })
          else navigate({ view: 'tidal', tab: 'search', id: s })
        }}
      >
        <Icon name="search" size={15} />
        <input type="search" value={q} placeholder="Search TIDAL" aria-label="Search TIDAL" onChange={(e) => setQ(e.target.value)} />
      </form>
      {track && <TrackLinkModal id={track} onClose={() => setTrack(null)} />}
    </>
  )
}

export function LinkField() {
  const [v, setV] = useState('')
  const [busy, setBusy] = useState(false)
  const [track, setTrack] = useState<string | null>(null)
  const open = async () => {
    const s = v.trim()
    if (!s || busy) return
    setBusy(true)
    const r = await resolve(s)
    setBusy(false)
    if (r === 'ok') setV('')
    else if (r && typeof r === 'object') {
      setTrack(r.id)
      setV('')
    }
  }
  return (
    <>
      <form
        className={cx('search-box tidal-link', busy && 'busy')}
        onSubmit={(e) => {
          e.preventDefault()
          void open()
        }}
      >
        <Icon name="link" size={15} />
        <input value={v} placeholder="Paste a TIDAL link" aria-label="TIDAL link" onChange={(e) => setV(e.target.value)} />
        {busy ? (
          <Spinner size={12} />
        ) : (
          v.trim() && (
            <button type="submit" className="tidal-link-go" title="Open link">
              <Icon name="chevronRight" size={14} />
            </button>
          )
        )}
      </form>
      {track && <TrackLinkModal id={track} onClose={() => setTrack(null)} />}
    </>
  )
}

/** Resolves a link and navigates; returns the link itself for tracks (which have no page). */
async function resolve(url: string): Promise<'ok' | TidalLink | null> {
  try {
    const link = await invoke<TidalLink | null>(TIDAL_IPC.resolveLink, url)
    if (!link) {
      toast('That doesn’t look like a TIDAL album, track, playlist or artist link', 'error')
      return null
    }
    const r = routeForLink(link)
    if (r) {
      navigate({ view: 'tidal', ...r })
      return 'ok'
    }
    if (link.kind === 'track') return link
    toast(`TIDAL ${link.kind === 'mix' ? 'mixes' : 'videos'} can’t be downloaded — open an album, track or playlist instead`)
    return null
  } catch (e) {
    tidalError(e)
    return null
  }
}

function TrackLinkModal({ id, onClose }: { id: string; onClose: () => void }) {
  const [busy, setBusy] = useState(false)
  // undefined = loading, null = lookup failed (the download can still be queued by id).
  const [t, setT] = useState<TidalTrackSummary | null | undefined>(undefined)
  useEffect(() => {
    let live = true
    invoke<TidalTrackSummary>(TIDAL_IPC.track, id).then(
      (r) => live && setT(r),
      () => live && setT(null),
    )
    return () => {
      live = false
    }
  }, [id])
  return (
    <Modal
      title="Download this track?"
      width={440}
      onClose={onClose}
      footer={
        <>
          <Button kind="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            kind="primary"
            icon="download"
            disabled={busy || t?.streamable === false}
            onClick={async () => {
              setBusy(true)
              const ok = await downloadTrackById(id)
              setBusy(false)
              if (ok) onClose()
            }}
          >
            {t?.inLibrary ? 'Download Again' : 'Download Track'}
          </Button>
        </>
      }
    >
      {t === undefined ? (
        <div className="row" style={{ minHeight: 64 }}>
          <Spinner />
        </div>
      ) : t ? (
        <div className="row" style={{ gap: 14, marginBottom: 12 }}>
          <Artwork url={t.album?.cover} size={64} title={t.album?.title ?? t.title} />
          <div className="stack grow" style={{ gap: 2, minWidth: 0 }}>
            <b className="ellipsis">{t.title}</b>
            <span className="muted ellipsis">{t.artist}</span>
            <span className="faint ellipsis">
              {[t.album?.title, t.durationSec ? duration(t.durationSec * 1000) : null].filter(Boolean).join(' · ')}
            </span>
          </div>
          {t.inLibrary ? <span className="chip ok">In library</span> : !t.streamable ? <span className="chip warn">Unavailable</span> : null}
        </div>
      ) : null}
      <p className="src-note" style={{ margin: 0 }}>
        {t?.streamable === false
          ? 'TIDAL doesn’t offer this track for streaming in your country, so it can’t be downloaded.'
          : 'Valence queues it as a LOSSLESS 16-bit/44.1 kHz FLAC download, transcoded to your library format with the master archived.'}
        {t === null && (
          <>
            {' '}
            (Track id <span className="mono">{id}</span>; its details couldn’t be loaded.)
          </>
        )}
      </p>
    </Modal>
  )
}

export function AccountButton({ status }: { status: TidalStatus }) {
  return (
    <IconButton
      icon="user"
      title="TIDAL account"
      onClick={(e) =>
        showMenu(e, [
          { label: status.countryCode ? `Logged in · ${status.countryCode}` : 'Logged in', disabled: true },
          { separator: true },
          { label: 'Log Out of TIDAL', icon: 'close', danger: true, onClick: () => void tidalLogout() },
        ])
      }
    />
  )
}
