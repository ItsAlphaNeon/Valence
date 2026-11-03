import type { Logger } from '../context'
import type { Transport } from '../import/source-types'
import type { HttpCache } from './cache'
import type { RateLimiter } from './limiter'
import { sleep } from './util'

export const DAY = 86_400

export interface HttpDeps {
  transport: Transport
  cache?: HttpCache
  log?: Logger
}

export interface GetOptions {
  limiter: RateLimiter
  headers?: Record<string, string>
  ttlSec?: number
  notFoundTtlSec?: number
  signal?: AbortSignal
  method?: 'GET' | 'POST'
  body?: string
  cacheKey?: string
  retries?: number
}

export class HttpError extends Error {
  constructor(readonly status: number, readonly url: string) {
    super(`HTTP ${status} for ${url}`)
    this.name = 'HttpError'
  }
}

const RETRY_STATUS = new Set([429, 500, 502, 503, 504])

function retryAfterMs(res: Response, attempt: number): number {
  const h = res.headers.get('retry-after')
  const s = h ? Number(h) : NaN
  if (Number.isFinite(s) && s >= 0) return Math.min(30_000, s * 1000)
  return 1000 * 2 ** attempt
}

/** GET (or POST) JSON with cache, rate limiting and retry/backoff. 404 → null (cached briefly). */
export async function fetchJson<T = unknown>(deps: HttpDeps, url: string, o: GetOptions): Promise<T | null> {
  const key = o.cacheKey ?? url
  const hit = deps.cache?.get(key)
  if (hit != null) return JSON.parse(hit) as T | null
  const retries = o.retries ?? 3
  for (let attempt = 0; ; attempt++) {
    o.signal?.throwIfAborted()
    let res: Response
    try {
      res = await o.limiter.schedule(() => deps.transport(url, { method: o.method ?? 'GET', headers: o.headers, body: o.body, signal: o.signal }))
    } catch (err) {
      if (o.signal?.aborted || attempt >= retries) throw err
      deps.log?.warn(`metadata: network error, retrying ${url}`, String(err))
      await sleep(1000 * 2 ** attempt)
      continue
    }
    if (RETRY_STATUS.has(res.status) && attempt < retries) {
      const wait = retryAfterMs(res, attempt)
      deps.log?.warn(`metadata: HTTP ${res.status}, backing off ${wait} ms`, url)
      o.limiter.delay(wait)
      await res.body?.cancel().catch(() => undefined)
      continue
    }
    if (res.status === 404) {
      await res.body?.cancel().catch(() => undefined)
      deps.cache?.set(key, 'null', o.notFoundTtlSec ?? DAY)
      return null
    }
    if (!res.ok) throw new HttpError(res.status, url)
    const text = await res.text()
    const json = JSON.parse(text) as T
    deps.cache?.set(key, text, o.ttlSec ?? 30 * DAY)
    return json
  }
}
