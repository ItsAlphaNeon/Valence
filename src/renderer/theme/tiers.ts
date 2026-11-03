// Performance tier selection: full (refraction + blur + motion), glass (blur), flat, minimal.

export type Tier = 'full' | 'glass' | 'flat' | 'minimal'
export const TIERS: Tier[] = ['full', 'glass', 'flat', 'minimal']

export function applyTier(t: Tier): void {
  document.documentElement.dataset.tier = t
}

/** Static guess from GPU status and OS accessibility preferences. */
export function guessTier(gpu: Record<string, string> | undefined): Tier {
  const mq = (q: string) => matchMedia(q).matches
  if (mq('(prefers-reduced-transparency: reduce)')) return 'flat'
  const comp = gpu?.gpu_compositing ?? ''
  if (comp && !comp.startsWith('enabled')) return 'flat'
  if (mq('(prefers-reduced-motion: reduce)')) return 'glass'
  if ((navigator.hardwareConcurrency ?? 4) < 4) return 'glass'
  return 'full'
}

/** Measures frame pacing for `ms`; returns the 90th-percentile frame time. */
export function measureFrames(ms = 2000): Promise<number> {
  return new Promise((resolve) => {
    const times: number[] = []
    let last = performance.now()
    const start = last
    const tick = (t: number) => {
      times.push(t - last)
      last = t
      if (t - start < ms) requestAnimationFrame(tick)
      else {
        times.sort((a, b) => a - b)
        resolve(times[Math.floor(times.length * 0.9)] ?? 16)
      }
    }
    requestAnimationFrame(tick)
  })
}

export function downgrade(t: Tier): Tier {
  return TIERS[Math.min(TIERS.length - 1, TIERS.indexOf(t) + 1)]
}
