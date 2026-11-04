import { describe, expect, it } from 'vitest'
import { PlayQueue, adjacentSameArtist, shuffleOrder } from '@renderer/audio/queue'
import type { PlayItem } from '@renderer/audio/types'

function rng(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 2 ** 32
  }
}

const item = (id: string, artist = 'A', extra: Partial<PlayItem> = {}): PlayItem => ({
  id,
  path: `/m/${id}.flac`,
  title: id,
  artist,
  album: 'X',
  durationMs: 180000,
  ...extra,
})

const album = (n: number, artist = 'A') => Array.from({ length: n }, (_, i) => item(`t${i + 1}`, artist, { trackNo: i + 1, albumKey: 'x' }))
const ids = (xs: readonly PlayItem[]) => xs.map((x) => x.id)

describe('shuffle', () => {
  const mixed = Array.from({ length: 20 }, (_, i) => item(`m${i}`, `artist${i % 4}`))

  it('is a permutation with the current track first', () => {
    for (let seed = 1; seed < 100; seed++) {
      const first = seed % mixed.length
      const order = shuffleOrder(mixed, first, rng(seed))
      expect(order[0]).toBe(first)
      expect([...order].sort((a, b) => a - b)).toEqual(mixed.map((_, i) => i))
    }
  })

  it('spreads artists (no adjacent same-artist pairs when avoidable)', () => {
    for (let seed = 1; seed < 200; seed++) {
      const order = shuffleOrder(mixed, seed % 20, rng(seed))
      expect(adjacentSameArtist(mixed, order)).toBe(0)
    }
  })

  it('keeps a dominated list close to the minimum number of repeats', () => {
    const dom = [...Array.from({ length: 12 }, (_, i) => item(`a${i}`, 'A')), ...Array.from({ length: 4 }, (_, i) => item(`b${i}`, 'B'))]
    for (let seed = 1; seed < 100; seed++) {
      const order = shuffleOrder(dom, null, rng(seed))
      expect(adjacentSameArtist(dom, order)).toBeLessThanOrEqual(12 - 4 - 1 + 1)
    }
  })

  it('produces different orders for different seeds', () => {
    const a = shuffleOrder(mixed, 0, rng(1)).join()
    const b = shuffleOrder(mixed, 0, rng(2)).join()
    expect(a).not.toBe(b)
  })

  it('toggling keeps the current track and restores album order when off', () => {
    const q = new PlayQueue(rng(9))
    q.setContext(album(10), 3)
    q.setShuffle(true)
    expect(q.current!.id).toBe('t4')
    expect(q.position).toBe(0)
    const order = ids(q.playOrder)
    expect(order[0]).toBe('t4')
    expect(new Set(order).size).toBe(10)
    q.next()
    const now = q.current!.id
    q.setShuffle(false)
    expect(q.current!.id).toBe(now)
    const k = Number(now.slice(1))
    expect(q.peekNext()?.id ?? null).toBe(k < 10 ? `t${k + 1}` : null)
  })

  it('shuffled playback visits every track exactly once', () => {
    const q = new PlayQueue(rng(4))
    q.setShuffle(true)
    q.setContext(mixed, 5)
    const seen = [q.current!.id]
    let n: PlayItem | null
    while ((n = q.next(true))) seen.push(n.id)
    expect(seen[0]).toBe('m5')
    expect(new Set(seen).size).toBe(20)
    expect(seen).toHaveLength(20)
  })
})

describe('repeat', () => {
  it('off: stops at the end; all: wraps; one: repeats on auto, advances on manual next', () => {
    const q = new PlayQueue()
    q.setContext(album(3), 2)
    expect(q.peekNext()).toBeNull()
    expect(q.next(true)).toBeNull()
    expect(q.current!.id).toBe('t3')
    q.setRepeat('all')
    expect(q.peekNext()!.id).toBe('t1')
    expect(q.next(true)!.id).toBe('t1')
    q.setRepeat('one')
    expect(q.peekNext()!.id).toBe('t1')
    expect(q.next(true)!.id).toBe('t1')
    expect(q.next(false)!.id).toBe('t2')
  })
})

describe('prev rule', () => {
  it('restarts when more than 3 s in, otherwise goes back', () => {
    const q = new PlayQueue()
    q.setContext(album(5), 2)
    expect(q.prev(3500)).toEqual({ item: q.current, restart: true })
    expect(q.prev(1000).item!.id).toBe('t2')
    expect(q.prev(0).item!.id).toBe('t1')
    expect(q.prev(0)).toMatchObject({ restart: true })
    expect(q.current!.id).toBe('t1')
  })

  it('follows history and returns to where it left', () => {
    const q = new PlayQueue()
    q.setContext(album(5), 0)
    q.next()
    q.next()
    expect(q.current!.id).toBe('t3')
    q.prev(0)
    expect(q.current!.id).toBe('t2')
    expect(q.next()!.id).toBe('t3')
  })

  it('wraps to the last track with repeat all', () => {
    const q = new PlayQueue()
    q.setRepeat('all')
    q.setContext(album(4), 0)
    expect(q.prev(0).item!.id).toBe('t4')
  })
})

describe('Up Next', () => {
  it('takes priority over the context and the context resumes afterwards', () => {
    const q = new PlayQueue()
    q.setContext(album(4), 0)
    q.addToQueue([item('u1'), item('u2')])
    q.playNext([item('n1')])
    expect(ids(q.upNext)).toEqual(['n1', 'u1', 'u2'])
    expect(q.peekNext()!.id).toBe('n1')
    expect(q.next()!.id).toBe('n1')
    expect(q.currentFromUpNext).toBe(true)
    expect(q.next()!.id).toBe('u1')
    expect(q.next()!.id).toBe('u2')
    expect(q.next()!.id).toBe('t2')
    expect(q.upNext).toHaveLength(0)
  })

  it('beats repeat-one on manual next but not on auto advance', () => {
    const q = new PlayQueue()
    q.setRepeat('one')
    q.setContext(album(3), 0)
    q.addToQueue([item('u1')])
    expect(q.peekNext()!.id).toBe('t1')
    expect(q.next(false)!.id).toBe('u1')
  })

  it('going back from an Up Next item puts it back at the front', () => {
    const q = new PlayQueue()
    q.setContext(album(3), 0)
    q.addToQueue([item('u1')])
    q.next()
    expect(q.current!.id).toBe('u1')
    q.prev(0)
    expect(q.current!.id).toBe('t1')
    expect(ids(q.upNext)).toEqual(['u1'])
    expect(q.next()!.id).toBe('u1')
    expect(q.next()!.id).toBe('t2')
  })

  it('back from a context track to an Up Next item, then forward returns to it', () => {
    const q = new PlayQueue()
    q.setContext(album(4), 0)
    q.addToQueue([item('u1')])
    q.next()
    q.next()
    expect(q.current!.id).toBe('t2')
    q.prev(0)
    expect(q.current!.id).toBe('u1')
    expect(q.next()!.id).toBe('t2')
  })

  it('playUpNextAt drops earlier items; remove/move/clear edit the list', () => {
    const q = new PlayQueue()
    q.setContext(album(2), 0)
    q.addToQueue([item('a'), item('b'), item('c'), item('d')])
    q.moveUpNext(3, 0)
    expect(ids(q.upNext)).toEqual(['d', 'a', 'b', 'c'])
    q.removeUpNext(1)
    expect(ids(q.upNext)).toEqual(['d', 'b', 'c'])
    expect(q.playUpNextAt(1)!.id).toBe('b')
    expect(ids(q.upNext)).toEqual(['c'])
    q.clearUpNext()
    expect(q.peekNext()!.id).toBe('t2')
  })

  it('snapshot lists upcoming context items in play order', () => {
    const q = new PlayQueue()
    q.setContext(album(5), 1, { kind: 'album', id: 'x' })
    q.addToQueue([item('u')])
    const s = q.snapshot()
    expect(ids(s.upNext)).toEqual(['u'])
    expect(ids(s.context.upcoming)).toEqual(['t3', 't4', 't5'])
    expect(s.context).toMatchObject({ position: 1, length: 5, source: { kind: 'album', id: 'x' } })
  })
})

describe('PlayQueue continuation (autoplay)', () => {
  const picks = (n: number) => Array.from({ length: n }, (_, i) => item(`p${i + 1}`, `artist${i % 3}`))
  const AUTO = { kind: 'autoplay' as const, title: 'Autoplay' }

  it('counts what is left and peeks into the continuation after the context', () => {
    const q = new PlayQueue()
    q.setContext(album(3), 1)
    q.addToQueue([item('u')])
    expect(q.remaining).toBe(2)
    q.setContinuation(picks(4), AUTO)
    expect(q.remaining).toBe(6)
    expect(q.peekFrom()).toBe('upNext')
    q.next()
    expect(q.peekFrom()).toBe('context')
    q.next()
    expect(q.current!.id).toBe('t3')
    expect(q.peekFrom()).toBe('continuation')
    expect(q.peekNext()!.id).toBe('p1')
    expect(q.snapshot().continuation).toEqual({ source: AUTO, upcoming: picks(4) })
  })

  it('adopts the continuation as the new context and can go back into the old one', () => {
    const q = new PlayQueue()
    q.setContext(album(2), 0, { kind: 'album', id: 'x' })
    q.next()
    q.setContinuation(picks(3), AUTO)
    const v = q.version
    expect(q.next(true)!.id).toBe('p1')
    expect(q.version).toBeGreaterThan(v)
    expect(q.continuation).toBeNull()
    expect(q.source).toEqual(AUTO)
    expect(ids(q.contextItems)).toEqual(['p1', 'p2', 'p3'])
    expect(q.position).toBe(0)
    expect(q.remaining).toBe(2)
    expect(ids(q.history)).toEqual(['t1', 't2'])
    expect(q.prev(0).item!.id).toBe('t2')
    expect(q.prev(0).item!.id).toBe('t1')
    expect(q.next()!.id).toBe('t2')
    expect(q.next()!.id).toBe('p1')
    expect(q.next()!.id).toBe('p2')
  })

  it('keeps the shuffled continuation starting at its first pick', () => {
    const q = new PlayQueue(rng(7))
    q.setShuffle(true)
    q.setContext(album(2), 0)
    q.next()
    q.setContinuation(picks(6), AUTO)
    expect(q.next(true)!.id).toBe('p1')
    expect(new Set(ids(q.playOrder))).toEqual(new Set(ids(picks(6))))
  })

  it('repeat and Up Next come before the continuation; null clears it; setContext drops it', () => {
    const q = new PlayQueue()
    q.setContext(album(1), 0)
    q.setContinuation(picks(2), AUTO)
    q.setRepeat('one')
    expect(q.peekFrom()).toBe('repeat')
    q.setRepeat('all')
    expect(q.peekFrom()).toBe('wrap')
    q.setRepeat('off')
    q.addToQueue([item('u')])
    expect(q.peekFrom()).toBe('upNext')
    q.clearUpNext()
    expect(q.peekFrom()).toBe('continuation')
    q.setContinuation(null)
    expect(q.peekFrom()).toBeNull()
    expect(q.remaining).toBe(0)
    q.setContinuation(picks(2), AUTO)
    q.setContext(album(2), 0)
    expect(q.continuation).toBeNull()
  })

  it('appendContext extends the context in order (or shuffled among the new items)', () => {
    const q = new PlayQueue()
    q.setContext(picks(2), 0, AUTO)
    q.next()
    const before = q.contextItems
    q.appendContext([item('n1'), item('n2')])
    expect(q.contextItems).not.toBe(before)
    expect(ids(q.playOrder)).toEqual(['p1', 'p2', 'n1', 'n2'])
    expect(q.remaining).toBe(2)
    expect(q.next()!.id).toBe('n1')

    const s = new PlayQueue(rng(3))
    s.setShuffle(true)
    s.setContext(picks(3), 0, AUTO)
    const head = ids(s.playOrder)
    s.appendContext(picks(9).slice(3))
    expect(ids(s.playOrder).slice(0, 3)).toEqual(head)
    expect(new Set(ids(s.playOrder).slice(3))).toEqual(new Set(ids(picks(9).slice(3))))
  })

  it('prev restart threshold: restartMs 0 always goes back', () => {
    const q = new PlayQueue()
    q.setContext(album(3), 2)
    expect(q.prev(4000, 5000)).toMatchObject({ restart: false })
    expect(q.current!.id).toBe('t2')
    expect(q.prev(60_000, 0)).toMatchObject({ restart: false })
    expect(q.current!.id).toBe('t1')
    expect(q.prev(10_001, 10_000)).toMatchObject({ restart: true })
  })
})
