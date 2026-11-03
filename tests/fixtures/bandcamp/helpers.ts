// Test helpers for the Bandcamp source: fixture loading, SYNTHETIC page builders, a tiny zip
// writer, fake transports and a local 127.0.0.1 HTTP server.

import { readFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join, resolve } from 'node:path'
import { crc32 } from 'node:zlib'
import type { Transport } from '@main/import/source-types'

export const FIXTURES = resolve('tests/fixtures/bandcamp')

export const fixture = (name: string): string => readFileSync(join(FIXTURES, name), 'utf8')
export const fixtureJson = (name: string): any => JSON.parse(fixture(name))

export const encodeAttr = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/'/g, '&#39;')

export const blobAttr = (o: unknown): string => encodeAttr(JSON.stringify(o))

export function downloadPageHtml(digitalItems: unknown[]): string {
  const data = { identities: { fan: { id: 5550001, username: 'synthfan', verified: true } }, digital_items: digitalItems }
  return `<!DOCTYPE html><html><head><title>Bandcamp</title></head><body>
<div id="pagedata" data-blob="${blobAttr(data)}"></div>
<div class="email-reauth-error" style="display:none">Please confirm your email.</div>
</body></html>`
}

export function tralbumPageHtml(tralbum: unknown, opts: { band?: unknown; ld?: unknown } = {}): string {
  return `<!DOCTYPE html><html><head><title>Release</title>
${opts.ld ? `<script type="application/ld+json">${JSON.stringify(opts.ld)}</script>` : ''}
</head><body>
<script type="text/javascript" data-tralbum="${blobAttr(tralbum)}" data-band="${blobAttr(opts.band ?? {})}" data-embed="{}"></script>
</body></html>`
}

export const statJsonp = (payload: unknown): string => `if ( window.Downloads ) { Downloads.statResult ( ${JSON.stringify(payload)} ) };`

// ---------------------------------------------------------------- zip

export interface ZipEntry {
  name: string
  data: Buffer | string
}

/** Minimal store-only zip writer (UTF-8 names), enough for yauzl. */
export function makeZip(entries: ZipEntry[]): Buffer {
  const locals: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8')
    const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data)
    const crc = crc32(data) >>> 0
    const lh = Buffer.alloc(30)
    lh.writeUInt32LE(0x04034b50, 0)
    lh.writeUInt16LE(20, 4)
    lh.writeUInt16LE(0x0800, 6)
    lh.writeUInt16LE(0, 8)
    lh.writeUInt16LE(0, 10)
    lh.writeUInt16LE(0x21, 12)
    lh.writeUInt32LE(crc, 14)
    lh.writeUInt32LE(data.length, 18)
    lh.writeUInt32LE(data.length, 22)
    lh.writeUInt16LE(name.length, 26)
    lh.writeUInt16LE(0, 28)
    locals.push(lh, name, data)
    const ch = Buffer.alloc(46)
    ch.writeUInt32LE(0x02014b50, 0)
    ch.writeUInt16LE(20, 4)
    ch.writeUInt16LE(20, 6)
    ch.writeUInt16LE(0x0800, 8)
    ch.writeUInt16LE(0, 10)
    ch.writeUInt16LE(0, 12)
    ch.writeUInt16LE(0x21, 14)
    ch.writeUInt32LE(crc, 16)
    ch.writeUInt32LE(data.length, 20)
    ch.writeUInt32LE(data.length, 24)
    ch.writeUInt16LE(name.length, 28)
    ch.writeUInt32LE(offset, 42)
    central.push(ch, name)
    offset += lh.length + name.length + data.length
  }
  const cd = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(cd.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, cd, end])
}

// ---------------------------------------------------------------- fake transport

export interface Call {
  url: string
  method: string
  headers: Record<string, string>
  body?: string
}

export type Route = (url: URL, call: Call) => Response | Promise<Response> | undefined

/** A Transport answering from `route`; unknown URLs get 404. Records every call. */
export function fakeTransport(route: Route): Transport & { calls: Call[] } {
  const calls: Call[] = []
  const fn = (async (url: string, init: RequestInit = {}) => {
    const headers: Record<string, string> = {}
    new Headers(init.headers).forEach((v, k) => (headers[k] = v))
    const call: Call = { url, method: init.method ?? 'GET', headers, body: typeof init.body === 'string' ? init.body : undefined }
    calls.push(call)
    if (init.signal?.aborted) throw new DOMException('aborted', 'AbortError')
    return (await route(new URL(url), call)) ?? new Response('not found', { status: 404 })
  }) as Transport & { calls: Call[] }
  fn.calls = calls
  return fn
}

export const html = (body: string, status = 200): Response => new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8' } })
export const json = (o: unknown, status = 200): Response => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } })

// ---------------------------------------------------------------- local server

export interface LocalServer {
  base: string
  hits: Map<string, number>
  close(): Promise<void>
}

export type ServerHandler = (req: IncomingMessage, res: ServerResponse, url: URL, hit: number) => unknown

/** HTTP server on 127.0.0.1 with per-path hit counters. */
export async function startServer(handler: ServerHandler): Promise<LocalServer> {
  const hits = new Map<string, number>()
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const n = (hits.get(url.pathname) ?? 0) + 1
    hits.set(url.pathname, n)
    Promise.resolve(handler(req, res, url, n)).catch((e) => {
      res.statusCode = 500
      res.end(String(e))
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const { port } = server.address() as AddressInfo
  return {
    base: `http://127.0.0.1:${port}`,
    hits,
    close: () => new Promise<void>((r) => server.close(() => r())),
  }
}
