// Locates bundled executables (ffmpeg, ffprobe-less ffmpeg, fpcalc) in dev and packaged builds.

import { app } from 'electron'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'

const req = createRequire(import.meta.url)
const exe = process.platform === 'win32' ? '.exe' : ''

function unpacked(p: string): string {
  return p.replace(`app.asar${process.platform === 'win32' ? '\\' : '/'}`, `app.asar.unpacked${process.platform === 'win32' ? '\\' : '/'}`)
}

let ffmpegCached: string | null = null
export function ffmpegPath(): string {
  if (ffmpegCached) return ffmpegCached
  const override = process.env.VALENCE_FFMPEG
  if (override && existsSync(override)) return (ffmpegCached = override)
  const p = req('ffmpeg-static') as string | null
  if (!p) throw new Error('ffmpeg-static has no binary for this platform')
  return (ffmpegCached = unpacked(p))
}

let fpcalcCached: string | null = null
export function fpcalcPath(): string | null {
  if (fpcalcCached) return fpcalcCached
  const candidates = [
    process.env.VALENCE_FPCALC,
    app.isPackaged ? join(process.resourcesPath, 'bin', `fpcalc${exe}`) : undefined,
    join(app.getAppPath(), 'resources', 'bin', `${process.platform}-${process.arch}`, `fpcalc${exe}`),
    join(process.cwd(), 'resources', 'bin', `${process.platform}-${process.arch}`, `fpcalc${exe}`),
  ]
  for (const c of candidates) if (c && existsSync(c)) return (fpcalcCached = c)
  return null
}
