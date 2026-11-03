// Bandcamp IPC contract: channel names and renderer-facing types.

import type { InLibraryBadge } from '../types'

export const BANDCAMP_CHANNELS = {
  status: 'bandcamp:status',
  login: 'bandcamp:login',
  logout: 'bandcamp:logout',
  collection: 'bandcamp:collection',
  item: 'bandcamp:item',
  download: 'bandcamp:download',
  downloadAllMissing: 'bandcamp:downloadAllMissing',
  /** main → renderer broadcast, no payload: re-request `bandcamp:collection`. */
  collectionUpdated: 'bandcamp:collection-updated',
} as const

export interface BandcampStatus {
  loggedIn: boolean
  fanId: number | null
  username?: string
}

/** What was bought: a digital album/track, or a physical package (which may include a download). */
export type BandcampItemType = 'album' | 'track' | 'package'

export interface BandcampItemSummary {
  /** Stable purchase key `${sale_item_type}${sale_item_id}`; pass to `bandcamp:item` / `bandcamp:download`. */
  key: string
  itemType: BandcampItemType
  /** The release the purchase maps to (packages map to their album). */
  tralbumType: 'album' | 'track'
  tralbumId: number
  title: string
  artist: string
  itemUrl: string | null
  /** ~350px cover thumbnail on f4.bcbits.com. */
  artUrl: string | null
  /** ISO timestamp of the purchase, when known. */
  purchased?: string
  hidden: boolean
  preorder: boolean
  /** Physical package without a digital download. */
  physicalOnly: boolean
  /** Has a redownload link and is not a pre-order. */
  downloadable: boolean
  trackCount?: number
  badge: InLibraryBadge
  /** Present while the release is queued or downloading in the import queue. */
  queue?: 'queued' | 'running'
}

export interface BandcampTrackSummary {
  trackId: number
  trackNum: number
  title: string
  artist: string
  durationMs: number
  inLibrary: boolean
}

export interface BandcampItemDetail extends BandcampItemSummary {
  tracks: BandcampTrackSummary[]
  /** YYYY-MM-DD when known (only after the album page was fetched). */
  releaseDate?: string
  label?: string
  tags?: string[]
}

export interface BandcampCollectionRequest {
  /** Bypass the ~10 minute cache. */
  refresh?: boolean
}

export interface BandcampCollection {
  items: BandcampItemSummary[]
  /** ms epoch of the last network fetch. */
  fetchedAt: number
}

/** Shape a preload bridge can expose (each method is an ipcRenderer.invoke on the channel above). */
export interface BandcampApi {
  status(): Promise<BandcampStatus>
  /** Opens the login window; resolves once logged in or the window is closed. */
  login(): Promise<BandcampStatus>
  logout(): Promise<BandcampStatus>
  collection(req?: BandcampCollectionRequest): Promise<BandcampCollection>
  item(key: string): Promise<BandcampItemDetail>
  /** Enqueues one purchase; resolves with the import job id. */
  download(key: string): Promise<string>
  /** Enqueues every downloadable purchase not fully in the library; resolves with the count enqueued. */
  downloadAllMissing(): Promise<number>
}
