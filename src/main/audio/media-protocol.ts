// valence-media://file/<base64url(path)>[.ext] - byte-range file serving for the <audio> fallback engine.

import { protocol } from 'electron'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { extname } from 'node:path'
import { Readable } from 'node:stream'
import type { AudioAccess } from './access'
import { decodeMediaUrl, MEDIA_MIME, MEDIA_SCHEME, parseRange } from './media-url'

/**
 * Electron only honours one registerSchemesAsPrivileged() call (later calls override the
 * renderer switches), so every privileged Valence scheme is registered here.
 */
export function registerPrivilegedSchemes(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: MEDIA_SCHEME, privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true, corsEnabled: true } },
    { scheme: 'valence-art', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
  ])
}

export function registerMediaProtocol(access: AudioAccess): void {
  protocol.handle(MEDIA_SCHEME, async (req) => {
    const path = decodeMediaUrl(req.url)
    const real = path ? access.resolve(path) : null
    const base = { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' }
    if (!real) return new Response('Not found', { status: 404, headers: base })
    let size: number
    try {
      size = (await stat(real)).size
    } catch {
      return new Response('Not found', { status: 404, headers: base })
    }
    const headers: Record<string, string> = {
      ...base,
      'Accept-Ranges': 'bytes',
      'Content-Type': MEDIA_MIME[extname(real).toLowerCase()] ?? 'application/octet-stream',
    }
    const range = parseRange(req.headers.get('range'), size)
    if (range === 'invalid') return new Response(null, { status: 416, headers: { ...headers, 'Content-Range': `bytes */${size}` } })
    const { start, end } = range ?? { start: 0, end: size - 1 }
    headers['Content-Length'] = String(size === 0 ? 0 : end - start + 1)
    if (range) headers['Content-Range'] = `bytes ${start}-${end}/${size}`
    const status = range ? 206 : 200
    if (req.method === 'HEAD' || size === 0) return new Response(null, { status, headers })
    const body = Readable.toWeb(createReadStream(real, { start, end })) as unknown as ReadableStream
    return new Response(body, { status, headers })
  })
}
