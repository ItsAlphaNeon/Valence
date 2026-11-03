// Get Rips: the download side of the SiIvaGunner section. Albums (highquality.rip) and SGFR list the
// official Google Drive mirrors with in-library badges; YouTube syncs your playlist into season albums.

import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { HQRIP_IPC, type HqrCatalog, type HqrCollection, type HqrRelease, type HqrSgfrType } from '@shared/ipc/hqrip'
import { invoke, on } from '../../lib/ipc'
import { plural, relativeTime } from '../../lib/format'
import { useUi } from '../../state/ui'
import { Button, Empty, IconButton, Modal, Segmented, Spinner, showMenu } from '../../components/ui'
import { Icon } from '../../components/Icon'
import { CenterSpin, copyLink, DownloadControl, ErrorState, LoadMore, openLink, PauseBanner, SourceTile, useProgressive, useQueueSelect, useQueueState, useRemote } from '../tidal/source-kit'
import { YoutubeTab } from './YoutubeTab'
import { downloadAllMissing, downloadRelease, driveFolderUrl } from './rips-state'
import '../bandcamp/bandcamp.css'

type Tab = 'albums' | 'sgfr' | 'youtube'

export function GetRipsView({ tab = 'albums' }: { tab?: Tab }) {
  return (
    <div className="view">
      <div className="view-head">
        <div>
          <h1 className="view-title">Get Rips</h1>
          <div className="view-sub">Official SiIvaGunner mirrors and your YouTube playlist</div>
        </div>
        <div className="view-actions">
          <Segmented<Tab>
            value={tab}
            onChange={(t) => useUi.getState().navigate({ view: 'hqrip', tab: t }, { replace: true })}
            options={[
              { value: 'albums', label: 'Albums' },
              { value: 'sgfr', label: 'SGFR' },
              { value: 'youtube', label: 'YouTube' },
            ]}
          />
        </div>
      </div>
      {tab === 'youtube' ? <YoutubeTab /> : <Catalog collection={tab === 'sgfr' ? 'SGFR' : 'SiIvaGunner'} />}
    </div>
  )
}

function Catalog({ collection }: { collection: HqrCollection }) {
  const force = useRef(false)
  const r = useRemote(
    'hqrip-catalog',
    () => {
      const refresh = force.current
      force.current = false
      return invoke<HqrCatalog>(HQRIP_IPC.catalog, refresh)
    },
    { refetchOnLibrary: true },
  )
  // Folder details (track counts, covers) arrive in the background.
  useEffect(() => on(HQRIP_IPC.catalogUpdated, () => r.refresh()), [r])
  const reload = () => {
    force.current = true
    r.reload()
  }
  const releases = useMemo(() => r.data?.releases.filter((x) => x.collection === collection), [r.data, collection])
  return (
    <>
      <PauseBanner source="hqrip" loggedIn />
      {!releases ? (
        r.error ? (
          <ErrorState source="hqrip" error={r.error} onRetry={reload} />
        ) : (
          <CenterSpin label="Reading the rip album index…" />
        )
      ) : (
        <CatalogGrid collection={collection} releases={releases} fetchedAt={r.data?.fetchedAt} error={r.data?.error} loading={r.loading} onRefresh={reload} />
      )}
    </>
  )
}

type Scope = 'all' | 'missing' | 'in-library'
type SgfrFilter = 'all' | HqrSgfrType

function CatalogGrid({ collection, releases, fetchedAt, error, loading, onRefresh }: { collection: HqrCollection; releases: HqrRelease[]; fetchedAt?: number; error?: string; loading: boolean; onRefresh: () => void }) {
  const [text, setText] = useState('')
  const [scope, setScope] = useState<Scope>('all')
  const [kind, setKind] = useState<SgfrFilter>('all')
  const [confirm, setConfirm] = useState(false)
  const shown = useMemo(() => {
    const t = text.trim().toLowerCase()
    return releases.filter(
      (x) =>
        (!t || x.title.toLowerCase().includes(t) || x.catalogNumber?.toLowerCase().includes(t)) &&
        (scope === 'all' || (scope === 'in-library' ? x.badge.status !== 'missing' : x.badge.status !== 'in-library')) &&
        (kind === 'all' || x.sgfrType === kind),
    )
  }, [releases, text, scope, kind])
  const p = useProgressive(shown, 120, `${text}|${scope}|${kind}|${collection}`)
  const inLib = releases.filter((x) => x.badge.status === 'in-library').length
  const missing = useQueueSelect((active) => releases.filter((x) => x.format && x.badge.status !== 'in-library' && !active(x.id)).length)
  return (
    <>
      <div className="bc-toolbar">
        <label className="search-box glass bc-filter">
          <Icon name="search" size={15} />
          <input type="search" value={text} placeholder="Filter albums" aria-label="Filter rip albums" onChange={(e) => setText(e.target.value)} />
        </label>
        <Segmented<Scope>
          value={scope}
          onChange={setScope}
          options={[
            { value: 'all', label: 'All' },
            { value: 'missing', label: 'Missing' },
            { value: 'in-library', label: 'In Library' },
          ]}
        />
        {collection === 'SGFR' && (
          <Segmented<SgfrFilter>
            value={kind}
            onChange={setKind}
            options={[
              { value: 'all', label: 'All' },
              { value: 'Album', label: 'Albums' },
              { value: 'Single', label: 'Singles' },
              { value: 'Soundtrack', label: 'Compilations' },
            ]}
          />
        )}
        <span className="faint bc-count">
          {plural(releases.length, collection === 'SGFR' ? 'release' : 'album')}
          {inLib ? ` · ${inLib} in library` : ''}
          {fetchedAt ? ` · updated ${relativeTime(fetchedAt)}` : ''}
        </span>
        <span className="row" style={{ marginLeft: 'auto' }}>
          {loading ? <Spinner size={16} /> : <IconButton icon="refresh" title="Refresh the album index" onClick={onRefresh} />}
          <Button kind="primary" icon="download" disabled={!missing} onClick={() => setConfirm(true)}>
            Download All Missing{missing ? ` (${missing})` : ''}
          </Button>
        </span>
      </div>
      {error && <p className="set-callout warn">Couldn’t refresh the index ({error}); showing the last copy.</p>}
      {!shown.length ? (
        <Empty icon="search" title="Nothing matches">
          <Button small onClick={() => (setText(''), setScope('all'), setKind('all'))}>
            Clear Filters
          </Button>
        </Empty>
      ) : (
        <>
          <div className="src-grid">
            {p.visible.map((x) => (
              <ReleaseTile key={x.id} r={x} />
            ))}
          </div>
          <LoadMore hasMore={p.more} loading={false} onMore={p.showMore} shown={p.visible.length} total={shown.length} noun={collection === 'SGFR' ? 'releases' : 'albums'} />
        </>
      )}
      {confirm && <ConfirmAll collection={collection} releases={releases} count={missing} onClose={() => setConfirm(false)} />}
    </>
  )
}

function ConfirmAll({ collection, releases, count, onClose }: { collection: HqrCollection; releases: HqrRelease[]; count: number; onClose: () => void }) {
  const [busy, setBusy] = useState(false)
  return (
    <Modal
      title={`Download every missing ${collection === 'SGFR' ? 'SGFR release' : 'rip album'}?`}
      width={480}
      onClose={onClose}
      footer={
        <>
          <Button kind="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            kind="primary"
            icon="download"
            disabled={busy}
            onClick={async () => {
              setBusy(true)
              const r = await downloadAllMissing(collection, releases)
              setBusy(false)
              if (r) onClose()
            }}
          >
            Download {plural(count, 'Album')}
          </Button>
        </>
      }
    >
      <div className="stack bc-confirm">
        <p>
          Valence will queue <b>{plural(count, 'album')}</b> from Google Drive, one at a time. The FLAC versions are large (a Highest Quality Rips volume is
          over 10 GB): MP3 320 copies go to your library and the FLAC masters to your lossless archive.
        </p>
        <p className="faint">If Drive limits downloads, Valence waits and retries; follow progress in Import.</p>
      </div>
    </Modal>
  )
}

function releaseMenu(e: React.MouseEvent, r: HqrRelease): void {
  const folder = r.format ? r.folders[r.format] : undefined
  showMenu(e, [
    { label: r.badge.status === 'in-library' ? 'Download Again' : 'Download', icon: 'download', disabled: !r.format, onClick: () => void downloadRelease(r) },
    { separator: true },
    { label: 'Open Google Drive Folder', icon: 'link', disabled: !folder, onClick: () => folder && openLink(driveFolderUrl(folder)) },
    ...(r.bandcampUrl ? [{ label: 'Open on Bandcamp', icon: 'link' as const, onClick: () => openLink(r.bandcampUrl) }] : []),
    { label: 'Copy Drive Link', icon: 'link', disabled: !folder, onClick: () => folder && copyLink(driveFolderUrl(folder)) },
  ])
}

const FORMAT_LABEL = { flac: 'FLAC', ogg: 'OGG', mp3: 'MP3' } as const

/** "SiIvaGunner's Highest Quality Rips: Volume 🔥" → title "Volume 🔥", series under it (they'd all truncate alike). */
export function tileTitle(title: string): { title: string; series: string | null } {
  const i = title.indexOf(': ')
  return i > 0 && /highest quality rips/i.test(title.slice(0, i)) ? { title: title.slice(i + 2), series: title.slice(0, i) } : { title, series: null }
}

const ReleaseTile = memo(function ReleaseTile({ r }: { r: HqrRelease }) {
  const queue = useQueueState([r.id], r.queue)
  const name = tileTitle(r.title)
  const sub = [
    name.series,
    r.catalogNumber,
    r.sgfrType && r.sgfrType !== 'Album' ? (r.sgfrType === 'Soundtrack' ? 'Compilation' : r.sgfrType) : null,
    r.trackCount ? plural(r.trackCount, 'track') : null,
    r.format ? FORMAT_LABEL[r.format] : null,
  ]
    .filter(Boolean)
    .join(' · ')
  return (
    <SourceTile
      art={r.cover}
      title={name.title}
      sub={<span title={r.title}>{sub}</span>}
      onContextMenu={(e) => releaseMenu(e, r)}
      footer={r.format ? <DownloadControl badge={r.badge} queue={queue} onDownload={() => downloadRelease(r)} label="Download Album" /> : <span className="chip">No download</span>}
    />
  )
})
