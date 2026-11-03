// Play queue: a context (album/playlist/search...) in play order, a user Up Next list that always
// wins, and a history stack. Pure; the Player drives it.

import type { PlayItem, QueueSnapshot, QueueSource, RepeatMode } from './types'

export type Rng = () => number

interface Entry {
  item: PlayItem
  /** Index into the context items, or null for Up Next items. */
  idx: number | null
}

export const PREV_RESTART_MS = 3000
const HISTORY_MAX = 500

export function fisherYates<T>(a: T[], rng: Rng = Math.random): T[] {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

export const artistKey = (it: PlayItem): string => (it.artist ?? '').trim().toLowerCase()

/** Random order that spreads each artist's tracks across the list (spread + local repair). */
export function spreadByArtist(idx: number[], key: (i: number) => string, rng: Rng = Math.random): number[] {
  const groups = new Map<string, number[]>()
  for (const i of idx) {
    const k = key(i)
    const g = groups.get(k)
    if (g) g.push(i)
    else groups.set(k, [i])
  }
  const placed: { i: number; p: number }[] = []
  for (const g of groups.values()) {
    fisherYates(g, rng)
    const n = g.length
    const off = rng() / n
    g.forEach((i, k) => placed.push({ i, p: off + k / n + ((rng() - 0.5) * 0.2) / n }))
  }
  placed.sort((a, b) => a.p - b.p)
  return placed.map((x) => x.i)
}

/** Swaps away adjacent same-key pairs where a swap creates no new pair. Position 0 is fixed. */
export function repairAdjacent(order: number[], key: (i: number) => string): number[] {
  const n = order.length
  const k = (p: number) => (p >= 0 && p < n ? key(order[p]) : null)
  const fits = (val: string, p: number, skip: number) => (p - 1 === skip || k(p - 1) !== val) && (p + 1 === skip || k(p + 1) !== val)
  for (let i = 1; i < n; i++) {
    if (k(i) !== k(i - 1)) continue
    const ki = k(i)!
    for (let d = 1; d < n; d++) {
      let done = false
      for (const j of [i + d, i - d]) {
        if (j < 1 || j >= n || j === i) continue
        const kj = k(j)!
        if (kj === ki) continue
        if (fits(kj, i, j) && fits(ki, j, i)) {
          ;[order[i], order[j]] = [order[j], order[i]]
          done = true
          break
        }
      }
      if (done) break
    }
  }
  return order
}

export function adjacentSameArtist(items: PlayItem[], order: number[]): number {
  let c = 0
  for (let i = 1; i < order.length; i++) if (artistKey(items[order[i]]) === artistKey(items[order[i - 1]])) c++
  return c
}

/** Shuffled play order with `first` (if any) at position 0. */
export function shuffleOrder(items: PlayItem[], first: number | null, rng: Rng = Math.random): number[] {
  const key = (i: number) => artistKey(items[i])
  const rest = items.map((_, i) => i).filter((i) => i !== first)
  const order = spreadByArtist(rest, key, rng)
  if (first !== null && first >= 0 && first < items.length) order.unshift(first)
  return repairAdjacent(order, key)
}

export class PlayQueue {
  private items: PlayItem[] = []
  private order: number[] = []
  /** Play-order position of the last context item that became current; -1 before any. */
  private ptr = -1
  private cur: Entry | null = null
  private up: PlayItem[] = []
  private hist: Entry[] = []
  private _shuffle = false
  private _repeat: RepeatMode = 'off'
  source: QueueSource | null = null
  /** Bumped on every structural change (cheap change detection for snapshots). */
  version = 0

  constructor(private rng: Rng = Math.random) {}

  get current(): PlayItem | null {
    return this.cur?.item ?? null
  }
  get currentFromUpNext(): boolean {
    return !!this.cur && this.cur.idx === null
  }
  get upNext(): readonly PlayItem[] {
    return this.up
  }
  get history(): PlayItem[] {
    return this.hist.map((e) => e.item)
  }
  get contextItems(): readonly PlayItem[] {
    return this.items
  }
  /** Context items in play order. */
  get playOrder(): PlayItem[] {
    return this.order.map((i) => this.items[i])
  }
  get position(): number {
    return this.ptr
  }
  get shuffle(): boolean {
    return this._shuffle
  }
  get repeat(): RepeatMode {
    return this._repeat
  }

  private bump(): void {
    this.version++
  }

  setContext(items: PlayItem[], startIndex = 0, source: QueueSource | null = null): PlayItem | null {
    this.items = [...items]
    this.source = source
    this.hist = []
    const start = items.length ? Math.min(Math.max(0, Math.floor(startIndex)), items.length - 1) : -1
    if (this._shuffle) {
      this.order = shuffleOrder(this.items, start >= 0 ? start : null, this.rng)
      this.ptr = start >= 0 ? 0 : -1
    } else {
      this.order = this.items.map((_, i) => i)
      this.ptr = start
    }
    this.cur = start >= 0 ? { item: this.items[start], idx: start } : null
    this.bump()
    return this.current
  }

  clear(): void {
    this.items = []
    this.order = []
    this.ptr = -1
    this.cur = null
    this.up = []
    this.hist = []
    this.source = null
    this.bump()
  }

  private peekEntry(auto: boolean): Entry | null {
    if (auto && this._repeat === 'one' && this.cur) return this.cur
    if (this.up.length) return { item: this.up[0], idx: null }
    const p = this.ptr + 1
    if (p < this.order.length) return { item: this.items[this.order[p]], idx: this.order[p] }
    if (this._repeat === 'all' && this.order.length) return { item: this.items[this.order[0]], idx: this.order[0] }
    return null
  }

  /** What `next(true)` would return (for prefetch / gapless). */
  peekNext(): PlayItem | null {
    return this.peekEntry(true)?.item ?? null
  }

  private pushHistory(): void {
    if (!this.cur) return
    this.hist.push(this.cur)
    if (this.hist.length > HISTORY_MAX) this.hist.splice(0, this.hist.length - HISTORY_MAX)
  }

  /** Advances. `auto` = the track ended by itself (repeat-one replays). Null at the end of the queue. */
  next(auto = false): PlayItem | null {
    const n = this.peekEntry(auto)
    if (!n) return null
    if (n === this.cur) return n.item
    this.pushHistory()
    if (n.idx === null) this.up.shift()
    else this.ptr = this.order.indexOf(n.idx)
    this.cur = n
    this.bump()
    return n.item
  }

  /** Prev rule: restart when more than 3 s in (or nothing earlier), else go back. */
  prev(positionMs: number): { item: PlayItem | null; restart: boolean } {
    const left = this.cur
    if (!left) return { item: null, restart: false }
    if (positionMs > PREV_RESTART_MS) return { item: left.item, restart: true }
    let target: Entry | null = this.hist.pop() ?? null
    if (!target) {
      if (left.idx !== null) {
        const p = this.order.indexOf(left.idx)
        if (p > 0) target = { item: this.items[this.order[p - 1]], idx: this.order[p - 1] }
        else if (this._repeat === 'all' && this.order.length > 1) {
          const last = this.order[this.order.length - 1]
          target = { item: this.items[last], idx: last }
        }
      } else if (this.ptr >= 0) {
        target = { item: this.items[this.order[this.ptr]], idx: this.order[this.ptr] }
      }
    }
    if (!target) return { item: left.item, restart: true }
    if (left.idx === null) this.up.unshift(left.item)
    if (target.idx !== null) {
      const p = this.order.indexOf(target.idx)
      if (p >= 0) this.ptr = p
    } else if (left.idx !== null) {
      this.ptr = this.order.indexOf(left.idx) - 1
    }
    this.cur = target
    this.bump()
    return { item: target.item, restart: false }
  }

  /** Jump to a play-order position in the context. */
  jumpTo(position: number): PlayItem | null {
    if (position < 0 || position >= this.order.length) return null
    this.pushHistory()
    this.ptr = position
    const idx = this.order[position]
    this.cur = { item: this.items[idx], idx }
    this.bump()
    return this.cur.item
  }

  /** Plays an Up Next item now, dropping the ones before it. */
  playUpNextAt(index: number): PlayItem | null {
    if (index < 0 || index >= this.up.length) return null
    this.pushHistory()
    const item = this.up.splice(0, index + 1)[index]
    this.cur = { item, idx: null }
    this.bump()
    return item
  }

  playNext(items: PlayItem[]): void {
    if (!items.length) return
    if (!this.cur) {
      this.cur = { item: items[0], idx: null }
      this.up.unshift(...items.slice(1))
    } else this.up.unshift(...items)
    this.bump()
  }

  addToQueue(items: PlayItem[]): void {
    if (!items.length) return
    if (!this.cur) {
      this.cur = { item: items[0], idx: null }
      this.up.push(...items.slice(1))
    } else this.up.push(...items)
    this.bump()
  }

  removeUpNext(index: number): void {
    if (index < 0 || index >= this.up.length) return
    this.up.splice(index, 1)
    this.bump()
  }

  moveUpNext(from: number, to: number): void {
    if (from < 0 || from >= this.up.length) return
    const [it] = this.up.splice(from, 1)
    this.up.splice(Math.max(0, Math.min(to, this.up.length)), 0, it)
    this.bump()
  }

  clearUpNext(): void {
    if (!this.up.length) return
    this.up = []
    this.bump()
  }

  setShuffle(on: boolean): void {
    if (on === this._shuffle) return
    this._shuffle = on
    const anchor = this.cur?.idx ?? (this.ptr >= 0 ? this.order[this.ptr] : null)
    if (on) {
      this.order = shuffleOrder(this.items, anchor, this.rng)
      this.ptr = anchor !== null ? 0 : -1
    } else {
      this.order = this.items.map((_, i) => i)
      this.ptr = anchor ?? -1
    }
    this.bump()
  }

  setRepeat(mode: RepeatMode): void {
    if (mode === this._repeat) return
    this._repeat = mode
    this.bump()
  }

  upcoming(limit = 200): PlayItem[] {
    const out: PlayItem[] = []
    for (let p = this.ptr + 1; p < this.order.length && out.length < limit; p++) out.push(this.items[this.order[p]])
    return out
  }

  snapshot(limit = 200): QueueSnapshot {
    return {
      upNext: this.up.slice(0, limit),
      context: { source: this.source, upcoming: this.upcoming(limit), position: this.ptr, length: this.order.length },
      history: this.hist.slice(-50).map((e) => e.item),
    }
  }
}
