// Test-only helpers for the TIDAL suites (fake transport, stores, context). SYNTHETIC data only.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AppContext, BadgeQueryAlbum, BadgeQueryTrack, EnqueueRequest, SecretStore, SettingsStore } from '@main/context'
import type { Transport } from '@main/import/source-types'

export const FIXTURES = join(import.meta.dirname, '.')

export function fixture<T = any>(name: string): T {
  return JSON.parse(readFileSync(join(FIXTURES, name), 'utf8')) as T
}

export function fixtureText(name: string): string {
  return readFileSync(join(FIXTURES, name), 'utf8')
}

export function memorySecrets(initial: Record<string, string> = {}): SecretStore & { data: Map<string, string> } {
  const data = new Map(Object.entries(initial))
  return {
    data,
    get: (k) => data.get(k) ?? null,
    set: (k, v) => {
      if (v === null) data.delete(k)
      else data.set(k, v)
    },
  }
}

export function memorySettings(initial: Record<string, unknown> = {}): SettingsStore {
  const values = new Map(Object.entries(initial))
  return {
    get: <T>(k: string, fb: T) => (values.has(k) ? (values.get(k) as T) : fb),
    set: (k, v) => void values.set(k, v),
    onChange: () => () => {},
  }
}

export interface Call {
  url: URL
  method: string
  headers: Record<string, string>
  body: string
}

export type Route = (call: Call) => Response | Promise<Response> | undefined

export const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })

/** Fake transport: tries routes in order; records every call. Unmatched calls answer 599. */
export function router(...routes: Route[]): Transport & { calls: Call[] } {
  const calls: Call[] = []
  const t = (async (input: string, init: RequestInit = {}) => {
    const headers: Record<string, string> = {}
    for (const [k, v] of Object.entries((init.headers as Record<string, string>) ?? {})) headers[k.toLowerCase()] = v
    const call: Call = { url: new URL(input), method: init.method ?? 'GET', headers, body: typeof init.body === 'string' ? init.body : '' }
    calls.push(call)
    for (const r of routes) {
      const res = await r(call)
      if (res) return res
    }
    return new Response(`no route for ${call.method} ${call.url}`, { status: 599 })
  }) as Transport & { calls: Call[] }
  t.calls = calls
  return t
}

/** Static auth provider for client/api tests. */
export function fakeAuth(token = 'tok', countryCode = 'US', userId = '42') {
  return {
    accessToken: async () => token,
    refresh: async () => ({ accessToken: token }),
    session: () => ({ userId, countryCode }),
  }
}

export interface FakeContext extends AppContext {
  enqueued: EnqueueRequest[]
  mirrored: Array<{ name: string; sourceKey: string; tracks: BadgeQueryTrack[] }>
}

/** Minimal AppContext; `inLibrary` decides which tidal track ids count as present. */
export function fakeContext(inLibrary: (q: BadgeQueryTrack) => boolean = () => false, active = new Map<string, 'queued' | 'running'>()): FakeContext {
  const enqueued: EnqueueRequest[] = []
  const mirrored: FakeContext['mirrored'] = []
  const badge = (a: BadgeQueryAlbum) => {
    const have = (a.tracks ?? []).filter(inLibrary).length
    const total = a.trackCount ?? a.tracks?.length ?? 0
    return { status: have === 0 ? ('missing' as const) : have >= total ? ('in-library' as const) : ('partial' as const), have, total }
  }
  return {
    enqueued,
    mirrored,
    env: {} as AppContext['env'],
    settings: memorySettings(),
    secrets: memorySecrets(),
    library: { matchTracks: (ts) => ts.map(inLibrary), albumBadge: badge, albumBadges: (as) => as.map(badge) },
    imports: {
      registerAcquirer: () => {},
      enqueue: (req) => {
        enqueued.push(req)
        return `job-${enqueued.length}`
      },
      activeKeys: () => active,
      pauseSource: () => {},
      resumeSource: () => {},
    },
    playlists: { mirror: (req) => void mirrored.push(req) },
    broadcast: () => {},
    log: { info: () => {}, warn: () => {}, error: () => {} },
  }
}
