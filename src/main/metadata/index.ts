// Metadata / identification service: MusicBrainz, AcoustID, LRCLIB, Cover Art Archive.

import type { Logger } from '../context'
import type { Transport } from '../import/source-types'
import { fpcalcPath as defaultFpcalcPath } from '../platform/binaries'
import { lookupAcoustid, runFpcalc, type Fingerprint } from './acoustid'
import type { HttpCache } from './cache'
import { applyRelease, identifyRelease, type IdentifyDeps, type IdentifyInput, type IdentifyResult } from './identify'
import { globalLimiters, type LimiterSet } from './limiter'
import { fetchLyrics } from './lyrics'
import { toCandidate, type ReleaseCandidate } from './mapping'
import { createMbClient } from './musicbrainz'

export { memoryCache, fileCache, type HttpCache } from './cache'
export { cleanTitle, fixMojibake, inferLooseCluster, clusterFiles, sanitizeTags } from './heuristics'
export { pickGenre } from './genre'
export { mergeTags, type FieldSource, type MergePolicy } from './merge'
export { RateLimiter, globalLimiters } from './limiter'
export type { IdentifyInput, IdentifyResult, IdentifyTrackInput } from './identify'
export type { ReleaseCandidate } from './mapping'

export const PROJECT_URL = 'https://github.com/valence-music-app'

export interface MetadataServiceOptions {
  transport?: Transport
  cache?: HttpCache
  /** MB User-Agent contact; may be ''. */
  contact: () => string
  appVersion: string
  /** null → AcoustID disabled. */
  acoustidKey: () => string | null
  fpcalcPath?: () => string | null
  log?: Logger
  /** Override the process-wide rate limiters (tests). */
  limiters?: Partial<LimiterSet>
}

export interface MetadataService {
  identify(input: IdentifyInput, signal?: AbortSignal): Promise<IdentifyResult>
  /** User picked a candidate in Review. */
  applyRelease(releaseId: string, input: IdentifyInput): Promise<IdentifyResult>
  searchReleases(q: { artist?: string; album?: string; barcode?: string }): Promise<ReleaseCandidate[]>
  fingerprint(file: string): Promise<{ fingerprint: string; duration: number } | null>
  lyrics(q: { artist: string; title: string; album?: string; durationMs: number }): Promise<{ synced?: string; plain?: string } | null>
}

export function createMetadataService(opts: MetadataServiceOptions): MetadataService {
  const transport: Transport = opts.transport ?? ((url, init) => fetch(url, init))
  const limiters = { ...globalLimiters, ...opts.limiters }
  const http = { transport, cache: opts.cache, log: opts.log }
  const mbUa = () => `Valence/${opts.appVersion} ( ${opts.contact()?.trim() || PROJECT_URL} )`
  const appUa = `Valence/${opts.appVersion} ( ${PROJECT_URL} )`
  const mb = createMbClient({ ...http, limiter: limiters.musicbrainz, userAgent: mbUa })
  const fpcalc = opts.fpcalcPath ?? defaultFpcalcPath

  const fingerprint = async (file: string): Promise<Fingerprint | null> => {
    const bin = fpcalc()
    return bin ? runFpcalc(bin, file) : null
  }
  const deps = (): IdentifyDeps => {
    const key = opts.acoustidKey()?.trim()
    return {
      mb,
      fingerprint,
      log: opts.log,
      acoustid: key ? (fp, signal) => lookupAcoustid({ ...http, limiter: limiters.acoustid }, key, fp, signal) : null,
    }
  }

  return {
    identify: (input, signal) => identifyRelease(deps(), input, signal),
    applyRelease: (releaseId, input) => applyRelease(deps(), releaseId, input),
    async searchReleases(q) {
      const rs = q.barcode ? await mb.releasesByBarcode(q.barcode) : q.album ? await mb.searchReleases(q.album, q.artist || undefined, 25) : []
      return rs.map((r) => toCandidate(r, (r.score ?? 100) / 100))
    },
    fingerprint,
    async lyrics(q) {
      try {
        return await fetchLyrics({ ...http, limiter: limiters.lrclib, userAgent: appUa }, q)
      } catch (err) {
        opts.log?.warn('metadata: lyrics lookup failed', String(err))
        return null
      }
    },
  }
}
