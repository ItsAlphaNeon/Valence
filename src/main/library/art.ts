// Album-art thumbnails for the UI: valence-art://img/<artHash>?s=<px>. Rendered on demand from
// the embedded picture of any track carrying that hash and cached in <dataDir>/cache/art.

import { existsSync, mkdirSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import sharp from 'sharp'
import type { DB } from '@main/db/db'
import { probeFile } from '@main/tags/read'
import { runFfmpeg } from '@main/media/ffmpeg'
import { toAbs } from './organizer'

export const ART_SCHEME = 'valence-art'
const SIZES = [64, 128, 300, 600, 1200]

export function artUrl(hash: string | null | undefined, size = 300): string | undefined {
  return hash ? `${ART_SCHEME}://img/${hash}?s=${size}` : undefined
}

export function snapSize(s: number): number {
  return SIZES.find((x) => x >= s) ?? SIZES[SIZES.length - 1]
}

export class ArtCache {
  private inflight = new Map<string, Promise<Buffer | null>>()

  constructor(
    private db: DB,
    private root: string,
    private cacheDir: string,
  ) {
    mkdirSync(cacheDir, { recursive: true })
  }

  async original(hash: string): Promise<{ data: Buffer; mime: string } | null> {
    const rows = this.db.prepare('SELECT rel_path FROM tracks WHERE art_hash = ? LIMIT 3').all(hash) as Array<{ rel_path: string }>
    for (const r of rows) {
      try {
        const p = await probeFile(toAbs(this.root, r.rel_path), { covers: true, duration: false })
        if (p.picture) return p.picture
      } catch {
        /* try next */
      }
    }
    return null
  }

  get(hash: string, size: number): Promise<Buffer | null> {
    const s = snapSize(size)
    const key = `${hash}-${s}`
    const file = join(this.cacheDir, `${key}.jpg`)
    if (existsSync(file)) return readFile(file)
    let p = this.inflight.get(key)
    if (!p) {
      p = this.render(hash, s, file).finally(() => this.inflight.delete(key))
      this.inflight.set(key, p)
    }
    return p
  }

  private async render(hash: string, size: number, file: string): Promise<Buffer | null> {
    const orig = await this.original(hash)
    if (!orig) return null
    let out: Buffer
    try {
      out = await sharp(orig.data).rotate().resize(size, size, { fit: 'cover', withoutEnlargement: true }).jpeg({ quality: 85, mozjpeg: true }).toBuffer()
    } catch {
      // sharp can fail on odd images; ffmpeg handles almost anything.
      const tmpIn = `${file}.in`
      await writeFile(tmpIn, orig.data)
      const r = await runFfmpeg(['-y', '-i', tmpIn, '-vf', `scale=${size}:${size}:force_original_aspect_ratio=increase,crop=${size}:${size}`, '-frames:v', '1', '-f', 'mjpeg', '-'], {
        captureStdout: true,
      })
      if (r.code !== 0 || !r.stdout?.length) return null
      out = r.stdout
    }
    await writeFile(file, out)
    return out
  }

  private colors = new Map<string, ArtColor | null>()

  /** A vibrant representative color for UI tinting (hue histogram weighted by saturation/value). */
  async color(hash: string): Promise<ArtColor | null> {
    if (this.colors.has(hash)) return this.colors.get(hash)!
    const buf = await this.get(hash, 64).catch(() => null)
    let out: ArtColor | null = null
    if (buf) {
      try {
        const { data, info } = await sharp(buf).resize(32, 32, { fit: 'cover' }).removeAlpha().raw().toBuffer({ resolveWithObject: true })
        out = pickVibrant(data, info.channels)
      } catch {
        out = null
      }
    }
    this.colors.set(hash, out)
    return out
  }

  async handle(request: Request): Promise<Response> {
    const u = new URL(request.url)
    const hash = u.pathname.replace(/^\/+/, '').replace(/[^0-9a-f]/gi, '')
    const size = Number(u.searchParams.get('s') ?? 300) || 300
    const buf = hash ? await this.get(hash, size).catch(() => null) : null
    if (!buf) return new Response(null, { status: 404 })
    return new Response(new Uint8Array(buf), { headers: { 'content-type': 'image/jpeg', 'cache-control': 'max-age=31536000, immutable', 'access-control-allow-origin': '*' } })
  }
}

export interface ArtColor {
  r: number
  g: number
  b: number
  /** Relative luminance 0..1 of the average image (for choosing light/dark overlays). */
  luminance: number
}

export function pickVibrant(px: Uint8Array | Buffer, channels: number): ArtColor {
  const bins = Array.from({ length: 24 }, () => ({ w: 0, r: 0, g: 0, b: 0 }))
  let lum = 0
  let n = 0
  let gray = { r: 0, g: 0, b: 0 }
  for (let i = 0; i + 2 < px.length; i += channels) {
    const r = px[i], g = px[i + 1], b = px[i + 2]
    const max = Math.max(r, g, b), min = Math.min(r, g, b)
    const v = max / 255
    const sat = max === 0 ? 0 : (max - min) / max
    lum += (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255
    gray.r += r; gray.g += g; gray.b += b
    n++
    if (sat < 0.18 || v < 0.18) continue
    let h = 0
    const d = max - min
    if (max === r) h = ((g - b) / d) % 6
    else if (max === g) h = (b - r) / d + 2
    else h = (r - g) / d + 4
    h = (h * 60 + 360) % 360
    const w = sat * sat * (1 - Math.abs(v - 0.7))
    const bin = bins[Math.floor(h / 15) % 24]
    bin.w += w; bin.r += r * w; bin.g += g * w; bin.b += b * w
  }
  const luminance = n ? lum / n : 0.5
  const best = bins.reduce((a, b) => (b.w > a.w ? b : a))
  if (best.w < n * 0.01) {
    // Monochrome art: a neutral tint derived from the average.
    const k = n || 1
    const avg = (gray.r + gray.g + gray.b) / (3 * k)
    const v = Math.round(Math.min(160, Math.max(110, avg)))
    return { r: v, g: v, b: v + 6, luminance }
  }
  return { r: Math.round(best.r / best.w), g: Math.round(best.g / best.w), b: Math.round(best.b / best.w), luminance }
}
