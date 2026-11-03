// Chromaprint fingerprinting (fpcalc) and AcoustID lookup.

import { execFile } from 'node:child_process'
import { fetchJson, DAY, type HttpDeps } from './http'
import type { RateLimiter } from './limiter'
import type { MbRelease } from './musicbrainz'
import { sha1 } from './util'

export const ACOUSTID_URL = 'https://api.acoustid.org/v2/lookup'
export const ACOUSTID_MIN_SCORE = 0.8
export const ACOUSTID_MAX_DELTA_S = 7

export interface Fingerprint { fingerprint: string; duration: number }

export function runFpcalc(bin: string, file: string, timeoutMs = 60_000): Promise<Fingerprint | null> {
  return new Promise((resolve) => {
    execFile(bin, ['-json', '-length', '120', file], { timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      if (err) return resolve(null)
      try {
        const j = JSON.parse(String(stdout)) as { fingerprint?: string; duration?: number }
        resolve(j.fingerprint && typeof j.duration === 'number' ? { fingerprint: j.fingerprint, duration: j.duration } : null)
      } catch {
        resolve(null)
      }
    })
  })
}

interface AcoustidRelease { id: string; title?: string; country?: string; track_count?: number; medium_count?: number; date?: { year?: number; month?: number; day?: number } }
interface AcoustidRecording {
  id: string
  title?: string
  duration?: number
  artists?: Array<{ id: string; name: string; joinphrase?: string }>
  releases?: AcoustidRelease[]
  releasegroups?: Array<{ id: string; type?: string; secondarytypes?: string[]; title?: string; releases?: AcoustidRelease[] }>
}
interface AcoustidResponse { status: string; results?: Array<{ id: string; score: number; recordings?: AcoustidRecording[] }> }

export interface AcoustidMatch {
  acoustid: string
  score: number
  recordingId: string
  title?: string
  durationSec?: number
  artist?: string
  /** Release summaries in MB shape (only the fields AcoustID returns). */
  releases: MbRelease[]
}

function toMbRelease(r: AcoustidRelease, rg?: { id: string; type?: string; secondarytypes?: string[] }): MbRelease {
  const d = r.date
  const date = d?.year ? [d.year, d.month, d.day].filter(Boolean).map((x, i) => (i ? String(x).padStart(2, '0') : String(x))).join('-') : undefined
  return {
    id: r.id,
    title: r.title ?? '',
    country: r.country,
    date,
    'track-count': r.track_count,
    'release-group': rg ? { id: rg.id, 'primary-type': rg.type, 'secondary-types': rg.secondarytypes } : undefined,
  }
}

/** Matches with score ≥ 0.80 whose recording duration is within ±7 s of the file. */
export async function lookupAcoustid(
  deps: HttpDeps & { limiter: RateLimiter },
  key: string,
  fp: Fingerprint,
  signal?: AbortSignal,
): Promise<AcoustidMatch[]> {
  const body = new URLSearchParams({ client: key, format: 'json', meta: 'recordings releasegroups releases', duration: String(Math.round(fp.duration)), fingerprint: fp.fingerprint })
  const json = await fetchJson<AcoustidResponse>(deps, ACOUSTID_URL, {
    limiter: deps.limiter,
    method: 'POST',
    body: body.toString(),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    cacheKey: `acoustid:${sha1(`${Math.round(fp.duration)}:${fp.fingerprint}`)}`,
    ttlSec: 30 * DAY,
    signal,
  })
  const out: AcoustidMatch[] = []
  if (json?.status !== 'ok') return out
  for (const res of json.results ?? []) {
    if (res.score < ACOUSTID_MIN_SCORE) continue
    for (const rec of res.recordings ?? []) {
      if (typeof rec.duration === 'number' && Math.abs(rec.duration - fp.duration) > ACOUSTID_MAX_DELTA_S) continue
      const releases = [
        ...(rec.releases ?? []).map((r) => toMbRelease(r)),
        ...(rec.releasegroups ?? []).flatMap((g) => (g.releases ?? []).map((r) => toMbRelease(r, g))),
      ]
      out.push({
        acoustid: res.id,
        score: res.score,
        recordingId: rec.id,
        title: rec.title,
        durationSec: rec.duration,
        artist: rec.artists?.map((a) => `${a.name}${a.joinphrase ?? ''}`).join(''),
        releases,
      })
    }
  }
  return out.sort((a, b) => b.score - a.score)
}
