import { describe, expect, it, vi } from 'vitest'
import { SourceError } from '@main/import/source-types'
import { TOKENS_KEY, TidalAuth, type TidalTokens } from '@main/sources/tidal/auth'
import { classifyError, parseRetryAfter, TidalClient } from '@main/sources/tidal/client'
import { resolveConfig } from '@main/sources/tidal/config'
import { fakeAuth, json, memorySecrets, router, type Call } from '../fixtures/tidal/support'

const cfg = resolveConfig(undefined, { apiV1: 'https://api.test/v1', apiV2: 'https://api.test/v2', authBase: 'https://auth.test/v1/oauth2' })
const EXPIRED = { status: 401, subStatus: 11003, userMessage: 'The token has expired. (Expired on time)' }

async function rejection(p: Promise<unknown>): Promise<SourceError> {
  try {
    await p
  } catch (e) {
    expect(e).toBeInstanceOf(SourceError)
    return e as SourceError
  }
  throw new Error('expected rejection')
}

describe('classifyError', () => {
  const body = (o: unknown) => JSON.stringify(o)
  it.each([
    [404, body({ status: 404, subStatus: 2001, userMessage: 'Album not found' }), 'unavailable'],
    [401, body({ status: 401, subStatus: 4005, userMessage: 'Asset is not ready for playback' }), 'unavailable'],
    [403, body({ status: 403, userMessage: 'This track is not available in your region' }), 'unavailable'],
    [401, body(EXPIRED), 'expired'],
    [401, '', 'expired'],
    [400, body({ status: 400, subStatus: 11002, userMessage: 'Invalid token' }), 'expired'],
    [403, body({ userMessage: 'The token has expired.' }), 'expired'],
    [429, '', 'retry'],
    [500, 'oops', 'retry'],
    [503, body({ userMessage: 'Service not available' }), 'retry'],
    [403, 'Request blocked: abuse detected', 'abuse'],
    [403, body({ userMessage: 'Your account has been suspended' }), 'abuse'],
    [403, '', 'abuse'],
    [400, body({ userMessage: 'Bad request' }), 'unavailable'],
  ])('HTTP %i %s → %s', (status, b, kind) => {
    expect(classifyError(status, b).kind).toBe(kind)
  })

  it('parses Retry-After seconds and dates, capped at 120 s', () => {
    expect(classifyError(429, '', '7')).toMatchObject({ kind: 'retry', retryAfterMs: 7000 })
    expect(parseRetryAfter('999')).toBe(120_000)
    const now = Date.parse('2026-01-01T00:00:00Z')
    expect(parseRetryAfter('Thu, 01 Jan 2026 00:00:30 GMT', now)).toBe(30_000)
    expect(parseRetryAfter('soon')).toBeUndefined()
    expect(parseRetryAfter(null)).toBeUndefined()
  })
})

describe('TidalClient', () => {
  const ok = (c: Call) => (c.url.pathname === '/v1/albums/1' ? json({ id: 1 }) : undefined)

  it('adds auth/client headers, countryCode and locale', async () => {
    const t = router(ok)
    const client = new TidalClient({ cfg, auth: fakeAuth('abc', 'DE'), transport: t })
    expect(await client.get('albums/1', { limit: 5, skip: undefined })).toEqual({ id: 1 })
    const c = t.calls[0]
    expect(c.headers.authorization).toBe('Bearer abc')
    expect(c.headers['x-tidal-client-version']).toBe(cfg.clientVersion)
    expect(c.headers['user-agent']).toContain('Android')
    expect(c.url.searchParams.get('countryCode')).toBe('DE')
    expect(c.url.searchParams.get('locale')).toBe('en_US')
    expect(c.url.searchParams.get('limit')).toBe('5')
    expect(c.url.searchParams.has('skip')).toBe(false)
  })

  it('caches browse calls for ~5 minutes only when asked', async () => {
    let now = 1_000
    const t = router(ok)
    const client = new TidalClient({ cfg, auth: fakeAuth(), transport: t, now: () => now })
    await client.get('albums/1', {}, { cache: true })
    await client.get('albums/1', {}, { cache: true })
    expect(t.calls).toHaveLength(1)
    await client.get('albums/1')
    expect(t.calls).toHaveLength(2)
    now += 5 * 60_000 + 1
    await client.get('albums/1', {}, { cache: true })
    expect(t.calls).toHaveLength(3)
    client.clearCache()
    await client.get('albums/1', {}, { cache: true })
    expect(t.calls).toHaveLength(4)
  })

  it('backs off on 429 honouring Retry-After, then succeeds', async () => {
    let n = 0
    const t = router((c) => (c.url.pathname === '/v1/albums/1' ? (n++ === 0 ? new Response('', { status: 429, headers: { 'retry-after': '2' } }) : json({ id: 1 })) : undefined))
    const sleep = vi.fn(async () => {})
    const client = new TidalClient({ cfg, auth: fakeAuth(), transport: t, sleep })
    expect(await client.get('albums/1')).toEqual({ id: 1 })
    expect(sleep).toHaveBeenCalledTimes(1)
    expect((sleep.mock.calls[0] as unknown[])[0]).toBe(2000)
  })

  it('gives up after 4 tries on 5xx with rate-limit, capping waits at 120 s', async () => {
    const t = router(() => new Response('down', { status: 503, headers: { 'retry-after': '600' } }))
    const sleep = vi.fn(async () => {})
    const client = new TidalClient({ cfg, auth: fakeAuth(), transport: t, sleep })
    const e = await rejection(client.get('albums/1'))
    expect(e.kind).toBe('rate-limit')
    expect(e.retryAfterMs).toBe(120_000)
    expect(t.calls).toHaveLength(4)
    expect(sleep.mock.calls.map((c) => (c as unknown[])[0])).toEqual([120_000, 120_000, 120_000])
  })

  it('retries network errors, then reports network', async () => {
    const t = router(() => {
      throw new TypeError('fetch failed')
    })
    const client = new TidalClient({ cfg, auth: fakeAuth(), transport: t, sleep: async () => {} })
    expect((await rejection(client.get('albums/1'))).kind).toBe('network')
    expect(t.calls).toHaveLength(4)
  })

  it('maps 404 / 4005 to unavailable and 403 to abuse (notifying once)', async () => {
    const onAbuse = vi.fn()
    const t = router(
      (c) => (c.url.pathname.endsWith('/404') ? json({ status: 404 }, 404) : undefined),
      (c) => (c.url.pathname.endsWith('/4005') ? json({ status: 401, subStatus: 4005, userMessage: 'Asset is not ready for playback' }, 401) : undefined),
      () => new Response('Forbidden', { status: 403 }),
    )
    const client = new TidalClient({ cfg, auth: fakeAuth(), transport: t, onAbuse })
    expect((await rejection(client.get('x/404'))).kind).toBe('unavailable')
    expect((await rejection(client.get('x/4005'))).kind).toBe('unavailable')
    expect((await rejection(client.get('x/403'))).kind).toBe('abuse')
    expect(onAbuse).toHaveBeenCalledTimes(1)
  })

  it('reports cancelled when the signal is already aborted', async () => {
    const ctrl = new AbortController()
    ctrl.abort()
    const client = new TidalClient({ cfg, auth: fakeAuth(), transport: router(ok) })
    expect((await rejection(client.get('albums/1', {}, { signal: ctrl.signal }))).kind).toBe('cancelled')
  })
})

describe('TidalClient + TidalAuth refresh', () => {
  const NOW = 1_700_000_000_000
  const tokens = (over: Partial<TidalTokens> = {}): TidalTokens => ({
    accessToken: 'old-access',
    refreshToken: 'refresh-1',
    tokenType: 'Bearer',
    expiresAt: NOW + 3_600_000,
    userId: '42',
    countryCode: 'US',
    clientId: 'client-x',
    clientSecret: 'secret-x',
    ...over,
  })

  function setup(initial: TidalTokens, tokenRoute?: (c: Call) => Response) {
    const secrets = memorySecrets({ [TOKENS_KEY]: JSON.stringify(initial) })
    const posts: URLSearchParams[] = []
    let issued = 0
    const t = router(
      (c) => {
        if (c.url.href !== 'https://auth.test/v1/oauth2/token') return undefined
        posts.push(new URLSearchParams(c.body))
        if (tokenRoute) return tokenRoute(c)
        issued++
        return json({ access_token: `new-access-${issued}`, refresh_token: `refresh-${issued + 1}`, token_type: 'Bearer', expires_in: 3600 })
      },
      (c) => {
        if (c.url.pathname !== '/v1/albums/1') return undefined
        return c.headers.authorization.startsWith('Bearer new-access') ? json({ id: 1 }) : json(EXPIRED, 401)
      },
    )
    const auth = new TidalAuth({ cfg, secrets, transport: t, now: () => NOW })
    const client = new TidalClient({ cfg, auth, transport: t, now: () => NOW, sleep: async () => {} })
    return { secrets, t, posts, auth, client, stored: () => JSON.parse(secrets.get(TOKENS_KEY) ?? 'null') as TidalTokens | null }
  }

  it('refreshes once on an expired token, retries, and persists the rotated refresh token', async () => {
    const s = setup(tokens())
    expect(await s.client.get('albums/1')).toEqual({ id: 1 })
    expect(s.posts).toHaveLength(1)
    expect(Object.fromEntries(s.posts[0])).toMatchObject({
      grant_type: 'refresh_token',
      refresh_token: 'refresh-1',
      client_id: 'client-x',
      client_secret: 'secret-x',
    })
    const api = s.t.calls.filter((c) => c.url.pathname === '/v1/albums/1').map((c) => c.headers.authorization)
    expect(api).toEqual(['Bearer old-access', 'Bearer new-access-1'])
    expect(s.stored()).toMatchObject({ accessToken: 'new-access-1', refreshToken: 'refresh-2', expiresAt: NOW + 3_600_000 })
  })

  it('keeps the old refresh token when TIDAL does not rotate it', async () => {
    const s = setup(tokens(), () => json({ access_token: 'new-access-z', token_type: 'Bearer', expires_in: 60 }))
    await s.client.get('albums/1')
    expect(s.stored()).toMatchObject({ accessToken: 'new-access-z', refreshToken: 'refresh-1' })
  })

  it('single-flights concurrent refreshes', async () => {
    const s = setup(tokens())
    await Promise.all([s.client.get('albums/1'), s.client.get('albums/1'), s.client.get('albums/1')])
    expect(s.posts).toHaveLength(1)
    expect(s.stored()?.refreshToken).toBe('refresh-2')
  })

  it('refreshes proactively before expiry without a 401 round-trip', async () => {
    const s = setup(tokens({ expiresAt: NOW + 30_000 }))
    await s.client.get('albums/1')
    expect(s.posts).toHaveLength(1)
    expect(s.t.calls.filter((c) => c.url.pathname === '/v1/albums/1')).toHaveLength(1)
  })

  it('reports auth when the retried request is still expired', async () => {
    const s = setup(tokens())
    s.t.calls.length = 0
    const still = router((c) => (c.url.pathname === '/v1/albums/1' ? json(EXPIRED, 401) : json({ access_token: 'n', refresh_token: 'r', expires_in: 3600 })))
    const auth = new TidalAuth({ cfg, secrets: s.secrets, transport: still, now: () => NOW })
    const client = new TidalClient({ cfg, auth, transport: still, now: () => NOW })
    expect((await rejection(client.get('albums/1'))).kind).toBe('auth')
    expect(still.calls.filter((c) => c.url.pathname === '/v1/albums/1')).toHaveLength(2)
  })

  it('reports auth and clears tokens when the refresh token is rejected', async () => {
    const s = setup(tokens(), () => json({ error: 'invalid_grant', error_description: 'Refresh token expired' }, 400))
    const e = await rejection(s.client.get('albums/1'))
    expect(e.kind).toBe('auth')
    expect(s.stored()).toBeNull()
    expect(s.auth.status()).toEqual({ loggedIn: false, userId: null, countryCode: null })
  })
})
