import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BandcampClient, parseRetryAfter, RateGate } from '@main/sources/bandcamp/client'
import { SourceError } from '@main/import/source-types'
import { fakeTransport, fixture, fixtureJson, html, json } from '../fixtures/bandcamp/helpers'

describe('collection paging', () => {
  it('pages collection_items on last_token, adds hidden_items and merges redownload_urls', async () => {
    const t = fakeTransport((url, call) => {
      const body = JSON.parse(call.body ?? '{}')
      if (url.pathname === '/api/fancollection/1/collection_items') {
        return json(body.older_than_token === '1700000000:2002:t::' ? fixtureJson('collection-2.json') : fixtureJson('collection-1.json'))
      }
      if (url.pathname === '/api/fancollection/1/hidden_items') return json(fixtureJson('hidden-1.json'))
    })
    const client = new BandcampClient({ transport: t, gate: new RateGate() })
    const items = await client.collection(5550001)

    const posts = t.calls.map((c) => ({ path: new URL(c.url).pathname, method: c.method, body: JSON.parse(c.body!) }))
    expect(posts).toHaveLength(3)
    expect(posts[0]).toMatchObject({ path: '/api/fancollection/1/collection_items', method: 'POST', body: { fan_id: 5550001, count: 100 } })
    expect(posts[0].body.older_than_token).toMatch(/^\d{10}:0:a::$/)
    expect(posts[1].body.older_than_token).toBe('1700000000:2002:t::')
    expect(posts[2].path).toBe('/api/fancollection/1/hidden_items')
    expect(t.calls[0].headers['content-type']).toBe('application/json')

    expect(items.map((i) => i.key)).toEqual(['a9001', 't9002', 'p9003', 'p9004', 'a9005', 'a9006'])
    const byKey = Object.fromEntries(items.map((i) => [i.key, i]))
    // a9001's url only appears on page 2.
    expect(byKey.a9001.redownloadUrl).toBe('https://bandcamp.com/download?from=collection&payment_id=1&sig=aaa&sitem_id=9001')
    expect(byKey.a9001.downloadable).toBe(true)
    expect(byKey.p9003.physicalOnly).toBe(true)
    expect(byKey.a9005.preorder).toBe(true)
    expect(byKey.a9005.downloadable).toBe(false)
    expect(byKey.a9006).toMatchObject({ hidden: true, downloadable: true })
    expect(items.filter((i) => i.hidden).map((i) => i.key)).toEqual(['a9006'])
  })

  it('stops when the token does not advance', async () => {
    const page = { ...fixtureJson('collection-1.json'), last_token: null }
    const t = fakeTransport((url) => (url.pathname.endsWith('collection_items') ? json(page) : json({ items: [], more_available: false })))
    const items = await new BandcampClient({ transport: t, gate: new RateGate() }).collection(1)
    expect(t.calls).toHaveLength(2)
    expect(items).toHaveLength(2)
  })

  it('keeps the collection when hidden_items fails', async () => {
    const t = fakeTransport((url) => (url.pathname.endsWith('collection_items') ? json(fixtureJson('collection-2.json')) : new Response('x', { status: 500 })))
    const items = await new BandcampClient({ transport: t, gate: new RateGate() }).collection(1)
    expect(items).toHaveLength(3)
  })

  it('maps 401/403 to auth errors', async () => {
    const t = fakeTransport(() => new Response('no', { status: 403 }))
    await expect(new BandcampClient({ transport: t, gate: new RateGate() }).collection(1)).rejects.toMatchObject({ kind: 'auth' })
  })
})

describe('identity', () => {
  it('reads the homepage blob', async () => {
    const t = fakeTransport((url) => (url.pathname === '/' ? html(fixture('homepage.html')) : undefined))
    expect(await new BandcampClient({ transport: t, gate: new RateGate() }).identity()).toMatchObject({ fanId: 5550001, username: 'synthfan' })
  })

  it('falls back to the fan page when only the username is known', async () => {
    const home = `<div id="HomepageApp" data-blob="{&quot;pageContext&quot;:{&quot;identity&quot;:{&quot;username&quot;:&quot;synthfan&quot;}}}"></div>`
    const t = fakeTransport((url) => (url.pathname === '/' ? html(home) : url.pathname === '/synthfan' ? html(fixture('fan-page.html')) : undefined))
    expect(await new BandcampClient({ transport: t, gate: new RateGate() }).identity()).toMatchObject({ fanId: 5550001, username: 'synthfan' })
    expect(t.calls.map((c) => new URL(c.url).pathname)).toEqual(['/', '/synthfan'])
  })

  it('is null when logged out', async () => {
    const t = fakeTransport(() => html(fixture('homepage-logged-out.html')))
    expect(await new BandcampClient({ transport: t, gate: new RateGate() }).identity()).toBeNull()
  })

  it('treats a redirect to /login as an expired session', async () => {
    const t = fakeTransport(() => {
      const r = html('<form>login</form>')
      Object.defineProperty(r, 'url', { value: 'https://bandcamp.com/login?from=download' })
      return r
    })
    await expect(new BandcampClient({ transport: t, gate: new RateGate() }).text('https://bandcamp.com/download?x=1')).rejects.toMatchObject({ kind: 'auth' })
  })
})

describe('429 gate', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
  })
  afterEach(() => vi.useRealTimers())

  it('parses Retry-After seconds and dates', () => {
    expect(parseRetryAfter('120')).toBe(120_000)
    expect(parseRetryAfter(new Date(Date.now() + 30_000).toUTCString())).toBe(30_000)
    expect(parseRetryAfter('garbage')).toBeUndefined()
    expect(parseRetryAfter(null)).toBeUndefined()
  })

  it('backs off exponentially and resets on success', () => {
    const g = new RateGate({ baseMs: 1000, maxMs: 5000 })
    expect(g.rateLimited()).toBe(1000)
    vi.advanceTimersByTime(1000)
    expect(g.rateLimited()).toBe(2000)
    vi.advanceTimersByTime(2000)
    expect(g.rateLimited()).toBe(4000)
    vi.advanceTimersByTime(4000)
    expect(g.rateLimited()).toBe(5000)
    g.succeeded()
    vi.advanceTimersByTime(5000)
    expect(g.rateLimited()).toBe(1000)
  })

  it('honors a longer Retry-After and does not escalate for concurrent 429s', () => {
    const g = new RateGate({ baseMs: 1000 })
    const started = Date.now()
    expect(g.rateLimited(30_000, started)).toBe(30_000)
    expect(g.rateLimited(undefined, started)).toBe(30_000)
    expect(g.strikeCount).toBe(1)
  })

  it('holds every request back while closed, then retries', async () => {
    let n = 0
    const t = fakeTransport((url) => {
      if (url.pathname === '/limited' && ++n === 1) return new Response('slow down', { status: 429, headers: { 'retry-after': '20' } })
      return html('ok')
    })
    const client = new BandcampClient({ transport: t, gate: new RateGate({ baseMs: 5000 }) })
    const first = client.text('https://bandcamp.com/limited')
    await vi.advanceTimersByTimeAsync(0)
    expect(t.calls).toHaveLength(1)
    expect(client.gate.remaining()).toBe(20_000)

    // A second request issued while the gate is closed waits too.
    const second = client.text('https://bandcamp.com/other')
    await vi.advanceTimersByTimeAsync(19_000)
    expect(t.calls).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1_000)
    expect((await first).text).toBe('ok')
    expect((await second).text).toBe('ok')
    expect(t.calls.map((c) => new URL(c.url).pathname).sort()).toEqual(['/limited', '/limited', '/other'])
    expect(client.gate.strikeCount).toBe(0)
  })

  it('gives up with a rate-limit error after too many 429s', async () => {
    const t = fakeTransport(() => new Response('no', { status: 429 }))
    const client = new BandcampClient({ transport: t, gate: new RateGate({ baseMs: 1000, maxMs: 4000 }), maxRateLimitRetries: 3 })
    const p = client.text('https://bandcamp.com/x').catch((e) => e)
    await vi.advanceTimersByTimeAsync(60_000)
    const err = await p
    expect(err).toBeInstanceOf(SourceError)
    expect(err.kind).toBe('rate-limit')
    expect(err.retryAfterMs).toBe(4000)
    expect(t.calls).toHaveLength(4)
  })

  it('cancels a gated wait on abort', async () => {
    const gate = new RateGate({ baseMs: 60_000 })
    gate.rateLimited()
    const ac = new AbortController()
    const p = gate.wait(ac.signal).catch((e) => e)
    ac.abort()
    expect(await p).toMatchObject({ kind: 'cancelled' })
  })
})
