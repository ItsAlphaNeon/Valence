import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RateLimiter, memoryCache } from '@main/metadata'
import { fetchJson } from '@main/metadata/http'

describe('RateLimiter', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(0) })
  afterEach(() => vi.useRealTimers())

  it('serial limiter spaces starts by 1.1 s and waits for the previous task', async () => {
    const lim = new RateLimiter(1100, true)
    const starts: number[] = []
    const task = (ms: number) => () => { starts.push(Date.now()); return new Promise<void>((r) => setTimeout(r, ms)) }
    const all = Promise.all([lim.schedule(task(10)), lim.schedule(task(2000)), lim.schedule(task(10)), lim.schedule(task(10))])
    await vi.advanceTimersByTimeAsync(10_000)
    await all
    // third task waits for the slow second one (starts 1100 + 2000)
    expect(starts).toEqual([0, 1100, 3100, 4200])
  })

  it('non-serial limiter only spaces start times (3/s)', async () => {
    const lim = new RateLimiter(334)
    const starts: number[] = []
    const all = Promise.all([0, 1, 2, 3].map(() => lim.schedule(async () => { starts.push(Date.now()) })))
    await vi.advanceTimersByTimeAsync(2000)
    await all
    expect(starts).toEqual([0, 334, 668, 1002])
  })

  it('delay() pushes the next slot back', async () => {
    const lim = new RateLimiter(500)
    const starts: number[] = []
    await lim.schedule(async () => { starts.push(Date.now()) })
    lim.delay(3000)
    const p = lim.schedule(async () => { starts.push(Date.now()) })
    await vi.advanceTimersByTimeAsync(5000)
    await p
    expect(starts).toEqual([0, 3000])
  })

  it('fetchJson retries 503 with Retry-After backoff, then caches', async () => {
    const lim = new RateLimiter(1100, true)
    const times: number[] = []
    let n = 0
    const transport = async () => {
      times.push(Date.now())
      return ++n < 3 ? new Response('busy', { status: 503, headers: { 'Retry-After': '2' } }) : new Response('{"ok":1}', { status: 200 })
    }
    const cache = memoryCache()
    const p = fetchJson({ transport, cache }, 'https://musicbrainz.org/ws/2/x', { limiter: lim })
    await vi.advanceTimersByTimeAsync(20_000)
    expect(await p).toEqual({ ok: 1 })
    expect(times).toEqual([0, 2000, 4000])
    expect(await fetchJson({ transport, cache }, 'https://musicbrainz.org/ws/2/x', { limiter: lim })).toEqual({ ok: 1 })
    expect(n).toBe(3)
  })

  it('fetchJson returns null on 404 and caches the miss', async () => {
    let n = 0
    const transport = async () => { n++; return new Response('nope', { status: 404 }) }
    const cache = memoryCache()
    const lim = new RateLimiter(0)
    expect(await fetchJson({ transport, cache }, 'u', { limiter: lim })).toBeNull()
    expect(await fetchJson({ transport, cache }, 'u', { limiter: lim })).toBeNull()
    expect(n).toBe(1)
  })
})
