// Bandcamp source browser.
//
// Route: { view: 'bandcamp', id? }
//   no id → collection grid (filter / scope / sort persisted in-session; sort in localStorage)
//   id    → purchase detail; id is the purchase key from BandcampItemSummary.key (e.g. "a123456")

import { useEffect } from 'react'
import { Button, Empty } from '../../components/ui'
import { CenterSpin, ErrorState, PauseBanner } from '../tidal/source-kit'
import { bandcampLogin, initBandcampSession, refreshBandcampStatus, useBandcampSession } from './bandcamp-state'
import { Collection } from './Collection'
import { ItemPage } from './ItemPage'
import './bandcamp.css'

export function BandcampView({ id }: { id?: string }) {
  const { status, error, loggingIn, epoch } = useBandcampSession()
  useEffect(() => initBandcampSession(), [])

  if (!status) {
    return (
      <div className="view">
        {error ? (
          <>
            <Head />
            <ErrorState source="bandcamp" error={error} onRetry={() => void refreshBandcampStatus()} />
          </>
        ) : (
          <CenterSpin />
        )}
      </div>
    )
  }

  if (!status.loggedIn)
    return (
      <div className="view bc-view">
        <Head />
        <PauseBanner source="bandcamp" loggedIn={false} onLogin={() => void bandcampLogin()} />
        <Empty icon="disc" title="Log in to Bandcamp">
          <span>See everything you’ve bought on Bandcamp — including hidden purchases — and download releases into your library as FLAC.</span>
          <span className="src-note">Nothing downloads until you choose it: per release, or with “Download all missing” after a confirmation.</span>
          <Button kind="primary" onClick={() => void bandcampLogin()} disabled={loggingIn}>
            {loggingIn ? 'Waiting for Bandcamp login…' : 'Log in to Bandcamp'}
          </Button>
        </Empty>
      </div>
    )

  // Keyed by the login epoch so a page stuck on an auth error reloads after logging in again.
  return <div className="view bc-view">{id ? <ItemPage key={`${epoch}:${id}`} id={id} /> : <Collection key={epoch} status={status} />}</div>
}

function Head() {
  return (
    <div className="view-head">
      <h1 className="view-title">Bandcamp</h1>
    </div>
  )
}
