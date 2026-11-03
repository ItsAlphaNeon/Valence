// Cover art: fetch the best original, keep it for the archive, and produce the embedded version
// (JPEG, fit within maxSize x maxSize, never upscaled).

import { readFile } from 'node:fs/promises'
import sharp from 'sharp'
import type { Transport } from '@main/import/source-types'

export interface Image {
  data: Buffer
  mime: string
}

export function extForMime(mime: string): string {
  if (mime.includes('png')) return 'png'
  if (mime.includes('webp')) return 'webp'
  if (mime.includes('gif')) return 'gif'
  return 'jpg'
}

export function sniffMime(data: Uint8Array): string | null {
  if (data[0] === 0xff && data[1] === 0xd8) return 'image/jpeg'
  if (data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) return 'image/png'
  if (data[0] === 0x52 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x46 && data[8] === 0x57) return 'image/webp'
  if (data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46) return 'image/gif'
  return null
}

/** Tries each URL in order; returns the first response that is really an image. */
export async function fetchImage(urls: string[], transport: Transport, signal?: AbortSignal): Promise<Image | null> {
  for (const url of urls) {
    try {
      const res = await transport(url, { signal, redirect: 'follow' })
      if (!res.ok) continue
      const data = Buffer.from(await res.arrayBuffer())
      const mime = sniffMime(data)
      if (mime && data.length > 1024) return { data, mime }
    } catch (e) {
      if (signal?.aborted) throw e
    }
  }
  return null
}

export async function loadImage(file: string): Promise<Image | null> {
  try {
    const data = await readFile(file)
    const mime = sniffMime(data)
    return mime ? { data, mime } : null
  } catch {
    return null
  }
}

export async function imageSize(img: Image): Promise<{ width: number; height: number } | null> {
  try {
    const m = await sharp(img.data).metadata()
    return m.width && m.height ? { width: m.width, height: m.height } : null
  } catch {
    return null
  }
}

/** The version embedded in library files. JPEGs already within bounds are kept byte-for-byte. */
export async function embeddable(img: Image, maxSize = 2000, quality = 90): Promise<Image> {
  const size = await imageSize(img)
  if (img.mime === 'image/jpeg' && size && size.width <= maxSize && size.height <= maxSize) return img
  const data = await sharp(img.data)
    .rotate()
    .flatten({ background: '#ffffff' })
    .resize(maxSize, maxSize, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality, mozjpeg: true, chromaSubsampling: '4:4:4' })
    .toBuffer()
  return { data, mime: 'image/jpeg' }
}

/** Picks the best of several candidate images (largest pixel area, square-ish preferred). */
export async function pickBest(images: Array<Image | null | undefined>): Promise<Image | null> {
  let best: { img: Image; score: number } | null = null
  for (const img of images) {
    if (!img) continue
    const s = await imageSize(img)
    if (!s) continue
    const aspect = Math.min(s.width, s.height) / Math.max(s.width, s.height)
    const score = s.width * s.height * (aspect > 0.9 ? 1 : 0.5)
    if (!best || score > best.score) best = { img, score }
  }
  return best?.img ?? null
}
