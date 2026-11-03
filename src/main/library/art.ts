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

  async handle(request: Request): Promise<Response> {
    const u = new URL(request.url)
    const hash = u.pathname.replace(/^\/+/, '').replace(/[^0-9a-f]/gi, '')
    const size = Number(u.searchParams.get('s') ?? 300) || 300
    const buf = hash ? await this.get(hash, size).catch(() => null) : null
    if (!buf) return new Response(null, { status: 404 })
    return new Response(new Uint8Array(buf), { headers: { 'content-type': 'image/jpeg', 'cache-control': 'max-age=31536000, immutable' } })
  }
}
