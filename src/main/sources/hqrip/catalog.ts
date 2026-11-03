// Builds the rip album catalog from highquality.rip (album index) and sgfr.highquality.rip (release
// list + one page per release). Releases carry Drive folder ids; badges are added by the service.

import { SourceError, type Transport } from '@main/import/source-types'
import type { HqrCollection, HqrSgfrType } from '@shared/ipc/hqrip'
import { parseAlbumIndex, parseSgfrList, parseSgfrPage, pickFormat, type DriveFolders } from './parse'

export const ALBUMS_URL = 'https://highquality.rip/albums.html'
export const SGFR_BASE = 'https://sgfr.highquality.rip'

export interface CatalogRelease {
  id: string
  collection: HqrCollection
  title: string
  catalogNumber?: string
  sgfrType?: HqrSgfrType
  folders: DriveFolders
  /** Artwork URL known without listing the folder (SGFR publishes one per release). */
  cover?: string
  bandcampUrl?: string
}

export function releaseFolder(r: CatalogRelease): string | null {
  const f = pickFormat(r.folders)
  return f ? (r.folders[f] ?? null) : null
}

async function text(transport: Transport, url: string, signal?: AbortSignal): Promise<string> {
  let res: Response
  try {
    res = await transport(url, { signal, headers: { Accept: 'text/html,*/*' } })
  } catch (e) {
    throw new SourceError(`Couldn't reach ${new URL(url).host}: ${(e as Error)?.message ?? e}`, 'network')
  }
  if (!res.ok) throw new SourceError(`${new URL(url).host} answered HTTP ${res.status}`, res.status >= 500 ? 'network' : 'unavailable')
  return res.text()
}

export async function fetchAlbumIndex(transport: Transport, signal?: AbortSignal): Promise<CatalogRelease[]> {
  const entries = parseAlbumIndex(await text(transport, ALBUMS_URL, signal))
  const out: CatalogRelease[] = []
  const seen = new Set<string>()
  for (const e of entries) {
    const folder = e.folders.flac ?? e.folders.ogg ?? e.folders.mp3
    if (!folder || seen.has(folder)) continue
    seen.add(folder)
    out.push({ id: `hqr:${folder}`, collection: 'SiIvaGunner', title: e.title, folders: e.folders })
  }
  return out
}

/** SGFR list plus each release page (fetched a few at a time). Releases whose page fails are skipped. */
export async function fetchSgfr(transport: Transport, signal?: AbortSignal, log?: (msg: string, e?: unknown) => void): Promise<CatalogRelease[]> {
  const list = parseSgfrList(await text(transport, `${SGFR_BASE}/albumpage.js`, signal))
  const out: Array<CatalogRelease | null> = new Array(list.length).fill(null)
  let next = 0
  const worker = async () => {
    for (let i = next++; i < list.length; i = next++) {
      const s = list[i]
      try {
        const page = parseSgfrPage(await text(transport, `${SGFR_BASE}/sgfr-${s.id}/index.html`, signal))
        if (!pickFormat(page.folders)) continue
        out[i] = {
          id: `sgfr:${s.id}`,
          collection: 'SGFR',
          title: s.title,
          catalogNumber: `SGFR-${s.id.toUpperCase()}`,
          sgfrType: s.type,
          folders: page.folders,
          cover: `${SGFR_BASE}/sgfr-${s.id}/bc.jpg`,
          bandcampUrl: page.bandcampUrl ?? undefined,
        }
      } catch (e) {
        if (signal?.aborted) throw e
        log?.(`hqrip: SGFR page ${s.id} unreadable`, (e as Error).message)
      }
    }
  }
  await Promise.all([worker(), worker(), worker()])
  return out.filter((r): r is CatalogRelease => !!r)
}
