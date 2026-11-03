// Fetches a decoded StreamManifest into staging and normalizes it: FLAC (raw or in MP4) is
// re-encoded to FLAC and verified bit-exact via PCM MD5; AAC is remuxed to .m4a without re-encoding.

import { createWriteStream, mkdirSync, rmSync, statSync, type WriteStream } from 'node:fs'
import { open } from 'node:fs/promises'
import { join } from 'node:path'
import { SourceError, type Transport } from '../../import/source-types'
import { ffmpegOrThrow, pcmMd5, runFfmpeg } from '../../media/ffmpeg'
import type { StreamManifest } from './manifest'
import { abortableSleep, asError, cancelled, throwIfAborted } from './util'

export interface DownloadOptions {
  dir: string
  /** ASCII-only file stem, e.g. "t001-12345". */
  baseName: string
  transport: Transport
  signal?: AbortSignal
  /** 0..1 over download + processing. */
  onProgress?: (fraction: number, phase: 'downloading' | 'processing') => void
  parallel?: number
  segmentAttempts?: number
}

export interface DownloadedAudio {
  file: string
  lossless: boolean
  codec: string
  sampleRate?: number
  bitDepth?: number
  bitrateKbps?: number
  bytes: number
}

export interface ProbeInfo {
  codec: string
  sampleRate?: number
  bitDepth?: number
  bitrateKbps?: number
}

/** Reads codec/rate/depth of the first audio stream from ffmpeg's banner. */
export async function probeAudio(path: string, signal?: AbortSignal): Promise<ProbeInfo> {
  const r = await runFfmpeg(['-i', path], { signal })
  const line = r.stderr.split('\n').find((l) => /Stream #\d+:\d+.*Audio:/.test(l))
  if (!line) throw new SourceError(`No audio stream in downloaded file: ${r.stderr.split('\n').slice(-3).join(' ')}`, 'parse')
  const codec = /Audio: (\w+)/.exec(line)?.[1]?.toLowerCase() ?? 'unknown'
  const hz = /(\d+) Hz/.exec(line)?.[1]
  const kbps = /(\d+) kb\/s/.exec(line)?.[1]
  const bits = /\((\d+) bit\)/.exec(line)?.[1] ?? (/\bs16p?\b/.test(line) ? '16' : /\bs32p?\b/.test(line) ? '32' : undefined)
  return { codec, sampleRate: hz ? Number(hz) : undefined, bitDepth: bits ? Number(bits) : undefined, bitrateKbps: kbps ? Number(kbps) : undefined }
}

/**
 * Defense in depth: refuses MP4 files whose moov declares protection (sinf/tenc/pssh/enca),
 * even if the manifest claimed none.
 */
export async function assertUnprotectedMp4(path: string): Promise<void> {
  const fh = await open(path, 'r')
  try {
    const head = Buffer.alloc(Math.min(statSync(path).size, 8 << 20))
    await fh.read(head, 0, head.length, 0)
    if (head.subarray(4, 8).toString('latin1') !== 'ftyp' && head.subarray(4, 8).toString('latin1') !== 'moov') return
    for (let off = 0; off + 8 <= head.length; ) {
      let size = head.readUInt32BE(off)
      const type = head.subarray(off + 4, off + 8).toString('latin1')
      if (size === 1 && off + 16 <= head.length) size = Number(head.readBigUInt64BE(off + 8))
      if (size < 8) break
      if (type === 'moov' || type === 'pssh') {
        const box = head.subarray(off, Math.min(off + size, head.length))
        for (const marker of ['pssh', 'tenc', 'sinf', 'enca', 'encv']) {
          if (box.includes(marker, 0, 'latin1')) throw new SourceError(`Protected MP4 (${marker}) refused`, 'drm')
        }
        if (type === 'moov') return
      }
      off += size
    }
  } finally {
    await fh.close()
  }
}

const isRetryable = (e: unknown) => !(e instanceof SourceError) || e.kind === 'network'

async function fetchOk(url: string, transport: Transport, signal: AbortSignal): Promise<Response> {
  let res: Response
  try {
    res = await transport(url, { signal })
  } catch (e) {
    if (signal.aborted) throw cancelled()
    throw new SourceError(`Download failed: ${asError(e).message}`, 'network')
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => {})
    throw new SourceError(`Download failed: HTTP ${res.status} for ${new URL(url).pathname}`, 'network')
  }
  return res
}

async function withRetry<T>(fn: () => Promise<T>, attempts: number, signal: AbortSignal): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await fn()
    } catch (e) {
      if (signal.aborted) throw cancelled()
      if (i >= attempts || !isRetryable(e)) throw e
      await abortableSleep(500 * i, signal)
    }
  }
}

const writeChunk = (ws: WriteStream, buf: Uint8Array) =>
  new Promise<void>((resolve, reject) => ws.write(buf, (err) => (err ? reject(err) : resolve())))

const closeStream = (ws: WriteStream) => new Promise<void>((resolve) => ws.end(() => resolve()))

/** Streams a single URL to `ws`, reporting byte progress when Content-Length is known. */
async function streamInto(ws: WriteStream, url: string, opts: DownloadOptions, signal: AbortSignal, onBytes: (done: number, total: number) => void) {
  const res = await fetchOk(url, opts.transport, signal)
  const total = Number(res.headers.get('content-length')) || 0
  if (!res.body) throw new SourceError('Empty download body', 'network')
  let done = 0
  const reader = res.body.getReader()
  try {
    for (;;) {
      const { value, done: end } = await reader.read()
      if (end) break
      await writeChunk(ws, value)
      done += value.byteLength
      onBytes(done, total)
    }
  } catch (e) {
    if (signal.aborted) throw cancelled()
    throw e instanceof SourceError ? e : new SourceError(`Download interrupted: ${asError(e).message}`, 'network')
  }
}

/** Downloads `urls` in order into `file`, up to `parallel` requests in flight. */
async function downloadAll(file: string, urls: string[], opts: DownloadOptions): Promise<void> {
  const ctrl = new AbortController()
  const onAbort = () => ctrl.abort()
  opts.signal?.addEventListener('abort', onAbort, { once: true })
  const signal = ctrl.signal
  const attempts = opts.segmentAttempts ?? 3
  const report = (f: number) => opts.onProgress?.(Math.min(1, f) * 0.9, 'downloading')

  if (urls.length === 1) {
    // A single (BTS) file is streamed; a broken read restarts it from scratch.
    try {
      await withRetry(
        async () => {
          const ws = createWriteStream(file)
          try {
            await streamInto(ws, urls[0], opts, signal, (d, t) => {
              if (t) report(d / t)
            })
          } finally {
            await closeStream(ws)
          }
        },
        attempts,
        signal,
      )
      report(1)
      return
    } catch (e) {
      if (opts.signal?.aborted) throw cancelled()
      throw e
    } finally {
      opts.signal?.removeEventListener('abort', onAbort)
    }
  }

  const ws = createWriteStream(file)
  try {
    const parallel = Math.max(1, Math.min(4, opts.parallel ?? 4))
    const inflight: Promise<Uint8Array>[] = []
    let next = 0
    const start = () => {
      const url = urls[next++]
      const p = withRetry(async () => new Uint8Array(await (await fetchOk(url, opts.transport, signal)).arrayBuffer()), attempts, signal)
      p.catch(() => {}) // observed below; avoids unhandled rejections while earlier segments are awaited
      inflight.push(p)
    }
    while (inflight.length < parallel && next < urls.length) start()
    for (let done = 0; inflight.length; ) {
      const buf = await inflight.shift()!
      if (next < urls.length) start()
      await writeChunk(ws, buf)
      report(++done / urls.length)
    }
  } catch (e) {
    ctrl.abort()
    if (opts.signal?.aborted) throw cancelled()
    throw e
  } finally {
    opts.signal?.removeEventListener('abort', onAbort)
    await closeStream(ws)
  }
}

/** Downloads and normalizes one track. The caller owns `opts.dir`. */
export async function downloadStream(m: StreamManifest, opts: DownloadOptions): Promise<DownloadedAudio> {
  throwIfAborted(opts.signal)
  mkdirSync(opts.dir, { recursive: true })
  const rawExt = m.kind === 'bts' && /flac/i.test(m.mimeType) ? 'flac' : 'mp4'
  const raw = join(opts.dir, `${opts.baseName}.src.${rawExt}`)
  try {
    await downloadAll(raw, m.urls, opts)
    throwIfAborted(opts.signal)
    if (rawExt === 'mp4') await assertUnprotectedMp4(raw)
    const probe = await probeAudio(raw, opts.signal)
    opts.onProgress?.(0.9, 'processing')

    let out: string
    let lossless: boolean
    if (probe.codec === 'flac' || probe.codec === 'alac') {
      lossless = true
      out = join(opts.dir, `${opts.baseName}.flac`)
      await ffmpegOrThrow(['-y', '-i', raw, '-map', '0:a:0', '-c:a', 'flac', '-compression_level', '8', '-map_metadata', '-1', out], { signal: opts.signal })
      const [a, b] = await Promise.all([pcmMd5(raw), pcmMd5(out)])
      if (!a || a !== b) {
        rmSync(out, { force: true })
        throw new SourceError(`FLAC verification failed (pcm md5 ${a} != ${b})`, 'parse')
      }
    } else if (probe.codec === 'aac') {
      lossless = false
      out = join(opts.dir, `${opts.baseName}.m4a`)
      await ffmpegOrThrow(['-y', '-i', raw, '-map', '0:a:0', '-c', 'copy', '-map_metadata', '-1', '-movflags', '+faststart', out], {
        signal: opts.signal,
      })
    } else {
      throw new SourceError(`Unsupported TIDAL codec: ${probe.codec}`, 'unavailable')
    }
    opts.onProgress?.(1, 'processing')
    return { file: out, lossless, codec: probe.codec, sampleRate: probe.sampleRate, bitDepth: probe.bitDepth, bitrateKbps: probe.bitrateKbps, bytes: statSync(out).size }
  } catch (e) {
    if (opts.signal?.aborted) throw cancelled()
    if (e instanceof SourceError) throw e
    throw new SourceError(`Processing failed: ${asError(e).message}`, 'parse')
  } finally {
    rmSync(raw, { force: true })
  }
}
