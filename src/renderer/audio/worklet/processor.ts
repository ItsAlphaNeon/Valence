// AudioWorklet module: 'valence-player' (PlayerCore wrapper; the `pcm` port from main is attached
// here so PCM bypasses the page thread) and 'valence-tap' (pre-master capture for tests/meters).

import { PlayerCore, type CoreCommand } from './player-core'
import type { PcmEvent } from '@main/audio/pcm-protocol'

declare const sampleRate: number
declare function registerProcessor(name: string, ctor: unknown): void
declare class AudioWorkletProcessor {
  readonly port: MessagePort
  constructor(options?: unknown)
}

interface ProcessorOptions {
  processorOptions?: { ringSec?: number; prebufferSec?: number }
}

class ValencePlayerProcessor extends AudioWorkletProcessor {
  private core: PlayerCore
  private pcm: MessagePort | null = null

  constructor(options: ProcessorOptions) {
    super(options)
    this.core = new PlayerCore(
      { sampleRate, ...(options?.processorOptions ?? {}) },
      {
        host: (ev) => this.port.postMessage(ev),
        decoder: (msg) => this.pcm?.postMessage(msg),
      },
    )
    this.port.onmessage = (e: MessageEvent) => {
      const m = e.data as CoreCommand | { type: 'attach'; port: MessagePort } | { type: 'dispose' }
      if (m.type === 'attach') {
        this.pcm = m.port
        this.pcm.onmessage = (ev: MessageEvent) => this.core.onDecoder(ev.data as PcmEvent)
      } else if (m.type === 'dispose') {
        this.core.command({ type: 'stop' })
        this.pcm?.close()
        this.pcm = null
      } else this.core.command(m)
    }
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const out = outputs[0]
    if (!out?.length) return true
    const L = out[0]
    const R = out[1] ?? new Float32Array(L.length)
    this.core.render(L, R, L.length)
    return true
  }
}

class ValenceTapProcessor extends AudioWorkletProcessor {
  private on = false
  private buf = new Float32Array(4096)
  private n = 0

  constructor(options: unknown) {
    super(options)
    this.port.onmessage = (e: MessageEvent) => {
      if (e.data?.type === 'start') {
        this.on = true
        this.n = 0
      } else if (e.data?.type === 'stop') {
        this.flush()
        this.on = false
        this.port.postMessage({ type: 'stopped' })
      }
    }
  }

  private flush(): void {
    if (!this.n) return
    this.port.postMessage({ type: 'chunk', data: this.buf.slice(0, this.n) })
    this.n = 0
  }

  process(inputs: Float32Array[][]): boolean {
    if (!this.on) return true
    const ch = inputs[0]?.[0]
    const len = ch?.length ?? 128
    for (let i = 0; i < len; i++) {
      this.buf[this.n++] = ch ? ch[i] : 0
      if (this.n === this.buf.length) this.flush()
    }
    return true
  }
}

try {
  registerProcessor('valence-player', ValencePlayerProcessor)
  registerProcessor('valence-tap', ValenceTapProcessor)
} catch {
  /* already registered in this scope */
}
