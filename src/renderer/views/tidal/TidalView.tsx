// TIDAL source browser.
//
// Route: { view: 'tidal', tab?, id? }
//   tab: 'albums' (default) | 'tracks' | 'playlists' | 'artists'  → favorites, paged
//        'search'   id = query
//        'album'    id = TIDAL album id
//        'artist'   id = TIDAL artist id
//        'playlist' id = playlist uuid
// Track links (pasted) have no page: they open a "Download this track?" confirm.

import { useEffect } from 'react'
import type { TidalFavoriteKind } from '@shared/ipc/tidal'
import { navigate } from '../../state/ui'
import { Button, Empty, Segmented } from '../../components/ui'
import { Icon } from '../../components/Icon'
import { CenterSpin, ErrorState, PauseBanner } from './source-kit'
import { parseTidalRoute, type TidalRoute } from './source-helpers'
import { initTidalSession, refreshTidalStatus, tidalLogin, useTidalSession } from './tidal-state'
import { AccountButton, LinkField, SearchField } from './Header'
import { Favorites } from './Favorites'
import { Search } from './Search'
import { AlbumPage } from './AlbumPage'
import { ArtistPage } from './ArtistPage'
import { PlaylistPage } from './PlaylistPage'
import './tidal.css'

const LOSSLESS_NOTE = 'Downloads are LOSSLESS 16-bit/44.1 kHz FLAC, transcoded to your library format with the FLAC master archived.'

type TabValue = TidalFavoriteKind | 'search'

export function TidalView({ tab, id }: { tab?: string; id?: string }) {
  const { status, error, loggingIn, epoch } = useTidalSession()
  useEffect(() => initTidalSession(), [])
  const route = parseTidalRoute(tab, id)

  if (!status) {
    if (error)
      return (
        <div className="view">
          <Head />
          <ErrorState source="tidal" error={error} onRetry={() => void refreshTidalStatus()} />
        </div>
      )
    return (
      <div className="view">
        <CenterSpin />
      </div>
    )
  }

  if (!status.loggedIn)
    return (
      <div className="view tidal-view">
        <Head />
        <PauseBanner source="tidal" loggedIn={false} onLogin={() => void tidalLogin()} />
        <Empty icon="wave" title="Log in to TIDAL">
          <span>Browse your TIDAL favorites, search the catalog and download albums, tracks and playlists into your library — one release at a time, only when you click Download.</span>
          <span className="src-note">{LOSSLESS_NOTE}</span>
          <Button kind="primary" onClick={() => void tidalLogin()} disabled={loggingIn}>
            {loggingIn ? 'Waiting for TIDAL login…' : 'Log in to TIDAL'}
          </Button>
        </Empty>
      </div>
    )

  const detail = route.page === 'album' || route.page === 'artist' || route.page === 'playlist'
  return (
    <div className={detail ? 'view tidal-view tidal-detail' : 'view tidal-view'}>
      {detail ? (
        <div className="tidal-bar">
          <Button kind="ghost" small icon="wave" onClick={() => navigate({ view: 'tidal' })} className="tidal-home">
            TIDAL
          </Button>
          <div className="view-actions">
            <SearchField initial="" />
            <LinkField />
            <AccountButton status={status} />
          </div>
        </div>
      ) : (
        <Head
          sub={route.page === 'search' ? (route.query ? `Results for “${route.query}”` : 'Search the TIDAL catalog') : 'Your TIDAL favorites'}
          actions={
            <>
              <SearchField initial={route.page === 'search' ? route.query : ''} />
              <LinkField />
              <AccountButton status={status} />
            </>
          }
        />
      )}
      <PauseBanner source="tidal" loggedIn onLogin={() => void tidalLogin()} />
      {!detail && <Tabs route={route} />}
      {/* Remount pages after a fresh login so ones stuck on an auth error reload. */}
      <Page key={epoch} route={route} />
    </div>
  )
}

function Head({ sub, actions }: { sub?: string; actions?: React.ReactNode }) {
  return (
    <div className="view-head">
      <div>
        <h1 className="view-title">TIDAL</h1>
        {sub && <div className="view-sub">{sub}</div>}
      </div>
      {actions && <div className="view-actions">{actions}</div>}
    </div>
  )
}

function Tabs({ route }: { route: TidalRoute }) {
  const value: TabValue = route.page === 'favorites' ? route.tab : 'search'
  const options: Array<{ value: TabValue; label: React.ReactNode }> = [
    { value: 'albums', label: 'Albums' },
    { value: 'tracks', label: 'Tracks' },
    { value: 'playlists', label: 'Playlists' },
    { value: 'artists', label: 'Artists' },
  ]
  if (route.page === 'search')
    options.push({
      value: 'search',
      label: (
        <span className="tidal-tab-search">
          <Icon name="search" size={12} /> Search
        </span>
      ),
    })
  return (
    <div className="tabs tidal-tabs">
      <Segmented
        value={value}
        options={options}
        onChange={(v) => {
          if (v === 'search') return
          navigate({ view: 'tidal', tab: v })
        }}
      />
      <span className="faint tidal-tabs-note">{LOSSLESS_NOTE}</span>
    </div>
  )
}

function Page({ route }: { route: TidalRoute }) {
  switch (route.page) {
    case 'favorites':
      return <Favorites key={route.tab} kind={route.tab} />
    case 'search':
      return <Search key={route.query} query={route.query} />
    case 'album':
      return <AlbumPage key={route.id} id={route.id} />
    case 'artist':
      return <ArtistPage key={route.id} id={route.id} />
    case 'playlist':
      return <PlaylistPage key={route.id} uuid={route.id} />
  }
}
