// ffmpeg -> Float32 PCM streams with credit-based flow control. Electron-free so it can be
// exercised under vitest; decode-host.ts wires it to a MessagePortMain.

import { spawn, type ChildProcessByStdio } from 'node:child_process'
import type { Readable } from 'node:stream'
import { PCM_CHUNK_FRAMES, PCM_MAX_BUFFERED_SEC, type PcmEvent, type PcmRequest } from './pcm-protocol'

export interface DecodeSessionOptions {
  ffmpeg: string
  /** Real path when the file may be opened, else null. */
  resolve(path: string): string | null
  durationOf?(path: string): Promise<number | null>
  chunkFrames?: number
  maxBufferedSec?: number
  log?(msg: string): void
}

interface Stream {
  id: number
  gen: number
  path: string
  rate: number
  child: ChildProcessByStdio<null, Readable, Readable> | null
  sent: number
  acked: number
  paused: boolean
  rest: Buffer | null
}

export async function probeDurationSec(path: string): Promise<number | null> {
  try {
    const mm = await import('music-metadata')
    const meta = await mm.parseFile(path, { duration: false, skipCovers: true })
    const d = meta.format.duration
    return typeof d === 'number' && isFinite(d) && d > 0 ? d : null
  } catch {
    return null
  }
}

export function ffmpegPcmArgs(path: string, startSec: number, rate: number): string[] {
  const ss = startSec > 0 ? ['-ss', startSec.toFixed(6)] : []
  return ['-nostdin', '-loglevel', 'error', ...ss, '-i', path, '-map', '0:a:0', '-vn', '-f', 'f32le', '-ac', '2', '-ar', String(rate), '-']
}

export class DecodeSession {
  private streams = new Map<number, Stream>()
  private chunkBytes: number
  private chunkFrames: number
  private maxBufferedSec: number

  constructor(
    private post: (msg: PcmEvent) => void,
    private opts: DecodeSessionOptions,
  ) {
    this.chunkFrames = opts.chunkFrames ?? PCM_CHUNK_FRAMES
    this.chunkBytes = this.chunkFrames * 8
    this.maxBufferedSec = opts.maxBufferedSec ?? PCM_MAX_BUFFERED_SEC
  }

  get size(): number {
    return this.streams.size
  }

  /** Frames sent but not yet acknowledged, per stream (for tests/diagnostics). */
  inflight(streamId: number): number {
    const s = this.streams.get(streamId)
    return s ? s.sent - s.acked : 0
  }

  isPaused(streamId: number): boolean {
    return !!this.streams.get(streamId)?.paused
  }

  handle(msg: PcmRequest): void {
    if (!msg || typeof msg !== 'object') return
    switch (msg.type) {
      case 'open':
        return this.open(msg.streamId, msg.gen, msg.path, msg.startSec, msg.sampleRate)
      case 'seek': {
        const s = this.streams.get(msg.streamId)
        if (s) this.start(s, msg.gen, msg.startSec)
        return
      }
      case 'close':
        return this.close(msg.streamId)
      case 'ack': {
        const s = this.streams.get(msg.streamId)
        if (!s || s.gen !== msg.gen) return
        s.acked += msg.frames
        if (s.paused && s.sent - s.acked < (this.maxBufferedSec - 1) * s.rate) {
          s.paused = false
          s.child?.stdout.resume()
        }
        return
      }
    }
  }

  closeAll(): void {
    for (const id of [...this.streams.keys()]) this.close(id)
  }

  private open(id: number, gen: number, path: string, startSec: number, rate: number): void {
    this.close(id)
    const real = typeof path === 'string' ? this.opts.resolve(path) : null
    if (!real) {
      this.post({ type: 'error', streamId: id, gen, message: 'File not found or not allowed' })
      return
    }
    if (!(rate >= 8000 && rate <= 768000)) {
      this.post({ type: 'error', streamId: id, gen, message: 'Bad sample rate' })
      return
    }
    const s: Stream = { id, gen, path: real, rate: Math.round(rate), child: null, sent: 0, acked: 0, paused: false, rest: null }
    this.streams.set(id, s)
    this.start(s, gen, startSec)
    if (this.opts.durationOf) {
      void this.opts.durationOf(real).then(
        (d) => this.streams.get(id) === s && this.post({ type: 'format', streamId: id, gen: s.gen, durationSec: d }),
        () => {},
      )
    }
  }

  private kill(s: Stream): void {
    const c = s.child
    s.child = null
    if (c) {
      c.stdout.removeAllListeners('data')
      c.removeAllListeners('close')
      c.kill()
    }
  }

  private close(id: number): void {
    const s = this.streams.get(id)
    if (!s) return
    this.kill(s)
    this.streams.delete(id)
  }

  private start(s: Stream, gen: number, startSec: number): void {
    this.kill(s)
    s.gen = gen
    s.sent = 0
    s.acked = 0
    s.paused = false
    s.rest = null
    const child = spawn(this.opts.ffmpeg, ffmpegPcmArgs(s.path, Math.max(0, startSec || 0), s.rate), {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    s.child = child
    let err = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (d: string) => {
      if (err.length < 8192) err += d
    })
    child.stdout.on('data', (d: Buffer) => this.onData(s, child, d))
    child.on('error', (e) => {
      if (s.child !== child) return
      s.child = null
      this.post({ type: 'error', streamId: s.id, gen: s.gen, message: e.message })
    })
    child.on('close', (code) => {
      if (s.child !== child) return
      s.child = null
      if (s.rest && s.rest.length >= 8) this.emit(s, s.rest.subarray(0, s.rest.length - (s.rest.length % 8)))
      s.rest = null
      if (code !== 0 && s.sent === 0) {
        this.post({ type: 'error', streamId: s.id, gen: s.gen, message: err.trim().split('\n').slice(-3).join('\n') || `ffmpeg exited ${code}` })
      } else {
        if (code !== 0) this.opts.log?.(`decoder exited ${code} after ${s.sent} frames: ${err.trim()}`)
        this.post({ type: 'eof', streamId: s.id, gen: s.gen, frames: s.sent })
      }
    })
  }

  private onData(s: Stream, child: Stream['child'], d: Buffer): void {
    if (s.child !== child) return
    const buf = s.rest ? Buffer.concat([s.rest, d]) : d
    let off = 0
    while (buf.length - off >= this.chunkBytes) {
      this.emit(s, buf.subarray(off, off + this.chunkBytes))
      off += this.chunkBytes
    }
    s.rest = off < buf.length ? Buffer.from(buf.subarray(off)) : null
    if (!s.paused && s.sent - s.acked > this.maxBufferedSec * s.rate) {
      s.paused = true
      child?.stdout.pause()
    }
  }

  private emit(s: Stream, bytes: Buffer): void {
    const data = new Float32Array(bytes.length >> 2)
    new Uint8Array(data.buffer).set(bytes.subarray(0, data.length << 2))
    s.sent += data.length >> 1
    this.post({ type: 'pcm', streamId: s.id, gen: s.gen, data })
  }
}
