// Album art for the UI, served on the valence-art:// protocol:
//   valence-art://img/<artHash>?s=<px>   square thumbnail, rendered on demand from the embedded
//                                         picture of any track carrying that hash and cached in
//                                         <dataDir>/cache/art
//   valence-art://img/<artHash>?s=0      the embedded picture itself, full size (not cached on disk)
//   valence-art://original/<albumId>     the album's archived cover-original.<jpg|png|webp>

import { existsSync, mkdirSync, statSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { extname, isAbsolute, join, relative, resolve } from 'node:path'
import sharp from 'sharp'
import type { DB } from '@main/db/db'
import type { ArtOriginal } from '@shared/ipc/library'
import { probeFile } from '@main/tags/read'
import { runFfmpeg } from '@main/media/ffmpeg'
import { toAbs } from './organizer'

export const ART_SCHEME = 'valence-art'
const SIZES = [64, 128, 300, 600, 1200]

/** Thumbnail URL; size 0 means the embedded picture at its original size. */
export function artUrl(hash: string | null | undefined, size = 300): string | undefined {
  return hash ? `${ART_SCHEME}://img/${hash}?s=${size}` : undefined
}

const ORIGINAL_NAMES = ['cover-original.jpg', 'cover-original.png', 'cover-original.webp', 'cover-original.jpeg']
const MIME_BY_EXT: Record<string, string> = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif' }

/** `rel` resolved under `root`, or null if it would leave it. */
export function insideRoot(root: string, rel: string): string | null {
  const base = resolve(root)
  const abs = resolve(base, ...rel.split('/').filter((p) => p && p !== '.'))
  const r = relative(base, abs)
  return r && !r.startsWith('..') && !isAbsolute(r) ? abs : null
}

export function snapSize(s: number): number {
  return SIZES.find((x) => x >= s) ?? SIZES[SIZES.length - 1]
}

export class ArtCache {
  private inflight = new Map<string, Promise<Buffer | null>>()
  /** The last few full-size pictures (the zoom viewer opens one at a time). */
  private originals = new Map<string, { data: Buffer; mime: string }>()

  constructor(
    private db: DB,
    private root: string,
    private cacheDir: string,
    /** Archive folders that may hold <album rel_dir>/cover-original.*; read on each call (it can change). */
    private archiveRoots: () => Array<string | null | undefined> = () => [],
  ) {
    mkdirSync(cacheDir, { recursive: true })
  }

  private async fullSize(hash: string): Promise<{ data: Buffer; mime: string } | null> {
    const hit = this.originals.get(hash)
    if (hit) {
      this.originals.delete(hash)
      this.originals.set(hash, hit)
      return hit
    }
    const orig = await this.original(hash)
    if (!orig) return null
    this.originals.set(hash, orig)
    while (this.originals.size > 4) this.originals.delete(this.originals.keys().next().value!)
    return orig
  }

  /** The archived cover-original file of an album, if an archive folder holds one. */
  archivedCover(albumId: number): { path: string; mtimeMs: number } | null {
    const a = this.db.prepare('SELECT rel_dir FROM albums WHERE id = ?').get(albumId) as { rel_dir: string } | undefined
    if (!a?.rel_dir) return null
    for (const root of this.archiveRoots()) {
      if (!root) continue
      const dir = insideRoot(root, a.rel_dir)
      if (!dir) continue
      for (const name of ORIGINAL_NAMES) {
        const file = join(dir, name)
        try {
          const st = statSync(file)
          if (st.isFile()) return { path: file, mtimeMs: Math.round(st.mtimeMs) }
        } catch {
          /* not there */
        }
      }
    }
    return null
  }

  /** Best full-resolution cover for an album: the archived original, else the embedded picture. */
  originalFor(albumId: number): ArtOriginal | null {
    const id = Math.floor(Number(albumId))
    if (!Number.isFinite(id)) return null
    const archived = this.archivedCover(id)
    if (archived) return { url: `${ART_SCHEME}://original/${id}?v=${archived.mtimeMs}`, source: 'archive' }
    const a = this.db.prepare('SELECT art_hash FROM albums WHERE id = ?').get(id) as { art_hash: string | null } | undefined
    return a?.art_hash ? { url: artUrl(a.art_hash, 0)!, source: 'embedded' } : null
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
    const headers = { 'cache-control': 'max-age=31536000, immutable', 'access-control-allow-origin': '*' }
    if (u.hostname === 'original') {
      const id = Number(u.pathname.replace(/^\/+/, ''))
      const file = Number.isInteger(id) ? this.archivedCover(id) : null
      const data = file ? await readFile(file.path).catch(() => null) : null
      if (!file || !data) return new Response(null, { status: 404 })
      return new Response(new Uint8Array(data), { headers: { ...headers, 'content-type': MIME_BY_EXT[extname(file.path).toLowerCase()] ?? 'image/jpeg' } })
    }
    const hash = u.pathname.replace(/^\/+/, '').replace(/[^0-9a-f]/gi, '')
    const s = u.searchParams.get('s')
    const size = s === null || s === '' ? 300 : Number(s)
    if (hash && size === 0) {
      const orig = await this.fullSize(hash).catch(() => null)
      if (!orig) return new Response(null, { status: 404 })
      return new Response(new Uint8Array(orig.data), { headers: { ...headers, 'content-type': orig.mime || 'image/jpeg' } })
    }
    const buf = hash ? await this.get(hash, Number.isFinite(size) && size > 0 ? size : 300).catch(() => null) : null
    if (!buf) return new Response(null, { status: 404 })
    return new Response(new Uint8Array(buf), { headers: { ...headers, 'content-type': 'image/jpeg' } })
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
