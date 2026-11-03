// SMTC SPIKE RESULT (Electron 45.2.1, Windows 11 26200, scripts/e2e-playback.mjs --spike, VALENCE_MUTE=1):
//   destination  not visible: no SMTC session at all (Web Audio alone is not a media session player)
//   stream       not visible: MediaStream-backed <audio> is ignored by Chromium's media session
//   anchor       VISIBLE: session local.valence.app, status Playing, title/artist from navigator.mediaSession
// => default 'anchor'. The anchor must keep volume 1 (Chromium ignores muted elements); it plays digital
//    silence, so it adds nothing audible. Play/pause/next/prev/seek arrive via mediaSession action handlers.
//
// Output stage + navigator.mediaSession bridge. Strategies for getting a Windows SMTC session:
//   'destination' (a) Web Audio only -> ctx.destination (sink: ctx.setSinkId)
//   'stream'      (b) graph -> MediaStreamAudioDestinationNode -> hidden <audio>.srcObject (sink: el.setSinkId)
//   'anchor'      (c) silent looping 60 s WAV <audio> + Web Audio -> ctx.destination (sink: ctx.setSinkId)

import type { PlayerState } from './types'

export type OutputStrategy = 'destination' | 'stream' | 'anchor'
export const DEFAULT_OUTPUT_STRATEGY: OutputStrategy = 'anchor'

let silentUrl: string | null = null

/** 60 s of 8 kHz 8-bit mono silence as a blob: URL. */
export function silentWavUrl(seconds = 60): string {
  if (silentUrl) return silentUrl
  const rate = 8000
  const n = rate * seconds
  const buf = new Uint8Array(44 + n)
  const dv = new DataView(buf.buffer)
  const str = (o: number, s: string) => [...s].forEach((c, i) => (buf[o + i] = c.charCodeAt(0)))
  str(0, 'RIFF')
  dv.setUint32(4, 36 + n, true)
  str(8, 'WAVE')
  str(12, 'fmt ')
  dv.setUint32(16, 16, true)
  dv.setUint16(20, 1, true)
  dv.setUint16(22, 1, true)
  dv.setUint32(24, rate, true)
  dv.setUint32(28, rate, true)
  dv.setUint16(32, 1, true)
  dv.setUint16(34, 8, true)
  str(36, 'data')
  dv.setUint32(40, n, true)
  buf.fill(128, 44)
  return (silentUrl = URL.createObjectURL(new Blob([buf], { type: 'audio/wav' })))
}

type SinkCtx = AudioContext & { setSinkId?: (id: string | { type: 'none' }) => Promise<void> }

export class OutputStage {
  private el: HTMLAudioElement | null = null
  private streamDest: MediaStreamAudioDestinationNode | null = null
  private active = false

  constructor(
    private ctx: AudioContext,
    private source: AudioNode,
    readonly strategy: OutputStrategy,
  ) {
    if (strategy === 'stream') {
      this.streamDest = ctx.createMediaStreamDestination()
      source.connect(this.streamDest)
      this.el = new Audio()
      this.el.srcObject = this.streamDest.stream
    } else {
      source.connect(ctx.destination)
      if (strategy === 'anchor') {
        this.el = new Audio(silentWavUrl())
        this.el.loop = true
      }
    }
    if (this.el) {
      this.el.volume = 1
      this.el.setAttribute('data-valence-output', strategy)
    }
  }

  async setSinkId(deviceId: string): Promise<void> {
    const id = deviceId === 'default' ? '' : deviceId
    if (this.strategy === 'stream') await this.el!.setSinkId(id)
    else await (this.ctx as SinkCtx).setSinkId?.(id)
  }

  /** Keeps the (b)/(c) element playing while the player plays, paused otherwise. */
  setActive(on: boolean): void {
    if (on === this.active || !this.el) return
    this.active = on
    if (on) void this.el.play().catch(() => (this.active = false))
    else this.el.pause()
  }

  dispose(): void {
    this.setActive(false)
    try {
      this.source.disconnect(this.streamDest ?? this.ctx.destination)
    } catch {
      /* already disconnected */
    }
    if (this.el) {
      this.el.srcObject = null
      this.el.removeAttribute('src')
      this.el.load()
    }
    this.el = null
  }
}

export interface MediaSessionHandlers {
  play(): void
  pause(): void
  stop(): void
  prev(): void
  next(): void
  seekTo(ms: number): void
  seekBy(ms: number): void
}

/** Converts custom-scheme art (valence-art:) to a 512 px data: URL the browser process can load. */
export async function artworkUrl(url: string, size = 512): Promise<string | null> {
  if (/^(data:|https?:)/i.test(url)) return url
  try {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.src = url
    await img.decode()
    const c = document.createElement('canvas')
    c.width = c.height = size
    const g = c.getContext('2d')!
    const s = Math.min(img.naturalWidth, img.naturalHeight)
    g.drawImage(img, (img.naturalWidth - s) / 2, (img.naturalHeight - s) / 2, s, s, 0, 0, size, size)
    return c.toDataURL('image/jpeg', 0.9)
  } catch {
    return null
  }
}

export class MediaSessionBridge {
  private key: string | null = null
  private artSeq = 0
  private last = { pos: -1, dur: -1, playing: false, at: 0 }
  private readonly ms: MediaSession | null

  constructor(h: MediaSessionHandlers) {
    this.ms = typeof navigator !== 'undefined' && 'mediaSession' in navigator ? navigator.mediaSession : null
    const set = (a: MediaSessionAction, fn: MediaSessionActionHandler) => {
      try {
        this.ms?.setActionHandler(a, fn)
      } catch {
        /* unsupported action */
      }
    }
    set('play', () => h.play())
    set('pause', () => h.pause())
    set('stop', () => h.stop())
    set('previoustrack', () => h.prev())
    set('nexttrack', () => h.next())
    set('seekto', (d) => d.seekTime != null && h.seekTo(d.seekTime * 1000))
    set('seekbackward', (d) => h.seekBy(-(d.seekOffset ?? 10) * 1000))
    set('seekforward', (d) => h.seekBy((d.seekOffset ?? 10) * 1000))
  }

  update(s: PlayerState): void {
    const ms = this.ms
    if (!ms) return
    const item = s.current
    const key = item ? JSON.stringify([item.id, item.title, item.artist, item.album, item.artUrl ?? '']) : null
    if (key !== this.key) {
      this.key = key
      const seq = ++this.artSeq
      if (!item) ms.metadata = null
      else {
        const meta = { title: item.title, artist: item.artist, album: item.album }
        ms.metadata = new MediaMetadata(meta)
        if (item.artUrl) {
          void artworkUrl(item.artUrl).then((src) => {
            if (src && seq === this.artSeq) ms.metadata = new MediaMetadata({ ...meta, artwork: [{ src, sizes: '512x512', type: src.startsWith('data:image/jpeg') ? 'image/jpeg' : '' }] })
          })
        }
      }
      this.last.pos = -1
    }
    ms.playbackState = !item ? 'none' : s.playing ? 'playing' : 'paused'
    const dur = s.durationMs / 1000
    if (!item || !(dur > 0)) return
    const pos = Math.min(Math.max(0, s.positionMs / 1000), dur)
    const now = performance.now()
    const expected = this.last.playing ? this.last.pos + (now - this.last.at) / 1000 : this.last.pos
    if (this.last.pos >= 0 && this.last.playing === s.playing && Math.abs(this.last.dur - dur) < 0.01 && Math.abs(expected - pos) < 1.5) return
    this.last = { pos, dur, playing: s.playing, at: now }
    try {
      ms.setPositionState({ duration: dur, position: pos, playbackRate: 1 })
    } catch {
      /* invalid state */
    }
  }

  dispose(): void {
    const ms = this.ms
    if (!ms) return
    for (const a of ['play', 'pause', 'stop', 'previoustrack', 'nexttrack', 'seekto', 'seekbackward', 'seekforward'] as MediaSessionAction[]) {
      try {
        ms.setActionHandler(a, null)
      } catch {
        /* ignore */
      }
    }
    ms.metadata = null
    ms.playbackState = 'none'
  }
}
