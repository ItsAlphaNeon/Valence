// Bandcamp collection: purchases grid with filter, scope, sort, counts and "Download all missing".

import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { BANDCAMP_CHANNELS as CH, type BandcampCollection, type BandcampItemSummary, type BandcampStatus } from '@shared/ipc/bandcamp'
import { invoke } from '../../lib/ipc'
import { plural, relativeTime } from '../../lib/format'
import { navigate } from '../../state/ui'
import { Button, Empty, IconButton, Modal, Segmented, Spinner, showMenu } from '../../components/ui'
import { Icon } from '../../components/Icon'
import { CenterSpin, copyLink, openLink, DownloadControl, ErrorState, LoadMore, PauseBanner, SourceTile, isKeyActive, useProgressive, useQueueSelect, useQueueState, useRemote } from '../tidal/source-kit'
import { bandcampLogin, bandcampLogout, downloadAllMissing, downloadPurchase, isAuthError, refreshBandcampStatus, useBandcampSession, useCollectionPrefs } from './bandcamp-state'
import { collectionCounts, filterItems, missingToDownload, purchasedLabel, releaseKeyOf, sortItems, unavailableReason, type BcScope, type BcSort } from './helpers'

export const openItem = (key: string) => navigate({ view: 'bandcamp', id: key })

export function Collection({ status }: { status: BandcampStatus }) {
  const version = useBandcampSession((s) => s.collectionVersion)
  const force = useRef(false)
  const r = useRemote(
    'collection',
    () => {
      const refresh = force.current
      force.current = false
      return invoke<BandcampCollection>(CH.collection, refresh ? { refresh: true } : {})
    },
    { refetchOnLibrary: true },
  )
  // collection-updated broadcast (login, new purchases, a download enqueued): re-read quietly.
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

  const items = r.data?.items
  const reload = () => {
    force.current = true
    r.reload()
  }
  return (
    <>
      <CollectionHeader status={status} items={items} fetchedAt={r.data?.fetchedAt} loading={r.loading} onRefresh={reload} />
      <PauseBanner source="bandcamp" loggedIn onLogin={() => void bandcampLogin()} />
      {!items ? (
        r.error ? (
          <ErrorState source="bandcamp" error={r.error} onRetry={reload} onLogin={() => void bandcampLogin()} />
        ) : (
          <CenterSpin label="Loading your Bandcamp collection…" />
        )
      ) : (
        <CollectionGrid items={items} />
      )}
    </>
  )
}

export function CollectionHeader({ status, items, fetchedAt, loading, onRefresh }: { status: BandcampStatus; items?: BandcampItemSummary[]; fetchedAt?: number; loading: boolean; onRefresh: () => void }) {
  const counts = useMemo(() => (items ? collectionCounts(items) : null), [items])
  const missingCount = useQueueSelect((active) => (items ? missingToDownload(items, active).length : 0))
  const [confirm, setConfirm] = useState<BandcampItemSummary[] | null>(null)
  const sub = counts
    ? [
        plural(counts.total, 'purchase'),
        counts.inLibrary ? `${counts.inLibrary.toLocaleString()} in library` : null,
        counts.partial ? `${counts.partial.toLocaleString()} partial` : null,
        counts.unavailable ? `${counts.unavailable.toLocaleString()} not downloadable` : null,
        counts.hidden ? `${counts.hidden.toLocaleString()} hidden` : null,
      ]
        .filter(Boolean)
        .join(' · ')
    : 'Your purchases'
  return (
    <div className="view-head">
      <div>
        <h1 className="view-title">Bandcamp</h1>
        <div className="view-sub">
          {sub}
          {fetchedAt ? <span className="faint"> · updated {relativeTime(fetchedAt)}</span> : null}
        </div>
      </div>
      <div className="view-actions">
        {loading && items ? <Spinner size={16} /> : <IconButton icon="refresh" title="Refresh collection from Bandcamp" onClick={onRefresh} disabled={loading} />}
        <Button kind="primary" icon="download" disabled={!items || missingCount === 0} onClick={() => items && setConfirm(missingToDownload(items, isKeyActive))} title={missingCount ? undefined : 'Every downloadable purchase is in your library or queued'}>
          Download All Missing{missingCount ? ` (${missingCount.toLocaleString()})` : ''}
        </Button>
        <IconButton
          icon="user"
          title="Bandcamp account"
          onClick={(e) =>
            showMenu(e, [
              { label: status.username ? `Logged in as ${status.username}` : 'Logged in', disabled: true },
              { separator: true },
              { label: 'Log Out of Bandcamp', icon: 'close', danger: true, onClick: () => void bandcampLogout() },
            ])
          }
        />
      </div>
      {confirm && <ConfirmAll items={confirm} onClose={() => setConfirm(null)} />}
    </div>
  )
}

function ConfirmAll({ items, onClose }: { items: BandcampItemSummary[]; onClose: () => void }) {
  const [busy, setBusy] = useState(false)
  const partial = items.filter((i) => i.badge.status === 'partial').length
  const n = items.length
  return (
    <Modal
      title="Download all missing purchases?"
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
              const r = await downloadAllMissing(items)
              setBusy(false)
              if (r != null) onClose()
            }}
          >
            Download {plural(n, 'Purchase')}
          </Button>
        </>
      }
    >
      <div className="stack bc-confirm">
        <p>
          Valence will queue <b>{plural(n, 'purchase')}</b> that {n === 1 ? 'isn’t' : 'aren’t'} fully in your library
          {partial ? ` (${partial} partially there)` : ''}. Bandcamp prepares the FLAC files on demand, so a large batch takes a while — follow it in Import.
        </p>
        <p className="faint">Pre-orders, physical-only items and releases that are already queued are skipped.</p>
        {n > 0 && (
          <div className="bc-confirm-list">
            {items.slice(0, 6).map((i) => (
              <div key={i.key} className="ellipsis">
                {i.artist} — {i.title}
              </div>
            ))}
            {n > 6 && <div className="faint">and {plural(n - 6, 'more')}</div>}
          </div>
        )}
      </div>
    </Modal>
  )
}

const SORTS: Array<{ value: BcSort; label: string }> = [
  { value: 'purchased', label: 'Purchase Date' },
  { value: 'artist', label: 'Artist' },
  { value: 'title', label: 'Title' },
]

export function CollectionGrid({ items }: { items: BandcampItemSummary[] }) {
  const { text, scope, sort, showHidden, set } = useCollectionPrefs()
  const shown = useMemo(() => sortItems(filterItems(items, { text, scope, showHidden }), sort), [items, text, scope, sort, showHidden])
  const p = useProgressive(shown, 120, `${text}|${scope}|${sort}|${showHidden}`)
  const filtered = shown.length !== items.length
  return (
    <>
      <div className="bc-toolbar">
        <label className="search-box bc-filter">
          <Icon name="search" size={15} />
          <input type="search" value={text} placeholder="Filter by title or artist" aria-label="Filter purchases" onChange={(e) => set({ text: e.target.value })} />
          {text && (
            <button className="bc-clear" title="Clear filter" onClick={() => set({ text: '' })}>
              <Icon name="close" size={12} />
            </button>
          )}
        </label>
        <Segmented<BcScope>
          value={scope}
          onChange={(v) => set({ scope: v })}
          options={[
            { value: 'all', label: 'All' },
            { value: 'missing', label: 'Missing' },
            { value: 'in-library', label: 'In Library' },
          ]}
        />
        <label className="bc-sort">
          <span className="faint">Sort</span>
          <select value={sort} onChange={(e) => set({ sort: e.target.value as BcSort })} aria-label="Sort purchases">
            {SORTS.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
        <label className="bc-hidden">
          <input type="checkbox" className="toggle" checked={showHidden} onChange={(e) => set({ showHidden: e.target.checked })} />
          <span>Show hidden</span>
        </label>
        {filtered && <span className="faint bc-count">{`${shown.length.toLocaleString()} of ${items.length.toLocaleString()}`}</span>}
      </div>
      {!items.length ? (
        <Empty icon="disc" title="No purchases yet">
          Albums and tracks you buy on Bandcamp show up here.
        </Empty>
      ) : !shown.length ? (
        <Empty icon="search" title="Nothing matches">
          <span>Try another filter{!showHidden ? ' or show hidden purchases' : ''}.</span>
          <Button small onClick={() => set({ text: '', scope: 'all', showHidden: true })}>
            Clear Filters
          </Button>
        </Empty>
      ) : (
        <>
          <div className="src-grid">
            {p.visible.map((i) => (
              <PurchaseTile key={i.key} i={i} />
            ))}
          </div>
          <LoadMore hasMore={p.more} loading={false} onMore={p.showMore} shown={p.visible.length} total={shown.length} noun="purchases" />
        </>
      )}
    </>
  )
}

export function purchaseMenu(e: React.MouseEvent, i: BandcampItemSummary): void {
  const why = unavailableReason(i)
  showMenu(e, [
    { label: 'Open', icon: 'albums', onClick: () => openItem(i.key) },
    { label: i.badge.status === 'in-library' ? 'Download Again' : 'Download', icon: 'download', disabled: !!why, onClick: () => void downloadPurchase(i) },
    { separator: true },
    { label: `More by ${i.artist}`, icon: 'artists', onClick: () => useCollectionPrefs.getState().set({ text: i.artist, scope: 'all' }) },
    { label: 'Open on Bandcamp', icon: 'link', disabled: !i.itemUrl, onClick: () => openLink(i.itemUrl) }, { label: 'Copy Bandcamp Link', icon: 'link', disabled: !i.itemUrl, onClick: () => copyLink(i.itemUrl) },
  ])
}

export function PurchaseStatus({ i }: { i: BandcampItemSummary }) {
  const queue = useQueueState([releaseKeyOf(i)], i.queue)
  const why = unavailableReason(i)
  if (why && !queue)
    return (
      <span className="src-dl">
        <span className={i.preorder ? 'chip accent' : 'chip'} title={why.detail}>
          {why.label}
        </span>
      </span>
    )
  return <DownloadControl badge={i.badge} queue={queue} onDownload={() => downloadPurchase(i)} />
}

const PurchaseTile = memo(function PurchaseTile({ i }: { i: BandcampItemSummary }) {
  const date = purchasedLabel(i.purchased)
  return (
    <SourceTile
      art={i.artUrl}
      title={i.title}
      sub={
        <>
          {i.artist}
          {i.hidden && (
            <span className="bc-hidden-mark" title="Hidden in your Bandcamp collection">
              {' '}
              · Hidden
            </span>
          )}
        </>
      }
      onOpen={() => openItem(i.key)}
      onContextMenu={(e) => purchaseMenu(e, i)}
      footer={
        <span className="bc-tile-foot" title={date ? `Purchased ${date}` : undefined}>
          <PurchaseStatus i={i} />
        </span>
      }
    />
  )
})

