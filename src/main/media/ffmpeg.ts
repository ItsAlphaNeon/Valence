// Thin promise wrapper around the bundled ffmpeg binary.

import { spawn } from 'node:child_process'
import { ffmpegPath } from '../platform/binaries'

export interface FfmpegResult {
  code: number
  stdout: Buffer
  stderr: string
}

export interface FfmpegOptions {
  signal?: AbortSignal
  /** Collect stdout into a Buffer (for md5/null muxers). Default false. */
  captureStdout?: boolean
  onProgressSeconds?: (sec: number) => void
}

export function runFfmpeg(args: string[], opts: FfmpegOptions = {}): Promise<FfmpegResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath(), ['-hide_banner', '-nostdin', ...args], { windowsHide: true })
    const out: Buffer[] = []
    let err = ''
    child.stdout.on('data', (d: Buffer) => {
      if (opts.captureStdout) out.push(d)
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (d: string) => {
      err += d
      if (err.length > 1 << 20) err = err.slice(-(1 << 19))
      if (opts.onProgressSeconds) {
        const m = /time=(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(d)
        if (m) opts.onProgressSeconds(Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]))
      }
    })
    const onAbort = () => child.kill('SIGKILL')
    opts.signal?.addEventListener('abort', onAbort, { once: true })
    child.on('error', reject)
    child.on('close', (code) => {
      opts.signal?.removeEventListener('abort', onAbort)
      resolve({ code: code ?? -1, stdout: Buffer.concat(out), stderr: err })
    })
  })
}

/** Runs ffmpeg and throws with the tail of stderr on non-zero exit. */
export async function ffmpegOrThrow(args: string[], opts: FfmpegOptions = {}): Promise<FfmpegResult> {
  const r = await runFfmpeg(args, opts)
  if (r.code !== 0) throw new Error(`ffmpeg failed (${r.code}): ${r.stderr.split('\n').slice(-8).join('\n')}`)
  return r
}

/** MD5 of the decoded PCM stream (s16le stereo-agnostic), used to verify lossless conversions. */
export async function pcmMd5(path: string): Promise<string> {
  const r = await ffmpegOrThrow(['-i', path, '-map', '0:a:0', '-f', 'md5', '-'], { captureStdout: true })
  return r.stdout.toString('utf8').trim().replace(/^MD5=/, '')
}
