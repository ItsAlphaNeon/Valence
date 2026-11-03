// Public Google Drive folders without an account: list via embeddedfolderview, download via
// drive.usercontent.google.com. Requests are paced; quota and CAPTCHA pages become SourceErrors the
// import queue understands (rate-limit backs off; a CAPTCHA pauses the source for the user).

import { createWriteStream } from 'node:fs'
import { mkdir, rename, rm } from 'node:fs/promises'
import { dirname } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ReadableStream as NodeReadableStream } from 'node:stream/web'
import { SourceError, type Transport } from '@main/import/source-types'
import { classifyDriveHtml, parseDriveFolder, type DriveEntry, type DriveListing } from './parse'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'
const LIST_URL = 'https://drive.google.com/embeddedfolderview?id='
const FILE_URL = 'https://drive.usercontent.google.com/download?export=download&confirm=t&id='
const QUOTA_RETRY_MS = 60 * 60_000

export interface DriveFile extends DriveEntry {
  /** Path inside the release folder ("Disc 2/01 Track.flac"). */
  path: string
}

export type SleepFn = (ms: number, signal?: AbortSignal) => Promise<void>

const sleep: SleepFn = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new SourceError('Cancelled', 'cancelled'))
    const t = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => (clearTimeout(t), reject(new SourceError('Cancelled', 'cancelled'))), { once: true })
  })

export class DriveClient {
  private last = 0

  constructor(
    private transport: Transport,
    private opts: { gapMs?: number; sleep?: SleepFn } = {},
  ) {}

  /** At most one request start per gap (default 400 ms), so a whole album doesn't hammer Drive. */
  private async pace(signal?: AbortSignal): Promise<void> {
    const gap = this.opts.gapMs ?? 400
    const wait = this.last + gap - Date.now()
    this.last = Math.max(Date.now(), this.last + gap)
    if (wait > 0) await (this.opts.sleep ?? sleep)(wait, signal)
  }

  private async get(url: string, signal?: AbortSignal): Promise<Response> {
    await this.pace(signal)
    try {
      return await this.transport(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' }, signal, redirect: 'follow' })
    } catch (e) {
      if (signal?.aborted) throw new SourceError('Cancelled', 'cancelled')
      throw new SourceError(`Google Drive request failed: ${(e as Error)?.message ?? e}`, 'network')
    }
  }

  async listFolder(id: string, signal?: AbortSignal): Promise<DriveListing> {
    const res = await this.get(LIST_URL + encodeURIComponent(id), signal)
    if (res.status === 404) throw new SourceError('This Google Drive folder no longer exists', 'unavailable')
    if (res.status === 429) throw new SourceError('Google Drive is rate limiting requests', 'rate-limit', 5 * 60_000)
    if (!res.ok) throw new SourceError(`Google Drive folder listing failed: HTTP ${res.status}`, res.status >= 500 ? 'network' : 'unavailable')
    const html = await res.text()
    const listing = parseDriveFolder(html)
    if (listing) return listing
    const k = classifyDriveHtml(html)
    if (k.kind === 'captcha') throw captchaError()
    if (/accounts\.google\.com|ServiceLogin/i.test(res.url + html.slice(0, 4000))) throw new SourceError('This Google Drive folder is not public', 'unavailable')
    throw new SourceError('Google Drive returned an unexpected page for this folder', 'parse')
  }

  /** Every file below a folder (subfolders flattened into paths), at most `depth` levels deep. */
  async listTree(id: string, signal?: AbortSignal, depth = 3, prefix = ''): Promise<{ title: string | null; files: DriveFile[] }> {
    const listing = await this.listFolder(id, signal)
    const files: DriveFile[] = []
    for (const e of listing.entries) {
      if (!e.folder) files.push({ ...e, path: prefix + e.name })
      else if (depth > 0) files.push(...(await this.listTree(e.id, signal, depth - 1, `${prefix}${e.name}/`)).files)
    }
    return { title: listing.title, files }
  }

  /** Downloads one file to `dest` (via a .part file). */
  async download(id: string, dest: string, signal: AbortSignal, onBytes?: (received: number, total: number) => void): Promise<number> {
    let url = FILE_URL + encodeURIComponent(id)
    for (let hop = 0; hop < 2; hop++) {
      const res = await this.get(url, signal)
      if (res.status === 404) throw new SourceError('A file in this Google Drive folder no longer exists', 'unavailable')
      if (res.status === 429) throw new SourceError('Google Drive is rate limiting downloads', 'rate-limit', 10 * 60_000)
      if (res.status === 403) throw new SourceError('Google Drive refused the download (quota or sharing limit)', 'rate-limit', QUOTA_RETRY_MS)
      if (!res.ok) throw new SourceError(`Google Drive download failed: HTTP ${res.status}`, res.status >= 500 ? 'network' : 'unavailable')
      if (/^text\/html/i.test(res.headers.get('content-type') ?? '')) {
        const k = classifyDriveHtml(await res.text())
        if (k.kind === 'confirm' && hop === 0) {
          url = k.url
          continue
        }
        if (k.kind === 'captcha') throw captchaError()
        if (k.kind === 'quota') throw new SourceError('Google Drive download quota for this file is used up; retrying later', 'rate-limit', QUOTA_RETRY_MS)
        if (k.kind === 'missing') throw new SourceError('A file in this Google Drive folder no longer exists', 'unavailable')
        throw new SourceError('Google Drive returned a web page instead of the file', 'network')
      }
      return writeBody(res, dest, signal, onBytes)
    }
    throw new SourceError('Google Drive kept asking for confirmation', 'network')
  }
}

function captchaError(): SourceError {
  // 'abuse' pauses the whole source with this message until the user resumes it from Import.
  return new SourceError('Google Drive asked for a CAPTCHA (it suspects automated downloads). Wait a while, then resume from Import.', 'abuse')
}

async function writeBody(res: Response, dest: string, signal: AbortSignal, onBytes?: (received: number, total: number) => void): Promise<number> {
  if (!res.body) throw new SourceError('Google Drive returned an empty file', 'network')
  const total = Number(res.headers.get('content-length')) || 0
  const part = `${dest}.part`
  await mkdir(dirname(dest), { recursive: true })
  let received = 0
  const count = async function* (src: AsyncIterable<Uint8Array>) {
    for await (const chunk of src) {
      received += chunk.byteLength
      onBytes?.(received, total)
      yield chunk
    }
  }
  try {
    await pipeline(Readable.fromWeb(res.body as unknown as NodeReadableStream<Uint8Array>), count, createWriteStream(part), { signal })
  } catch (e) {
    await rm(part, { force: true })
    if (signal.aborted) throw new SourceError('Cancelled', 'cancelled')
    throw new SourceError(`Google Drive download interrupted: ${(e as Error)?.message ?? e}`, 'network')
  }
  if (total && received < total) {
    await rm(part, { force: true })
    throw new SourceError(`Google Drive download truncated (${received} of ${total} bytes)`, 'network')
  }
  await rename(part, dest)
  return received
}
