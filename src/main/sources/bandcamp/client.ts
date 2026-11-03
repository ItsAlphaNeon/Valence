// Bandcamp HTTP client. Every request goes through the injected Transport (session.fetch in the
// app, plain fetch in tests) and a process-wide 429 gate: one rate-limit answer holds back all
// Bandcamp traffic until the backoff (or Retry-After) has passed.

import { SourceError, type Transport } from '@main/import/source-types'
import {
  parseCollectionPage,
  parseIdentity,
  toCollectionItem,
  type BcCollectionItem,
  type FanIdentity,
} from './parse'

export const cancelled = (): SourceError => new SourceError('Cancelled', 'cancelled')

export type SleepFn = (ms: number, signal?: AbortSignal) => Promise<void>

export const sleep: SleepFn = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(cancelled())
    const onAbort = () => {
      clearTimeout(timer)
      reject(cancelled())
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })

/** Retry-After as delta-seconds or HTTP-date → ms. */
export function parseRetryAfter(v: string | null | undefined, now = Date.now()): number | undefined {
  if (!v) return undefined
  const s = Number(v.trim())
  if (Number.isFinite(s)) return Math.max(0, s * 1000)
  const t = Date.parse(v)
  return Number.isFinite(t) ? Math.max(0, t - now) : undefined
}

export class RateGate {
  private openAt = 0
  private closedAt = 0
  private strikes = 0

  constructor(private readonly opts: { baseMs?: number; maxMs?: number } = {}) {}

  /** ms until the gate opens (0 when open). */
  remaining(): number {
    return Math.max(0, this.openAt - Date.now())
  }

  async wait(signal?: AbortSignal): Promise<void> {
    for (let ms = this.remaining(); ms > 0; ms = this.remaining()) await sleep(ms, signal)
  }

  /**
   * Closes the gate for max(exponential backoff, Retry-After). A 429 for a request that started
   * before the gate last closed (a concurrent request already reported it) does not escalate.
   */
  rateLimited(retryAfterMs?: number, requestStartedAt = Date.now()): number {
    const now = Date.now()
    const escalate = requestStartedAt > this.closedAt || this.strikes === 0
    const base = this.opts.baseMs ?? 10_000
    const backoff = Math.min(this.opts.maxMs ?? 10 * 60_000, base * 2 ** Math.max(0, escalate ? this.strikes : this.strikes - 1))
    if (escalate) this.strikes++
    const delay = Math.max(backoff, Math.min(retryAfterMs ?? 0, 60 * 60_000))
    this.openAt = Math.max(this.openAt, now + delay)
    this.closedAt = now
    return this.openAt - now
  }

  succeeded(): void {
    this.strikes = 0
  }

  get strikeCount(): number {
    return this.strikes
  }
}

/** One gate for all Bandcamp traffic in the process. */
export const sharedGate = new RateGate()

export interface ClientOptions {
  transport: Transport
  gate?: RateGate
  /** Defaults to https://bandcamp.com (tests point it at a local server). */
  baseUrl?: string
  /** 429 retries per request before giving up with a 'rate-limit' error. */
  maxRateLimitRetries?: number
}

export function statusError(status: number, what: string): SourceError {
  if (status === 401 || status === 403) return new SourceError(`${what}: HTTP ${status} (logged out?)`, 'auth')
  if (status === 404 || status === 410) return new SourceError(`${what}: HTTP ${status}`, 'unavailable')
  return new SourceError(`${what}: HTTP ${status}`, 'network')
}

export async function discard(res: Response): Promise<void> {
  try {
    await res.body?.cancel()
  } catch {
    // already consumed / closed
  }
}

const COLLECTION_PAGE = 100
const MAX_PAGES = 1000

export class BandcampClient {
  readonly gate: RateGate
  readonly baseUrl: string
  private readonly transport: Transport
  private readonly maxRetries: number

  constructor(opts: ClientOptions) {
    this.transport = opts.transport
    this.gate = opts.gate ?? sharedGate
    this.baseUrl = (opts.baseUrl ?? 'https://bandcamp.com').replace(/\/+$/, '')
    this.maxRetries = opts.maxRateLimitRetries ?? 8
  }

  /** Raw request through the 429 gate. Returns any non-429 response; callers check the status. */
  async request(url: string, init: RequestInit = {}): Promise<Response> {
    const signal = init.signal ?? undefined
    for (let attempt = 0; ; attempt++) {
      await this.gate.wait(signal)
      const started = Date.now()
      let res: Response
      try {
        res = await this.transport(url, init)
      } catch (e) {
        if (signal?.aborted) throw cancelled()
        throw new SourceError(`Bandcamp request failed: ${(e as Error)?.message ?? e}`, 'network')
      }
      if (res.status !== 429) {
        this.gate.succeeded()
        return res
      }
      await discard(res)
      const delay = this.gate.rateLimited(parseRetryAfter(res.headers.get('retry-after')), started)
      if (attempt >= this.maxRetries) throw new SourceError('Bandcamp is rate limiting requests', 'rate-limit', delay)
    }
  }

  /** GET a page as text; non-2xx → SourceError. A redirect to /login means the session expired. */
  async text(url: string, signal?: AbortSignal): Promise<{ text: string; url: string }> {
    const res = await this.request(url, { signal, headers: { Accept: 'text/html,application/xhtml+xml,*/*;q=0.8' } })
    if (!res.ok) {
      await discard(res)
      throw statusError(res.status, `GET ${new URL(url).pathname}`)
    }
    const finalUrl = res.url || url
    if (/^\/login\b/.test(safePath(finalUrl)) && !/^\/login\b/.test(safePath(url))) {
      await discard(res)
      throw new SourceError('Bandcamp session expired: please log in again', 'auth')
    }
    return { text: await res.text(), url: finalUrl }
  }

  async postJson(url: string, body: unknown, signal?: AbortSignal): Promise<unknown> {
    const res = await this.request(url, {
      method: 'POST',
      signal,
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/javascript, */*; q=0.01' },
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      await discard(res)
      throw statusError(res.status, `POST ${new URL(url).pathname}`)
    }
    const text = await res.text()
    try {
      return JSON.parse(text)
    } catch {
      throw new SourceError(`POST ${new URL(url).pathname}: response is not JSON`, 'parse')
    }
  }

  /** The logged-in fan (homepage blob, then the fan page as a fallback); null when logged out. */
  async identity(signal?: AbortSignal): Promise<FanIdentity | null> {
    const home = await this.text(`${this.baseUrl}/`, signal)
    let id = parseIdentity(home.text)
    if (id && !id.fanId && (id.fanUrl || id.username)) {
      const fanUrl = id.fanUrl ?? `${this.baseUrl}/${encodeURIComponent(id.username!)}`
      const fan = parseIdentity((await this.text(fanUrl, signal)).text)
      if (fan?.fanId) id = { ...fan, ...id, fanId: fan.fanId }
    }
    return id?.fanId ? id : null
  }

  /** Purchases + hidden purchases, paged on last_token, with merged redownload_urls. */
  async collection(fanId: number, signal?: AbortSignal): Promise<BcCollectionItem[]> {
    const redownloadUrls: Record<string, string> = {}
    const tracklists: Record<string, unknown[]> = {}
    const raw: Array<{ item: unknown; hidden: boolean }> = []
    for (const [endpoint, hidden] of [['collection_items', false], ['hidden_items', true]] as const) {
      let token = `${Math.floor(Date.now() / 1000)}:0:a::`
      try {
        for (let page = 0; page < MAX_PAGES; page++) {
          const json = await this.postJson(
            `${this.baseUrl}/api/fancollection/1/${endpoint}`,
            { fan_id: fanId, older_than_token: token, count: COLLECTION_PAGE },
            signal,
          )
          const p = parseCollectionPage(json)
          Object.assign(redownloadUrls, p.redownloadUrls)
          Object.assign(tracklists, p.tracklists)
          for (const item of p.items) raw.push({ item, hidden })
          if (!p.moreAvailable || !p.items.length || !p.lastToken || p.lastToken === token) break
          token = p.lastToken
        }
      } catch (e) {
        // Hidden items are a nice-to-have; never fail the whole collection over them.
        if (!hidden || (e as SourceError).kind === 'auth' || (e as SourceError).kind === 'cancelled') throw e
      }
    }
    const out: BcCollectionItem[] = []
    const seen = new Set<string>()
    for (const { item, hidden } of raw) {
      const it = toCollectionItem(item, { redownloadUrls, tracklists: tracklists as Record<string, any[]> }, hidden)
      if (!it || seen.has(it.key)) continue
      seen.add(it.key)
      out.push(it)
    }
    return out
  }
}

function safePath(url: string): string {
  try {
    return new URL(url).pathname
  } catch {
    return ''
  }
}
