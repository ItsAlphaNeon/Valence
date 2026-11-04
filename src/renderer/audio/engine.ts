// AudioEngine contract shared by the worklet engine and the <audio> fallback, plus small utilities.

import type { EngineKind, PlayItem } from './types'

export class Emitter<E extends Record<string, unknown>> {
  private ls = new Map<keyof E, Set<(v: never) => void>>()

  on<K extends keyof E>(ev: K, cb: (v: E[K]) => void): () => void {
    let s = this.ls.get(ev)
    if (!s) this.ls.set(ev, (s = new Set()))
    s.add(cb as (v: never) => void)
    return () => this.off(ev, cb)
  }

  off<K extends keyof E>(ev: K, cb: (v: E[K]) => void): void {
    this.ls.get(ev)?.delete(cb as (v: never) => void)
  }

  protected emit<K extends keyof E>(ev: K, v: E[K]): void {
    const s = this.ls.get(ev)
    if (!s) return
    for (const cb of [...s]) {
      try {
        ;(cb as (v: E[K]) => void)(v)
      } catch (e) {
        console.error(e)
      }
    }
  }

  protected clearListeners(): void {
    this.ls.clear()
  }
}

export interface EngineEvents extends Record<string, unknown> {
  position: { itemId: string; positionMs: number }
  /** Playback moved to the prefetched next item (gapless or crossfade start). */
  transition: { item: PlayItem; crossfade: boolean }
  /** Current item finished and nothing was queued in the engine. */
  ended: { item: PlayItem | null }
  buffering: boolean
  error: { item: PlayItem | null; message: string }
  duration: { itemId: string; durationMs: number }
}

export interface LoadOptions {
  startMs?: number
  autoplay?: boolean
  /** Linear ReplayGain factor. */
  gain?: number
  /** Ramp whatever is playing out over this long first (manual track changes); 0 = ~10 ms anti-click ramp. */
  fadeOutMs?: number
}

export interface NextOptions {
  gain?: number
  crossfadeSec?: number
}

export interface AudioEngine {
  readonly kind: EngineKind
  init(): Promise<void>
  load(item: PlayItem, opts?: LoadOptions): void
  /** The item to prefetch/join after the current one (null clears). */
  setNext(item: PlayItem | null, opts?: NextOptions): void
  play(): void
  pause(): void
  /** `fadeOutMs` ramps the output out first; 0 = ~10 ms anti-click ramp. */
  stop(fadeOutMs?: number): void
  seek(ms: number): void
  /** Length of the pause/resume gain ramp. */
  setPauseRamp(ms: number): void
  setGain(itemId: string, gain: number): void
  readonly loaded: boolean
  positionMs(): number
  framesRendered(): number
  on<K extends keyof EngineEvents>(ev: K, cb: (v: EngineEvents[K]) => void): () => void
  dispose(): void
}

/** Asks main for a MessagePort via the preload bridge (delivered with window.postMessage). */
export function requestPort(name: string, args?: unknown, timeoutMs = 5000): Promise<MessagePort> {
  const id = `${name}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  return new Promise((resolve, reject) => {
    if (!window.valence?.requestPort) return reject(new Error('valence bridge unavailable'))
    const timer = setTimeout(() => {
      window.removeEventListener('message', onMsg)
      reject(new Error(`port '${name}' timed out`))
    }, timeoutMs)
    const onMsg = (e: MessageEvent) => {
      const d = e.data as { type?: string; id?: string } | null
      if (!d || d.type !== 'valence-port' || d.id !== id || !e.ports[0]) return
      clearTimeout(timer)
      window.removeEventListener('message', onMsg)
      resolve(e.ports[0])
    }
    window.addEventListener('message', onMsg)
    window.valence.requestPort(name, id, args)
  })
}
