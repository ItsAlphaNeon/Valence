// Hybrid logical clock: wall-clock milliseconds plus a counter, tie-broken by device id. Orders
// events across devices even when their clocks drift a little. Encoded as a sortable string.

export interface Hlc {
  ms: number
  c: number
  d: string
}

export class HlcClock {
  private last: Hlc

  constructor(
    private deviceId: string,
    private now: () => number = Date.now,
  ) {
    this.last = { ms: 0, c: 0, d: deviceId }
  }

  tick(): string {
    const ms = Math.max(this.now(), this.last.ms)
    this.last = ms === this.last.ms ? { ms, c: this.last.c + 1, d: this.deviceId } : { ms, c: 0, d: this.deviceId }
    return encodeHlc(this.last)
  }

  /** Advances past a remotely observed timestamp. */
  observe(remote: string): void {
    const r = decodeHlc(remote)
    if (!r) return
    const ms = Math.max(this.now(), this.last.ms, r.ms)
    let c = 0
    if (ms === this.last.ms && ms === r.ms) c = Math.max(this.last.c, r.c) + 1
    else if (ms === this.last.ms) c = this.last.c + 1
    else if (ms === r.ms) c = r.c + 1
    this.last = { ms, c, d: this.deviceId }
  }
}

export function encodeHlc(h: Hlc): string {
  return `${h.ms.toString(36).padStart(9, '0')}-${h.c.toString(36).padStart(4, '0')}-${h.d}`
}

export function decodeHlc(s: string): Hlc | null {
  const m = /^([0-9a-z]+)-([0-9a-z]+)-(.+)$/.exec(s)
  if (!m) return null
  return { ms: parseInt(m[1], 36), c: parseInt(m[2], 36), d: m[3] }
}

export function compareHlc(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}
