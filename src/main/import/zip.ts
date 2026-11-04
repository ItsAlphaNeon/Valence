// Zip archives of music. A zip unpacks into a temp folder under staging and is then imported like
// any folder. The temp copy is deleted once no job needs it any more: every job from that zip is
// done, cancelled or removed (failed jobs keep it, so Retry works; a job that finds its files gone
// unpacks the zip again). The zip itself is only read, except in the Inbox, where it moves to
// Inbox/Imported once everything from it has been imported.

import { createHash } from 'node:crypto'
import { createWriteStream, existsSync } from 'node:fs'
import { mkdir, readdir, rm, stat, statfs, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, join, resolve, sep } from 'node:path'
import type { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import yauzl, { type Entry, type ZipFile } from 'yauzl'
import type { DB } from '@main/db/db'
import type { Logger } from '@main/context'
import { isAudioPath } from '@main/tags/read'
import { isIgnoredName, sanitizeComponent } from '@shared/sanitize'

export type ZipErrorKind = 'unsafe' | 'unreadable' | 'encrypted' | 'unsupported' | 'too-large' | 'cancelled'

export class ZipError extends Error {
  constructor(
    message: string,
    readonly kind: ZipErrorKind,
  ) {
    super(message)
    this.name = 'ZipError'
  }
}

export const isZipPath = (p: string): boolean => /\.zip$/i.test(p)

/** Turns a zip entry name into a relative output path, or null to skip it; throws to reject the zip. */
export type EntryMapper = (fileName: string) => string | null

export interface UnzipOptions {
  mapPath: EntryMapper
  signal?: AbortSignal
  /** Refuses (before writing anything) when the kept entries add up to more than this. */
  maxBytes?: number
  /** Names the archive in error messages, e.g. "Bandcamp zip" or the file name. */
  label?: string
}

/** Splits an entry name into safe parts; null for folders and junk; throws on zip-slip. */
export function entryParts(fileName: string, label = 'zip'): string[] | null {
  const norm = fileName.replace(/\\/g, '/')
  if (norm.endsWith('/')) return null
  if (/^([a-zA-Z]:|\/)/.test(norm)) throw new ZipError(`Unsafe path in ${label}: ${fileName}`, 'unsafe')
  const parts = norm.split('/').filter((p) => p !== '' && p !== '.')
  if (parts.includes('..')) throw new ZipError(`Unsafe path in ${label}: ${fileName}`, 'unsafe')
  if (!parts.length || parts.some((p) => p === '__MACOSX') || isIgnoredName(parts[parts.length - 1])) return null
  return parts
}

/** Audio plus the sidecars a loose import uses (cover art, booklets, cue sheets, rip logs). */
const SIDECAR = /\.(jpe?g|png|webp|pdf|cue|log)$/i

function safeFileName(name: string): string {
  const ext = extname(name).replace(/[^.A-Za-z0-9]/g, '').slice(0, 10).toLowerCase()
  const stem = ext ? name.slice(0, name.length - extname(name).length) : name
  return `${sanitizeComponent(stem, 100)}${ext}`
}

/** Mapper for music zips: keeps audio and sidecars (Unicode names kept, made filesystem-safe). */
export function musicEntryPath(fileName: string, label?: string): string | null {
  const parts = entryParts(fileName, label)
  if (!parts || parts.some((p) => p.startsWith('.'))) return null
  const last = parts[parts.length - 1]
  if (!isAudioPath(last) && !SIDECAR.test(last)) return null
  return [...parts.slice(0, -1).map((p) => sanitizeComponent(p)), safeFileName(last)].join('/')
}

function uniquePath(path: string, used: Set<string>): string {
  const ext = extname(path)
  const stem = path.slice(0, path.length - ext.length)
  let p = path
  for (let i = 2; used.has(p.toLowerCase()); i++) p = `${stem} (${i})${ext}`
  used.add(p.toLowerCase())
  return p
}

const UNSAFE_MSG = /relative path|absolute path|invalid characters/i

function openZip(path: string, label: string): Promise<ZipFile> {
  return new Promise((res, rej) =>
    yauzl.open(path, { lazyEntries: true, decodeStrings: true, validateEntrySizes: true, autoClose: false }, (err, zip?: ZipFile) =>
      err || !zip ? rej(new ZipError(`${label} can't be read: ${err?.message ?? 'unknown error'}`, 'unreadable')) : res(zip),
    ),
  )
}

/** Reads the central directory (no data), so everything can be checked before writing. */
function readEntries(zip: ZipFile, label: string): Promise<Entry[]> {
  return new Promise((res, rej) => {
    const out: Entry[] = []
    zip.on('entry', (e: Entry) => {
      out.push(e)
      zip.readEntry()
    })
    zip.on('end', () => res(out))
    zip.on('error', (e: Error) => rej(UNSAFE_MSG.test(e.message) ? new ZipError(`Unsafe path in ${label}: ${e.message}`, 'unsafe') : new ZipError(`${label} can't be read: ${e.message}`, 'unreadable')))
    zip.readEntry()
  })
}

function openStream(zip: ZipFile, entry: Entry): Promise<Readable> {
  return new Promise((res, rej) => zip.openReadStream(entry, (e, rs) => (e || !rs ? rej(e ?? new Error('no stream')) : res(rs))))
}

const gb = (n: number) => `${(n / 1024 ** 3).toFixed(n < 10 * 1024 ** 3 ? 1 : 0)} GB`

/** Extracts the entries `mapPath` keeps into destDir; resolves with the written paths (zip order). */
export async function unzip(zipPath: string, destDir: string, opts: UnzipOptions): Promise<string[]> {
  const label = opts.label ?? basename(zipPath)
  const { signal } = opts
  const zip = await openZip(zipPath, label)
  try {
    const entries = await readEntries(zip, label)
    const root = resolve(destDir)
    const used = new Set<string>()
    const plan: Array<{ entry: Entry; target: string }> = []
    let total = 0
    for (const entry of entries) {
      const rel = opts.mapPath(entry.fileName)
      if (rel === null) continue
      const target = uniquePath(resolve(root, rel), used)
      if (!target.startsWith(root + sep)) throw new ZipError(`Unsafe path in ${label}: ${entry.fileName}`, 'unsafe')
      if (entry.generalPurposeBitFlag & 1) throw new ZipError(`${label} is password-protected. Extract it yourself, then import the folder.`, 'encrypted')
      if (entry.compressionMethod !== 0 && entry.compressionMethod !== 8)
        throw new ZipError(`${label} uses a compression method Valence can't read (method ${entry.compressionMethod}). Extract it yourself, then import the folder.`, 'unsupported')
      total += entry.uncompressedSize
      plan.push({ entry, target })
    }
    if (opts.maxBytes != null && total > opts.maxBytes)
      throw new ZipError(`Not enough free space to unpack ${label}: it needs ${gb(total)}, ${gb(Math.max(0, opts.maxBytes))} is available.`, 'too-large')
    const out: string[] = []
    for (const { entry, target } of plan) {
      if (signal?.aborted) throw new ZipError('Cancelled', 'cancelled')
      await mkdir(dirname(target), { recursive: true })
      const rs = await openStream(zip, entry)
      await pipeline(rs, createWriteStream(target), signal ? { signal } : {})
      out.push(target)
    }
    return out
  } catch (e) {
    if (signal?.aborted && !(e instanceof ZipError && e.kind !== 'cancelled')) throw new ZipError('Cancelled', 'cancelled')
    if (e instanceof ZipError || (e as { kind?: unknown })?.kind) throw e
    const msg = (e as Error)?.message ?? String(e)
    throw new ZipError(UNSAFE_MSG.test(msg) ? `Unsafe path in ${label}: ${msg}` : `${label} couldn't be unpacked: ${msg}`, UNSAFE_MSG.test(msg) ? 'unsafe' : 'unreadable')
  } finally {
    zip.close()
  }
}

// ---------------------------------------------------------------- temp folders for imports

/** Where a zip unpacks to: `dir` is the temp folder; `content` (inside it, named after the zip) holds the files. */
export interface ZipLocation {
  zip: string
  dir: string
  content: string
}

const COMPLETE = '.complete'
/** Kept free on the staging drive after unpacking. */
const RESERVE_BYTES = 1024 ** 3
const LIVE = "('queued', 'running', 'review', 'failed')"

export class ZipStaging {
  private locks = new Map<string, Promise<ZipLocation>>()
  private ready: Promise<void> = Promise.resolve()

  constructor(
    /** e.g. <staging>/zips */
    readonly root: string,
    private db: DB,
    private log: Logger,
  ) {}

  /**
   * Same zip file (path, size and mtime) → same folder, so a second drop or an Inbox sweep reuses
   * an unpack that's already there. A changed zip gets a new folder.
   */
  async locate(zipPath: string): Promise<ZipLocation> {
    const zip = resolve(zipPath)
    const st = await stat(zip)
    const id = createHash('sha1').update(`${zip.toLowerCase()}|${st.size}|${Math.floor(st.mtimeMs)}`).digest('hex').slice(0, 12)
    const dir = join(this.root, id)
    const name = sanitizeComponent(basename(zip).replace(/\.zip$/i, ''), 60)
    return { zip, dir, content: join(dir, name === '_' ? 'Archive' : name) }
  }

  /** Unpacks the zip (or reuses a complete earlier unpack of the same file). */
  async unpack(zipPath: string, signal?: AbortSignal): Promise<ZipLocation> {
    await this.ready
    const loc = await this.locate(zipPath)
    const running = this.locks.get(loc.dir)
    if (running) return running
    const p = this.doUnpack(loc, signal).finally(() => this.locks.delete(loc.dir))
    this.locks.set(loc.dir, p)
    return p
  }

  private async doUnpack(loc: ZipLocation, signal?: AbortSignal): Promise<ZipLocation> {
    if (existsSync(join(loc.dir, COMPLETE))) return loc
    await rm(loc.dir, { recursive: true, force: true })
    await mkdir(loc.dir, { recursive: true })
    try {
      const fs = await statfs(loc.dir).catch(() => null)
      const label = basename(loc.zip)
      await unzip(loc.zip, loc.content, {
        mapPath: (n) => musicEntryPath(n, label),
        signal,
        label,
        maxBytes: fs ? fs.bavail * fs.bsize - RESERVE_BYTES : undefined,
      })
      await writeFile(join(loc.dir, COMPLETE), JSON.stringify({ zip: loc.zip, at: Date.now() }))
      return loc
    } catch (e) {
      await rm(loc.dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }).catch(() => {})
      throw e
    }
  }

  /** True while a queued, running, in-review or failed job still needs this folder. */
  inUse(dir: string): boolean {
    return !!this.db.prepare(`SELECT 1 FROM jobs WHERE status IN ${LIVE} AND json_extract(payload_json, '$.zip.dir') = ? LIMIT 1`).get(dir)
  }

  /** Deletes the temp folder unless a job still needs it (or it's being unpacked); true when it's gone. */
  async release(dir: string): Promise<boolean> {
    if (!this.isOurs(dir) || this.locks.has(dir) || this.inUse(dir)) return false
    try {
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
      return true
    } catch (e) {
      this.log.warn(`zip: could not delete ${dir}`, (e as Error).message)
      return false
    }
  }

  /** Startup: deletes temp folders no job refers to (left by a crash or an old version). Unpacks wait for it. */
  sweep(): Promise<void> {
    this.ready = (async () => {
      let names: string[] = []
      try {
        names = await readdir(this.root)
      } catch {
        return
      }
      for (const n of names) await this.release(join(this.root, n))
    })()
    return this.ready
  }

  private isOurs(dir: string): boolean {
    const d = resolve(dir)
    return dirname(d) === resolve(this.root)
  }
}
