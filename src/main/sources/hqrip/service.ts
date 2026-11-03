// Rip album catalog (highquality.rip + SGFR): cached on disk, refreshed daily, with in-library badges
// from the HQR_RELEASE tag. Folder details (track count, cover) are filled in slowly in the background
// so the catalog page never fires 150 Drive requests at once.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { AppContext } from '@main/context'
import type { Transport } from '@main/import/source-types'
import { HQRIP_IPC, type HqrCatalog, type HqrCollection, type HqrDownloadAllResult, type HqrDownloadResult, type HqrRelease } from '@shared/ipc/hqrip'
import type { InLibraryBadge } from '@shared/types'
import { fetchAlbumIndex, fetchSgfr, releaseFolder, type CatalogRelease } from './catalog'
import type { DriveClient } from './drive'
import type { HqripPayload } from './acquire'
import { pickFormat } from './parse'

const TTL = 24 * 3600_000
const DETAILS_TTL = 7 * 24 * 3600_000

interface Details {
  trackCount: number
  coverId: string | null
  listedAt: number
}

interface CacheFile {
  releases: CatalogRelease[]
  fetchedAt: number
  details: Record<string, Details>
}

const driveThumb = (id: string) => `https://drive.google.com/thumbnail?id=${encodeURIComponent(id)}&sz=w400`

export function badgeFor(have: number, total: number | null): InLibraryBadge {
  if (!have) return { status: 'missing', have: 0, total: total ?? 0 }
  if (total && have < total) return { status: 'partial', have, total }
  return { status: 'in-library', have, total: total ?? have }
}

export class HqripService {
  private cache: CacheFile
  private inflight: Promise<CatalogRelease[]> | null = null
  private detailing = false
  private stopped = false
  private lastError: string | undefined

  constructor(
    private deps: { ctx: AppContext; transport: Transport; drive: DriveClient; cacheFile?: string; now?: () => number },
  ) {
    this.cache = this.read()
  }

  private get file(): string {
    return this.deps.cacheFile ?? join(this.deps.ctx.env.dataDir, 'cache', 'hqrip-catalog.json')
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  private read(): CacheFile {
    try {
      const c = JSON.parse(readFileSync(this.file, 'utf8')) as CacheFile
      if (Array.isArray(c.releases)) return { releases: c.releases, fetchedAt: c.fetchedAt ?? 0, details: c.details ?? {} }
    } catch {
      /* first run */
    }
    return { releases: [], fetchedAt: 0, details: {} }
  }

  private write(): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      writeFileSync(this.file, JSON.stringify(this.cache))
    } catch (e) {
      this.deps.ctx.log.warn('hqrip: could not save the catalog cache', (e as Error).message)
    }
  }

  stop(): void {
    this.stopped = true
  }

  /** Releases with badges and queue state. Refreshes from the sites when stale or asked to. */
  async catalog(refresh = false): Promise<HqrCatalog> {
    if (refresh || !this.cache.releases.length || this.now() - this.cache.fetchedAt > TTL) {
      try {
        await (this.inflight ??= this.fetch().finally(() => (this.inflight = null)))
        this.lastError = undefined
      } catch (e) {
        this.lastError = (e as Error).message
        // A refresh failure with nothing cached is an error; otherwise show the cached catalog.
        if (!this.cache.releases.length) throw e
      }
    }
    void this.fillDetails()
    return { releases: this.summaries(), fetchedAt: this.cache.fetchedAt, error: this.lastError }
  }

  private async fetch(): Promise<CatalogRelease[]> {
    const { transport, ctx } = this.deps
    const [albums, sgfr] = await Promise.all([
      fetchAlbumIndex(transport),
      fetchSgfr(transport, undefined, (m, e) => ctx.log.warn(m, e)).catch((e) => {
        ctx.log.warn('hqrip: SGFR list unavailable', (e as Error).message)
        return this.cache.releases.filter((r) => r.collection === 'SGFR')
      }),
    ])
    this.cache = { releases: [...albums, ...sgfr], fetchedAt: this.now(), details: this.cache.details }
    this.write()
    return this.cache.releases
  }

  summaries(): HqrRelease[] {
    const counts = this.deps.ctx.library.ripReleaseCounts?.() ?? new Map<string, number>()
    const active = this.deps.ctx.imports.activeKeys()
    return this.cache.releases.map((r) => {
      const d = this.cache.details[r.id]
      const total = d?.trackCount ?? null
      return {
        id: r.id,
        collection: r.collection,
        title: r.title,
        catalogNumber: r.catalogNumber,
        sgfrType: r.sgfrType,
        folders: r.folders,
        cover: r.cover ?? (d?.coverId ? driveThumb(d.coverId) : null),
        bandcampUrl: r.bandcampUrl,
        trackCount: total,
        format: pickFormat(r.folders),
        badge: badgeFor(counts.get(r.id) ?? 0, total),
        queue: active.get(r.id),
      }
    })
  }

  /** Remembers what a folder listing found (from a download or the background pass). */
  noteListed(releaseId: string, info: { trackCount: number; coverId: string | null }): void {
    this.cache.details[releaseId] = { ...info, listedAt: this.now() }
    this.write()
    this.deps.ctx.broadcast(HQRIP_IPC.catalogUpdated)
  }

  /** Lists folders without details, one at a time with a pause, until all are known. */
  private async fillDetails(): Promise<void> {
    if (this.detailing) return
    this.detailing = true
    try {
      let n = 0
      for (const r of this.cache.releases) {
        if (this.stopped) return
        const d = this.cache.details[r.id]
        if (d && this.now() - d.listedAt < DETAILS_TTL) continue
        const folder = releaseFolder(r)
        if (!folder) continue
        try {
          const { files } = await this.deps.drive.listTree(folder)
          const audio = files.filter((f) => /\.(flac|mp3|ogg|oga|opus|m4a|wav|aiff?)$/i.test(f.name))
          const cover = files.find((f) => /(^|\/)(cover|folder|front)\.(png|jpe?g|webp)$/i.test(f.path))
          this.cache.details[r.id] = { trackCount: audio.length, coverId: cover?.id ?? null, listedAt: this.now() }
        } catch (e) {
          const kind = (e as { kind?: string }).kind
          this.deps.ctx.log.warn(`hqrip: could not list ${r.title}`, (e as Error).message)
          // Drive pushing back: stop for now; the next catalog open continues.
          if (kind === 'rate-limit' || kind === 'abuse') break
        }
        if (++n % 8 === 0) {
          this.write()
          this.deps.ctx.broadcast(HQRIP_IPC.catalogUpdated)
        }
        await new Promise((res) => setTimeout(res, 1200))
      }
      if (n) {
        this.write()
        this.deps.ctx.broadcast(HQRIP_IPC.catalogUpdated)
      }
    } finally {
      this.detailing = false
    }
  }

  private payloadFor(r: CatalogRelease): HqripPayload | null {
    const folderId = releaseFolder(r)
    return folderId ? { releaseId: r.id, collection: r.collection, title: r.title, folderId, catalogNumber: r.catalogNumber } : null
  }

  download(releaseId: string): HqrDownloadResult {
    const r = this.cache.releases.find((x) => x.id === releaseId)
    if (!r) throw new Error('That rip album is no longer in the catalog; refresh and try again')
    const payload = this.payloadFor(r)
    if (!payload) throw new Error('That rip album has no downloadable folder')
    const title = `${r.collection === 'SGFR' ? 'SGFR' : 'SiIvaGunner'} · ${r.title}`
    const jobId = this.deps.ctx.imports.enqueue({ source: 'hqrip', title, releaseKeys: [r.id], payload })
    return { jobId, releaseKeys: [r.id], title }
  }

  downloadAllMissing(collection: HqrCollection): HqrDownloadAllResult {
    const res: HqrDownloadAllResult = { queued: 0, jobIds: [], alreadyInLibrary: 0, alreadyQueued: 0 }
    for (const s of this.summaries()) {
      if (s.collection !== collection || !s.format) continue
      if (s.queue) res.alreadyQueued++
      else if (s.badge.status === 'in-library') res.alreadyInLibrary++
      else {
        res.jobIds.push(this.download(s.id).jobId)
        res.queued++
      }
    }
    return res
  }
}
