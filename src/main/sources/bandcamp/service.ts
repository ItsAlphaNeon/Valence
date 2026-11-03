// Bandcamp IPC logic (status, collection cache, badges, enqueueing). Electron-free: index.ts wires
// it to ipcMain and the persistent session.

import type { AppContext, BadgeQueryAlbum, BadgeQueryTrack } from '@main/context'
import { SourceError } from '@main/import/source-types'
import {
  BANDCAMP_CHANNELS,
  type BandcampCollection,
  type BandcampCollectionRequest,
  type BandcampItemDetail,
  type BandcampItemSummary,
  type BandcampStatus,
} from '@shared/ipc/bandcamp'
import type { BandcampPayload } from './acquire'
import { fetchTralbum } from './acquire'
import type { BandcampClient } from './client'
import { artUrl, releaseKey } from './mapper'
import type { BcCollectionItem, BcTrack, BcTralbum, FanIdentity } from './parse'

export interface BandcampAuth {
  isLoggedIn(): Promise<boolean>
  /** Opens the login UI; resolves true once logged in. */
  login(): Promise<boolean>
  logout(): Promise<void>
}

export interface ServiceDeps {
  ctx: Pick<AppContext, 'library' | 'imports' | 'broadcast' | 'log'>
  client: BandcampClient
  auth: BandcampAuth
  /** Collection cache lifetime. Default 10 min. */
  ttlMs?: number
}

interface Cache {
  items: BcCollectionItem[]
  fetchedAt: number
  signature: string
}

const signatureOf = (items: BcCollectionItem[]) =>
  items.map((i) => `${i.key}:${+i.hidden}:${+i.downloadable}:${i.redownloadUrl ? 1 : 0}`).join(',')

export class BandcampService {
  private identity: FanIdentity | null = null
  private cache: Cache | null = null
  private inflight: Promise<Cache> | null = null
  private readonly tralbums = new Map<string, BcTralbum>()
  private readonly ttl: number

  constructor(private readonly deps: ServiceDeps) {
    this.ttl = deps.ttlMs ?? 10 * 60_000
  }

  private get ctx() {
    return this.deps.ctx
  }

  private notify(): void {
    this.ctx.broadcast(BANDCAMP_CHANNELS.collectionUpdated)
  }

  async status(): Promise<BandcampStatus> {
    if (!(await this.deps.auth.isLoggedIn())) {
      this.identity = null
      return { loggedIn: false, fanId: null }
    }
    if (!this.identity) {
      try {
        this.identity = await this.deps.client.identity()
        // Cookie present but the homepage shows no fan: the session is dead.
        if (!this.identity) return { loggedIn: false, fanId: null }
      } catch (e) {
        if ((e as SourceError).kind === 'auth') return { loggedIn: false, fanId: null }
        this.ctx.log.warn('bandcamp: could not read identity', { error: (e as Error).message })
        return { loggedIn: true, fanId: null }
      }
    }
    return { loggedIn: true, fanId: this.identity.fanId, ...(this.identity.username ? { username: this.identity.username } : {}) }
  }

  async login(): Promise<BandcampStatus> {
    const ok = await this.deps.auth.login()
    this.reset()
    const status = await this.status()
    if (ok) this.notify()
    return status
  }

  async logout(): Promise<BandcampStatus> {
    await this.deps.auth.logout()
    this.reset()
    this.notify()
    return { loggedIn: false, fanId: null }
  }

  private reset(): void {
    this.identity = null
    this.cache = null
    this.inflight = null
    this.tralbums.clear()
  }

  private async load(refresh: boolean): Promise<Cache> {
    if (!refresh && this.cache && Date.now() - this.cache.fetchedAt < this.ttl) return this.cache
    this.inflight ??= (async () => {
      try {
        const status = await this.status()
        if (!status.loggedIn || !status.fanId) throw new SourceError('Not logged in to Bandcamp', 'auth')
        const items = await this.deps.client.collection(status.fanId)
        const prev = this.cache
        const next: Cache = { items, fetchedAt: Date.now(), signature: signatureOf(items) }
        this.cache = next
        if (prev && prev.signature !== next.signature) this.notify()
        return next
      } finally {
        this.inflight = null
      }
    })()
    return this.inflight
  }

  private badgeQuery(i: BcCollectionItem, tracks = i.tracks): BadgeQueryAlbum {
    const q: BadgeQueryAlbum = { bandcampAlbumId: String(i.tralbumId), albumArtist: i.artist, title: i.title }
    const list = tracks?.length ? tracks : i.tralbumType === 'track' ? [{ trackId: i.tralbumId, title: i.title, trackNum: 1, durationMs: 0 }] : undefined
    if (list) {
      q.trackCount = list.length
      q.tracks = list.map((t) => this.trackQuery(i, t))
    } else if (i.trackCount) q.trackCount = i.trackCount
    return q
  }

  private trackQuery(i: BcCollectionItem, t: Pick<BcTrack, 'trackId' | 'title' | 'artist' | 'durationMs'>): BadgeQueryTrack {
    return {
      bandcampTrackId: String(t.trackId),
      title: t.title,
      artist: t.artist || i.artist,
      albumArtist: i.artist,
      album: i.title,
      ...(t.durationMs ? { durationMs: t.durationMs } : {}),
    }
  }

  private summaries(items: BcCollectionItem[]): BandcampItemSummary[] {
    const badges = items.length ? this.ctx.library.albumBadges(items.map((i) => this.badgeQuery(i))) : []
    const active = this.ctx.imports.activeKeys()
    return items.map((i, n) => this.summary(i, badges[n] ?? { status: 'missing', have: 0, total: i.trackCount ?? 0 }, active))
  }

  private summary(i: BcCollectionItem, badge: BandcampItemSummary['badge'], active: Map<string, 'queued' | 'running'>): BandcampItemSummary {
    const queue = active.get(releaseKey(i.tralbumType, i.tralbumId))
    return {
      key: i.key,
      itemType: i.itemType,
      tralbumType: i.tralbumType,
      tralbumId: i.tralbumId,
      title: i.title,
      artist: i.artist,
      itemUrl: i.itemUrl,
      artUrl: i.artId ? artUrl(i.artId, 2) : null,
      ...(i.purchased ? { purchased: i.purchased } : {}),
      hidden: i.hidden,
      preorder: i.preorder,
      physicalOnly: i.physicalOnly,
      downloadable: i.downloadable,
      ...(i.trackCount ? { trackCount: i.trackCount } : {}),
      badge,
      ...(queue ? { queue } : {}),
    }
  }

  async collection(req: BandcampCollectionRequest = {}): Promise<BandcampCollection> {
    const c = await this.load(!!req.refresh)
    return { items: this.summaries(c.items), fetchedAt: c.fetchedAt }
  }

  private async find(key: string): Promise<BcCollectionItem> {
    let c = await this.load(false)
    let item = c.items.find((i) => i.key === key)
    if (!item) {
      c = await this.load(true)
      item = c.items.find((i) => i.key === key)
    }
    if (!item) throw new SourceError(`Bandcamp purchase ${key} not found in the collection`, 'unavailable')
    return item
  }

  async item(key: string): Promise<BandcampItemDetail> {
    const item = await this.find(key)
    let tralbum = this.tralbums.get(key)
    if (!tralbum && item.itemUrl) {
      try {
        tralbum = await fetchTralbum(this.deps.client, item.itemUrl)
        this.tralbums.set(key, tralbum)
      } catch (e) {
        this.ctx.log.warn('bandcamp: release page unreadable', { url: item.itemUrl, error: (e as Error).message })
      }
    }
    const tracks: BcTrack[] = tralbum?.tracks.length ? tralbum.tracks : (item.tracks ?? [])
    const badge = this.ctx.library.albumBadge(this.badgeQuery(item, tracks))
    const inLib = tracks.length ? this.ctx.library.matchTracks(tracks.map((t) => this.trackQuery(item, t))) : []
    return {
      ...this.summary(item, badge, this.ctx.imports.activeKeys()),
      ...(tracks.length ? { trackCount: tracks.length } : {}),
      tracks: tracks.map((t, n) => ({
        trackId: t.trackId,
        trackNum: t.trackNum,
        title: t.title,
        artist: t.artist || item.artist,
        durationMs: t.durationMs,
        inLibrary: !!inLib[n],
      })),
      ...(tralbum?.releaseDate ? { releaseDate: tralbum.releaseDate } : {}),
      ...(tralbum?.label ? { label: tralbum.label } : {}),
      ...(tralbum?.tags.length ? { tags: tralbum.tags } : {}),
    }
  }

  private enqueue(i: BcCollectionItem): string {
    if (!i.downloadable || !i.redownloadUrl) {
      const why = i.preorder ? 'is a pre-order' : i.physicalOnly ? 'has no digital download' : 'has no download link'
      throw new SourceError(`${i.artist} — ${i.title} ${why}`, 'unavailable')
    }
    const payload: BandcampPayload = {
      itemKey: i.key,
      saleItemType: i.saleItemType,
      saleItemId: i.saleItemId,
      redownloadUrl: i.redownloadUrl,
      itemUrl: i.itemUrl,
      tralbumId: i.tralbumId,
      tralbumType: i.tralbumType,
    }
    return this.ctx.imports.enqueue({
      source: 'bandcamp',
      title: `${i.artist} — ${i.title}`,
      releaseKeys: [releaseKey(i.tralbumType, i.tralbumId)],
      payload,
    })
  }

  async download(key: string): Promise<string> {
    const id = this.enqueue(await this.find(key))
    this.notify()
    return id
  }

  async downloadAllMissing(): Promise<number> {
    const { items } = await this.load(false)
    const candidates = items.filter((i) => i.downloadable)
    const badges = candidates.length ? this.ctx.library.albumBadges(candidates.map((i) => this.badgeQuery(i))) : []
    const active = this.ctx.imports.activeKeys()
    const seen = new Set<string>()
    let count = 0
    candidates.forEach((i, n) => {
      const rk = releaseKey(i.tralbumType, i.tralbumId)
      if (badges[n]?.status === 'in-library' || active.has(rk) || seen.has(rk)) return
      seen.add(rk)
      this.enqueue(i)
      count++
    })
    if (count) this.notify()
    return count
  }

  /** Fresh redownload link for a purchase (forces a collection refresh). */
  async redownloadUrlFor(itemKey: string): Promise<string | null> {
    try {
      const c = await this.load(true)
      return c.items.find((i) => i.key === itemKey)?.redownloadUrl ?? null
    } catch {
      return null
    }
  }
}
