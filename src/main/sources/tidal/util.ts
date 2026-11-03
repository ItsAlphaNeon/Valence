import { SourceError } from '../../import/source-types'

export const cancelled = (): SourceError => new SourceError('Cancelled', 'cancelled')

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw cancelled()
}

/** setTimeout-based sleep that rejects with SourceError('cancelled') on abort. */
export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(cancelled())
    const onAbort = () => {
      clearTimeout(t)
      reject(cancelled())
    }
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, Math.max(0, ms))
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

export const asError = (e: unknown): Error => (e instanceof Error ? e : new Error(String(e)))
