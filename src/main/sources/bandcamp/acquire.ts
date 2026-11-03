// The 'bandcamp' acquirer: album page + FLAC download → SourceRelease. Electron-free.

import type { Acquirer, Logger } from '@main/context'
import { SourceError } from '@main/import/source-types'
import type { BandcampClient, SleepFn } from './client'
import { downloadRelease, probeAndMatch } from './downloader'
import { mapRelease, tralbumFromDigital } from './mapper'
import { parseTralbum, type BcTralbum } from './parse'

/** Import-queue job payload (JSON; survives restarts). */
export interface BandcampPayload {
  itemKey: string
  saleItemType: string
  saleItemId: number
  redownloadUrl: string
  itemUrl: string | null
  tralbumId?: number
  tralbumType?: 'album' | 'track'
}

export interface AcquirerDeps {
  client: BandcampClient
  log?: Logger
  sleep?: SleepFn
  pollBaseMs?: number
  maxWaitMs?: number
  /** Fresh redownload link for a purchase key (collection refresh), when the stored one is dead. */
  refreshRedownloadUrl?: (itemKey: string) => Promise<string | null>
}

export async function fetchTralbum(client: BandcampClient, url: string, signal?: AbortSignal): Promise<BcTralbum> {
  const { text, url: finalUrl } = await client.text(url, signal)
  const t = parseTralbum(text, finalUrl)
  if (!t) throw new SourceError(`No release data on ${url}`, 'parse')
  return t
}

const IMAGE_RE = /\.(jpe?g|png|gif|webp)$/i

export function createAcquirer(deps: AcquirerDeps): Acquirer {
  return async (payload: BandcampPayload, ctx) => {
    const { client, log } = deps
    const tryTralbum = async (url: string | null | undefined): Promise<BcTralbum | null> => {
      if (!url) return null
      try {
        return await fetchTralbum(client, url, ctx.signal)
      } catch (e) {
        const kind = (e as SourceError).kind
        if (kind === 'cancelled' || kind === 'rate-limit' || kind === 'auth') throw e
        log?.warn('bandcamp: release page unreadable, using download page metadata', { url, error: (e as Error).message })
        return null
      }
    }

    ctx.progress({ phase: 'resolving', message: 'Reading Bandcamp release page' })
    let tralbum = await tryTralbum(payload.itemUrl)
    const dl = await downloadRelease({
      client,
      redownloadUrl: payload.redownloadUrl,
      want: { saleItemId: payload.saleItemId, tralbumId: payload.tralbumId },
      stagingDir: ctx.stagingDir,
      signal: ctx.signal,
      progress: ctx.progress,
      sleep: deps.sleep,
      pollBaseMs: deps.pollBaseMs,
      maxWaitMs: deps.maxWaitMs,
      refreshRedownloadUrl: deps.refreshRedownloadUrl ? () => deps.refreshRedownloadUrl!(payload.itemKey) : undefined,
    })
    if (!tralbum && dl.digital.pageUrl && dl.digital.pageUrl !== payload.itemUrl) tralbum = await tryTralbum(dl.digital.pageUrl)
    tralbum ??= tralbumFromDigital(dl.digital)

    ctx.progress({ phase: 'processing', message: 'Matching tracks', trackCount: dl.audio.length })
    const files = await probeAndMatch(dl.audio, tralbum.tracks)
    const unmatched = files.filter((f) => !f.track).length
    if (unmatched && tralbum.tracks.length) log?.warn('bandcamp: some files did not match the tracklist', { unmatched, release: tralbum.id })
    const coverFile = dl.extras.find((f) => /(^|[\\/])cover\.[a-z]+$/i.test(f)) ?? dl.extras.find((f) => IMAGE_RE.test(f))
    return mapRelease({
      tralbum,
      files,
      extras: dl.extras,
      itemUrl: payload.itemUrl ?? tralbum.url,
      coverFile,
      raw: { purchase: { key: payload.itemKey, saleItemType: payload.saleItemType, saleItemId: payload.saleItemId }, digital: { ...dl.digital, downloads: undefined, flacUrl: undefined } },
    })
  }
}
