// Authenticated TIDAL API client: adds auth/client headers and countryCode/locale, classifies
// failures into SourceError kinds, refreshes once on token expiry, backs off on 429/5xx, and keeps
// a short in-memory cache for browse calls.

import { SourceError, type Transport } from '../../import/source-types'
import type { TidalConfig } from './config'
import { abortableSleep, cancelled } from './util'

export interface AuthProvider {
  accessToken(): Promise<string>
  refresh(stale?: string): Promise<{ accessToken: string }>
  session(): { userId: string; countryCode: string } | null
}

export type Params = Record<string, string | number | boolean | null | undefined>

export type Classified =
  | { kind: 'expired'; message: string }
  | { kind: 'retry'; message: string; retryAfterMs?: number }
  | { kind: 'unavailable' | 'abuse' | 'auth'; message: string }

export const MAX_TRIES = 4
export const MAX_RETRY_AFTER_MS = 120_000
export const CACHE_TTL_MS = 5 * 60_000
const CACHE_MAX = 300

/** Retry-After as ms (delta-seconds or HTTP-date), capped at 120 s. */
export function parseRetryAfter(value: string | null | undefined, now = Date.now()): number | undefined {
  if (!value) return undefined
  const v = value.trim()
  let ms: number
  if (/^\d+(\.\d+)?$/.test(v)) ms = Number(v) * 1000
  else {
    const at = Date.parse(v)
    if (Number.isNaN(at)) return undefined
    ms = at - now
  }
  return Math.min(Math.max(0, ms), MAX_RETRY_AFTER_MS)
}

/** Maps a failed TIDAL response to what the client should do about it. */
export function classifyError(status: number, body: string, retryAfter?: string | null, now = Date.now()): Classified {
  let j: any = {}
  try {
    j = body ? JSON.parse(body) : {}
  } catch {
    j = {}
  }
  if (typeof j !== 'object' || j === null) j = {}
  const sub = Number(j.subStatus ?? j.sub_status) || 0
  const detail = String(j.userMessage ?? j.error_description ?? j.errors?.[0]?.detail ?? j.error ?? (body || '')).slice(0, 300)
  const message = `TIDAL HTTP ${status}${sub ? `/${sub}` : ''}: ${detail || 'no details'}`
  const text = `${detail} ${body}`.toLowerCase()

  if (status === 404) return { kind: 'unavailable', message }
  if (status === 429 || status >= 500) return { kind: 'retry', message, retryAfterMs: parseRetryAfter(retryAfter, now) }
  if (sub === 4005 || /not (?:be )?available|not ready for playback|not streamable/.test(text)) return { kind: 'unavailable', message }
  if (status === 401 || text.includes('token has expired') || (sub >= 11000 && sub <= 11999)) return { kind: 'expired', message }
  // Anything else TIDAL forbids without a known reason is treated as an anti-abuse signal.
  if (status === 403) return { kind: 'abuse', message }
  return { kind: 'unavailable', message }
}

export interface RequestOptions {
  base?: 'v1' | 'v2'
  /** Use the browse cache (default false). */
  cache?: boolean
  signal?: AbortSignal
}

export interface TidalClientDeps {
  cfg: TidalConfig
  auth: AuthProvider
  transport: Transport
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
  now?: () => number
  random?: () => number
  cacheTtlMs?: number
  /** Called once per abuse classification (e.g. to pause the download queue). */
  onAbuse?: (message: string) => void
}

export class TidalClient {
  private readonly cache = new Map<string, { at: number; value: unknown }>()
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>
  private readonly now: () => number
  private readonly random: () => number

  constructor(private readonly deps: TidalClientDeps) {
    this.sleep = deps.sleep ?? abortableSleep
    this.now = deps.now ?? Date.now
    this.random = deps.random ?? Math.random
  }

  url(path: string, params: Params = {}, base: 'v1' | 'v2' = 'v1'): string {
    const root = base === 'v2' ? this.deps.cfg.apiV2 : this.deps.cfg.apiV1
    const q = new URLSearchParams()
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) q.set(k, String(v))
    if (!q.has('countryCode')) q.set('countryCode', this.deps.auth.session()?.countryCode || 'US')
    if (!q.has('locale')) q.set('locale', this.deps.cfg.locale)
    return `${root.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}?${q}`
  }

  async get<T>(path: string, params: Params = {}, opts: RequestOptions = {}): Promise<T> {
    const url = this.url(path, params, opts.base)
    if (opts.cache) {
      const hit = this.cache.get(url)
      if (hit && this.now() - hit.at < (this.deps.cacheTtlMs ?? CACHE_TTL_MS)) return hit.value as T
    }
    const res = await this.request(url, { method: 'GET' }, opts.signal)
    let value: T
    try {
      value = (await res.json()) as T
    } catch (e) {
      throw new SourceError(`TIDAL returned invalid JSON for ${path}: ${(e as Error).message}`, 'parse')
    }
    if (opts.cache) {
      if (this.cache.size >= CACHE_MAX) this.cache.delete(this.cache.keys().next().value!)
      this.cache.set(url, { at: this.now(), value })
    }
    return value
  }

  clearCache(): void {
    this.cache.clear()
  }

  private backoff(tries: number, status: number): number {
    const base = status === 429 ? 15_000 : 1_000
    return Math.min(MAX_RETRY_AFTER_MS, base * 2 ** (tries - 1) * (1 + this.random() * 0.25))
  }

  /** Sends one logical request, handling refresh-and-retry and backoff. Resolves with an ok Response. */
  async request(url: string, init: RequestInit, signal?: AbortSignal): Promise<Response> {
    const { cfg, auth, transport } = this.deps
    let refreshed = false
    let tries = 0
    for (;;) {
      if (signal?.aborted) throw cancelled()
      const token = await auth.accessToken()
      let res: Response
      try {
        res = await transport(url, {
          ...init,
          signal,
          headers: {
            accept: 'application/json',
            authorization: `Bearer ${token}`,
            'x-tidal-client-version': cfg.clientVersion,
            'User-Agent': cfg.userAgent,
            ...(init.headers as Record<string, string> | undefined),
          },
        })
      } catch (e) {
        if (signal?.aborted) throw cancelled()
        if (++tries >= MAX_TRIES) throw new SourceError(`TIDAL request failed: ${(e as Error).message}`, 'network')
        await this.sleep(this.backoff(tries, 0), signal)
        continue
      }
      if (res.ok) return res

      const body = await res.text().catch(() => '')
      const c = classifyError(res.status, body, res.headers.get('retry-after'), this.now())
      if (c.kind === 'expired') {
        if (refreshed) throw new SourceError(c.message, 'auth')
        refreshed = true
        try {
          await auth.refresh(token)
        } catch (e) {
          if (e instanceof SourceError && (e.kind === 'network' || e.kind === 'rate-limit' || e.kind === 'cancelled')) throw e
          throw new SourceError(`TIDAL session expired and could not be refreshed: ${(e as Error).message}`, 'auth')
        }
        continue
      }
      if (c.kind === 'retry') {
        tries++
        const wait = Math.min(c.retryAfterMs ?? this.backoff(tries, res.status), MAX_RETRY_AFTER_MS)
        if (tries >= MAX_TRIES) throw new SourceError(c.message, 'rate-limit', c.retryAfterMs ?? 60_000)
        await this.sleep(wait, signal)
        continue
      }
      if (c.kind === 'abuse') this.deps.onAbuse?.(c.message)
      throw new SourceError(c.message, c.kind)
    }
  }
}
