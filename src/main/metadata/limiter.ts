import { sleep } from './util'

/**
 * Minimum-interval rate limiter. Serial limiters also wait for the previous task to finish
 * (MusicBrainz wants one request at a time); non-serial ones only space out start times.
 */
export class RateLimiter {
  private next = 0
  private chain: Promise<unknown> = Promise.resolve()

  constructor(readonly intervalMs: number, readonly serial = false) {}

  /** Pushes the next start slot back, e.g. after a 503 with Retry-After. */
  delay(ms: number): void {
    this.next = Math.max(this.next, Date.now() + ms)
  }

  schedule<T>(fn: () => Promise<T>): Promise<T> {
    if (!this.serial) {
      const now = Date.now()
      const slot = Math.max(now, this.next)
      this.next = slot + this.intervalMs
      return slot > now ? sleep(slot - now).then(fn) : fn()
    }
    const run = async (): Promise<T> => {
      const wait = this.next - Date.now()
      if (wait > 0) await sleep(wait)
      this.next = Date.now() + this.intervalMs
      return fn()
    }
    const p = this.chain.then(run, run)
    this.chain = p.catch(() => undefined)
    return p
  }
}

/** Process-wide limiters (MusicBrainz 1 req / 1.1 s serial, AcoustID 3/s, LRCLIB 2/s). */
export const globalLimiters = {
  musicbrainz: new RateLimiter(1100, true),
  acoustid: new RateLimiter(334),
  lrclib: new RateLimiter(500),
}

export type LimiterSet = typeof globalLimiters
