// Locates bundled executables (ffmpeg, fpcalc) in dev, tests (plain Node) and packaged builds.
// Deliberately free of `electron` imports so core modules stay testable under vitest.

import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'

const req = createRequire(import.meta.url)
const exe = process.platform === 'win32' ? '.exe' : ''
const sep = process.platform === 'win32' ? '\\' : '/'

const isPackaged = !!process.versions.electron && !process.defaultApp && !/node_modules[\\/]electron[\\/]/.test(process.execPath)

function unpacked(p: string): string {
  return p.replace(`app.asar${sep}`, `app.asar.unpacked${sep}`)
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

let fpcalcCached: string | null | undefined
export function fpcalcPath(): string | null {
  if (fpcalcCached !== undefined) return fpcalcCached
  const rel = join('resources', 'bin', `${process.platform}-${process.arch}`, `fpcalc${exe}`)
  const candidates = [
    process.env.VALENCE_FPCALC,
    isPackaged && process.resourcesPath ? join(process.resourcesPath, 'bin', `fpcalc${exe}`) : undefined,
    join(process.cwd(), rel),
    join(import.meta.dirname ?? '.', '..', '..', rel),
  ]
  for (const c of candidates) if (c && existsSync(c)) return (fpcalcCached = c)
  return (fpcalcCached = null)
}
