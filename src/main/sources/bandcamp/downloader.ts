// Bandcamp FLAC download: redownload page → statdownload (wait while Bandcamp encodes) → stream
// into staging → unzip (ASCII names, zip-slip guarded) → match audio files to the tracklist.

import { createWriteStream } from 'node:fs'
import { mkdir, open, rename, rm } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ReadableStream as NodeReadableStream } from 'node:stream/web'
import { unzip, ZipError } from '@main/import/zip'
import { SourceError, type ProgressFn } from '@main/import/source-types'
import { isAudioPath, probeFile, type ProbeResult } from '@main/tags/read'
import { isIgnoredName, matchKey, sanitizeComponent } from '@shared/sanitize'
import { cancelled, discard, sleep as defaultSleep, statusError, type BandcampClient, type SleepFn } from './client'
import {
  parseDownloadPage,
  parseStatResponse,
  pickDigitalItem,
  toStatUrl,
  type BcDigitalItem,
  type BcTrack,
  type DownloadPage,
} from './parse'

// ---------------------------------------------------------------- filenames

const TRANSLIT: Record<string, string> = { ß: 'ss', æ: 'ae', Æ: 'AE', ø: 'o', Ø: 'O', œ: 'oe', Œ: 'OE', đ: 'd', Đ: 'D', ł: 'l', Ł: 'L', þ: 'th', Þ: 'Th' }

/** ASCII-only, filesystem-safe file name (extension kept). */
export function asciiName(name: string): string {
  const a = name
    .replace(/[ßæÆøØœŒđĐłŁþÞ]/g, (c) => TRANSLIT[c] ?? '_')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[‘’`´]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[‐-―]/g, '-')
    .replace(/[^\x20-\x7e]/g, '_')
  const ext = extname(a).replace(/[^.A-Za-z0-9]/g, '').slice(0, 10)
  const stem = sanitizeComponent(ext ? a.slice(0, -extname(a).length) : a, 120)
  return `${stem}${ext.toLowerCase()}`
}

const unsafe = (name: string) => new SourceError(`Unsafe path in Bandcamp zip: ${name}`, 'parse')

/** Relative, ASCII-sanitized path for a zip entry; null for directories/junk; throws on zip-slip. */
export function safeEntryPath(fileName: string): string | null {
  const norm = fileName.replace(/\\/g, '/')
  if (norm.endsWith('/')) return null
  if (/^([a-zA-Z]:|\/)/.test(norm)) throw unsafe(fileName)
  const parts = norm.split('/').filter((p) => p !== '' && p !== '.')
  if (parts.includes('..')) throw unsafe(fileName)
  if (!parts.length || parts.some((p) => p === '__MACOSX') || isIgnoredName(parts[parts.length - 1])) return null
  return parts.map(asciiName).join('/')
}

/** Extracts every file entry into destDir; resolves with the written paths. */
export async function extractZip(zipPath: string, destDir: string, signal?: AbortSignal): Promise<string[]> {
  try {
    return await unzip(zipPath, destDir, { mapPath: safeEntryPath, signal, label: 'Bandcamp zip' })
  } catch (e) {
    if (e instanceof SourceError) throw e
    if (e instanceof ZipError) throw e.kind === 'cancelled' ? cancelled() : new SourceError(e.kind === 'unreadable' ? `Bandcamp zip extraction failed: ${e.message}` : e.message, 'parse')
    throw new SourceError(`Bandcamp zip extraction failed: ${(e as Error)?.message ?? String(e)}`, 'parse')
  }
}

export async function readMagic(path: string, n = 4): Promise<Buffer> {
  const fh = await open(path, 'r')
  try {
    const buf = Buffer.alloc(n)
    const { bytesRead } = await fh.read(buf, 0, n, 0)
    return buf.subarray(0, bytesRead)
  } finally {
    await fh.close()
  }
}

export const isZipMagic = (b: Buffer): boolean => b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04
const isFlacMagic = (b: Buffer): boolean => b.subarray(0, 4).toString('latin1') === 'fLaC'

/** File name from Content-Disposition (RFC 5987 `filename*` preferred). */
export function dispositionFilename(header: string | null): string | undefined {
  if (!header) return undefined
  const star = /filename\*\s*=\s*([^']*)'[^']*'([^;]+)/i.exec(header)
  if (star) {
    try {
      return decodeURIComponent(star[2].trim().replace(/^"|"$/g, ''))
    } catch {
      // fall through
    }
  }
  const plain = /filename\s*=\s*"([^"]*)"|filename\s*=\s*([^;]+)/i.exec(header)
  return (plain?.[1] ?? plain?.[2])?.trim() || undefined
}

// ---------------------------------------------------------------- track matching

export interface AudioCandidate {
  file: string
  tagTrackNo?: number
  tagTitle?: string
}

const FILENAME_RE = /^(.+) - (.+) - (\d{2,3}) (.+)\.flac$/i

function similarity(a: string, b: string): number {
  const x = matchKey(a)
  const y = matchKey(b)
  if (!x || !y) return 0
  if (x === y) return 1
  if (x.includes(y) || y.includes(x)) return 0.9 * (Math.min(x.length, y.length) / Math.max(x.length, y.length)) + 0.1
  const grams = (s: string) => {
    const m = new Map<string, number>()
    for (let i = 0; i < s.length - 1; i++) m.set(s.slice(i, i + 2), (m.get(s.slice(i, i + 2)) ?? 0) + 1)
    return m
  }
  const gx = grams(x)
  const gy = grams(y)
  let common = 0
  for (const [g, c] of gx) common += Math.min(c, gy.get(g) ?? 0)
  return (2 * common) / Math.max(1, x.length - 1 + (y.length - 1))
}

/**
 * Assigns audio files to tracklist entries: embedded TRACKNUMBER first, then Bandcamp's
 * "Artist - Album - NN Title.flac" file name, then title similarity.
 */
export function matchTracks(files: AudioCandidate[], tracks: BcTrack[]): Map<string, BcTrack> {
  const out = new Map<string, BcTrack>()
  const taken = new Set<number>()
  const byNum = new Map<number, BcTrack | null>()
  for (const t of tracks) byNum.set(t.trackNum, byNum.has(t.trackNum) ? null : t)
  const assign = (f: AudioCandidate, t: BcTrack | null | undefined) => {
    if (!t || taken.has(t.trackId) || out.has(f.file)) return
    out.set(f.file, t)
    taken.add(t.trackId)
  }
  // A single-track release needs no evidence.
  if (files.length === 1 && tracks.length === 1) {
    assign(files[0], tracks[0])
    return out
  }
  for (const f of files) if (f.tagTrackNo) assign(f, byNum.get(f.tagTrackNo))
  for (const f of files) {
    const m = FILENAME_RE.exec(basename(f.file))
    if (m) assign(f, byNum.get(Number(m[3])))
  }
  const pairs: Array<{ f: AudioCandidate; t: BcTrack; s: number }> = []
  for (const f of files) {
    if (out.has(f.file)) continue
    const name = basename(f.file, extname(f.file))
    const titles = [f.tagTitle, FILENAME_RE.exec(basename(f.file))?.[4], name.replace(/^\d{1,3}[\s.\-_]+/, '')].filter(Boolean) as string[]
    for (const t of tracks) {
      if (taken.has(t.trackId)) continue
      const s = Math.max(...titles.map((x) => similarity(x, t.title)))
      if (s >= 0.5) pairs.push({ f, t, s })
    }
  }
  pairs.sort((a, b) => b.s - a.s)
  for (const p of pairs) assign(p.f, p.t)
  return out
}

export interface ProbedFile {
  file: string
  probe: ProbeResult
  track?: BcTrack
}

export async function probeAndMatch(files: string[], tracks: BcTrack[]): Promise<ProbedFile[]> {
  const probed = await Promise.all(files.map(async (file) => ({ file, probe: await probeFile(file, { covers: false }) })))
  const matched = matchTracks(
    probed.map((p) => ({ file: p.file, tagTrackNo: p.probe.tags.tracknumber, tagTitle: p.probe.tags.title })),
    tracks,
  )
  return probed.map((p) => ({ ...p, track: matched.get(p.file) }))
}

// ---------------------------------------------------------------- download flow

export interface DownloadOptions {
  client: BandcampClient
  redownloadUrl: string
  want?: { saleItemId?: number; tralbumId?: number }
  /** Folder for the .part file and the extracted release (created if missing). */
  stagingDir: string
  signal: AbortSignal
  progress: ProgressFn
  /** Injectable for tests. */
  sleep?: SleepFn
  /** First encoding/retry wait; doubles each time. Default 5 s. */
  pollBaseMs?: number
  /** Longest single wait. Default 2 min. */
  pollMaxMs?: number
  /** Total time to wait for Bandcamp to prepare the file. Default 10 min. */
  maxWaitMs?: number
  /** Called when the redownload page is gone, to fetch a fresh link from the collection. */
  refreshRedownloadUrl?: () => Promise<string | null>
}

export interface DownloadResult {
  digital: BcDigitalItem
  dir: string
  audio: string[]
  extras: string[]
}

class ExpiredLink extends Error {}

const isHtml = (res: Response) => /^text\/html\b/i.test(res.headers.get('content-type') ?? '')
const isDeadLinkStatus = (s: number) => s === 403 || s === 404 || s === 410

class Backoff {
  private attempt = 0
  private waited = 0
  constructor(private readonly o: Required<Pick<DownloadOptions, 'signal' | 'progress'>> & { sleep: SleepFn; base: number; max: number; total: number }) {}

  async wait(message: string): Promise<void> {
    const delay = Math.min(this.o.base * 2 ** this.attempt, this.o.max, this.o.total - this.waited)
    if (delay <= 0) throw new SourceError('Bandcamp is still preparing this download; try again later', 'network', 5 * 60_000)
    this.attempt++
    this.waited += delay
    this.o.progress({ phase: 'waiting', message: `${message} (retrying in ${Math.round(delay / 1000)} s)` })
    await this.o.sleep(delay, this.o.signal)
  }
}

async function loadDownloadPage(o: DownloadOptions, url: string): Promise<DownloadPage | null> {
  const { text } = await o.client.text(url, o.signal)
  return parseDownloadPage(text)
}

async function resolveFlac(o: DownloadOptions): Promise<{ digital: BcDigitalItem; url: string }> {
  let page: DownloadPage | null = null
  try {
    page = await loadDownloadPage(o, o.redownloadUrl)
  } catch (e) {
    if (!(e instanceof SourceError) || e.kind !== 'unavailable' || !o.refreshRedownloadUrl) throw e
  }
  if ((!page || !page.items.length) && o.refreshRedownloadUrl) {
    const fresh = await o.refreshRedownloadUrl()
    if (fresh && fresh !== o.redownloadUrl) page = await loadDownloadPage(o, fresh)
  }
  if (!page) throw new SourceError('Bandcamp download page has no data (logged out?)', 'auth')
  if (page.emailReauth) throw new SourceError('Bandcamp wants you to re-confirm your email before downloading (open the download page in a browser)', 'auth')
  const digital = pickDigitalItem(page, o.want ?? {})
  if (!digital) throw new SourceError('No downloadable item on the Bandcamp download page', 'unavailable')
  if (!digital.flacUrl) {
    const formats = Object.keys(digital.downloads)
    if (!formats.length && page.fanVerified === false) throw new SourceError('Bandcamp account email is not verified', 'auth')
    throw new SourceError(
      digital.preorder ? 'Pre-order: not downloadable yet' : `No FLAC download offered${formats.length ? ` (formats: ${formats.join(', ')})` : ''}`,
      'unavailable',
    )
  }
  return { digital, url: digital.flacUrl }
}

/** Polls statdownload + a 1-byte probe until the file is ready, then opens the full GET. */
async function openReadyDownload(o: DownloadOptions, startUrl: string, backoff: Backoff): Promise<Response> {
  let url = startUrl
  for (;;) {
    if (o.signal.aborted) throw cancelled()
    const statUrl = toStatUrl(url)
    if (statUrl) {
      const res = await o.client.request(statUrl, { signal: o.signal })
      const stat = res.ok ? parseStatResponse(await res.text()) : (await discard(res), null)
      if (stat && stat.result !== 'ok' && stat.retryUrl) {
        url = stat.retryUrl
        await backoff.wait('Bandcamp is preparing the download')
        continue
      }
      if (stat?.result === 'err') throw new ExpiredLink(stat.errorType ?? 'stat error')
      if (stat?.downloadUrl) url = stat.downloadUrl
    }
    const probe = await o.client.request(url, { signal: o.signal, headers: { Range: 'bytes=0-0' } })
    await discard(probe)
    if (probe.status >= 500) {
      await backoff.wait('Bandcamp is encoding the FLAC files')
      continue
    }
    if (isDeadLinkStatus(probe.status) || (probe.ok && isHtml(probe))) throw new ExpiredLink(`probe ${probe.status}`)
    if (!probe.ok) throw statusError(probe.status, 'Bandcamp file probe')

    const res = await o.client.request(url, { signal: o.signal })
    if (res.status >= 500) {
      await discard(res)
      await backoff.wait('Bandcamp is encoding the FLAC files')
      continue
    }
    if (isDeadLinkStatus(res.status) || (res.ok && isHtml(res))) {
      await discard(res)
      throw new ExpiredLink(`GET ${res.status}`)
    }
    if (!res.ok) {
      await discard(res)
      throw statusError(res.status, 'Bandcamp file download')
    }
    return res
  }
}

async function writeBody(res: Response, part: string, o: DownloadOptions): Promise<number> {
  if (!res.body) throw new SourceError('Bandcamp returned an empty download', 'network')
  const total = Number(res.headers.get('content-length')) || 0
  let received = 0
  let last = 0
  const count = async function* (src: AsyncIterable<Uint8Array>) {
    for await (const chunk of src) {
      received += chunk.byteLength
      const now = Date.now()
      if (now - last > 250) {
        last = now
        o.progress({
          phase: 'downloading',
          fraction: total ? Math.min(1, received / total) : undefined,
          message: `${(received / 1048576).toFixed(1)}${total ? ` / ${(total / 1048576).toFixed(1)}` : ''} MB`,
        })
      }
      yield chunk
    }
  }
  try {
    await pipeline(Readable.fromWeb(res.body as unknown as NodeReadableStream<Uint8Array>), count, createWriteStream(part), { signal: o.signal })
  } catch (e) {
    if (o.signal.aborted) throw cancelled()
    throw e instanceof SourceError ? e : new SourceError(`Bandcamp download interrupted: ${(e as Error)?.message ?? e}`, 'network')
  }
  if (total && received < total && !res.headers.get('content-encoding')) {
    throw new SourceError(`Bandcamp download truncated (${received} of ${total} bytes)`, 'network')
  }
  o.progress({ phase: 'downloading', fraction: 1 })
  return received
}

/** Downloads the FLAC release for one purchase into `stagingDir/bandcamp-<id>/`. */
export async function downloadRelease(o: DownloadOptions): Promise<DownloadResult> {
  const backoff = new Backoff({
    signal: o.signal,
    progress: o.progress,
    sleep: o.sleep ?? defaultSleep,
    base: o.pollBaseMs ?? 5000,
    max: o.pollMaxMs ?? 120_000,
    total: o.maxWaitMs ?? 10 * 60_000,
  })
  o.progress({ phase: 'resolving', message: 'Opening Bandcamp download page' })
  let resolved = await resolveFlac(o)
  let refetched = false
  let res: Response
  for (;;) {
    try {
      res = await openReadyDownload(o, resolved.url, backoff)
      break
    } catch (e) {
      if (!(e instanceof ExpiredLink)) throw e
      if (refetched) throw new SourceError(`Bandcamp download link expired (${e.message})`, 'unavailable')
      refetched = true
      o.progress({ phase: 'resolving', message: 'Download link expired; refreshing' })
      resolved = await resolveFlac(o)
    }
  }

  const { digital } = resolved
  const id = digital.tralbumId ?? digital.itemId
  await mkdir(o.stagingDir, { recursive: true })
  const part = join(o.stagingDir, `bandcamp-${id}.part`)
  const dir = join(o.stagingDir, `bandcamp-${id}`)
  await rm(dir, { recursive: true, force: true })
  await mkdir(dir, { recursive: true })
  try {
    await writeBody(res, part, o)
    o.progress({ phase: 'processing', message: 'Unpacking' })
    const magic = await readMagic(part)
    let files: string[]
    if (isZipMagic(magic)) {
      files = await extractZip(part, dir, o.signal)
    } else {
      let name = asciiName(dispositionFilename(res.headers.get('content-disposition')) ?? `${digital.artist} - ${digital.title}.flac`)
      if (isFlacMagic(magic) && extname(name).toLowerCase() !== '.flac') name += '.flac'
      const target = join(dir, name)
      await rename(part, target)
      files = [target]
    }
    const audio = files.filter(isAudioPath).sort()
    const extras = files.filter((f) => !isAudioPath(f)).sort()
    if (!audio.length) throw new SourceError('Bandcamp download contained no audio files', 'parse')
    return { digital, dir, audio, extras }
  } finally {
    await rm(part, { force: true })
  }
}
