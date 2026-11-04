// Loose files: expand dropped/picked paths into audio files, cluster them by album folder, and
// enqueue one import job per cluster. Originals are only read, never modified or moved (except
// Inbox files, which move to Inbox/Imported afterwards). Zips (dropped, picked, or inside a folder)
// unpack to a temp folder first and are planned like folders; see zip.ts for the cleanup.

import { createHash } from 'node:crypto'
import { opendir, stat } from 'node:fs/promises'
import { basename, dirname, join, relative, sep } from 'node:path'
import type { Acquirer, ImportQueue } from '@main/context'
import { isAudioPath, probeFile } from '@main/tags/read'
import { clusterFiles } from '@main/metadata'
import { isIgnoredName } from '@shared/sanitize'
import type { TrackTags } from '@shared/types'
import type { SourceRelease } from './source-types'
import { isZipPath, type ZipLocation, type ZipStaging } from './zip'

export interface LoosePayload {
  files: string[]
  /** Paths relative to this folder feed the folder/filename heuristics. */
  base: string
  artwork?: string
  extras?: string[]
  inbox?: boolean
  title: string
  /** Set when the files came out of a zip: the zip, and the temp folder its contents are in. */
  zip?: { path: string; dir: string; inbox?: boolean }
}

export interface PlanOptions {
  inbox?: boolean
  skip?: (abs: string) => boolean
  /** Unpacks zips (on their own or inside folders) and plans their contents too; without it zips are ignored. */
  zips?: ZipStaging | null
  /** Leaves a zip out (the Inbox skips zips that already have jobs or failed before). */
  skipZip?: (loc: ZipLocation) => boolean
  /** A zip that couldn't be unpacked, or had no music in it. */
  onZipError?: (zip: string, message: string, loc: ZipLocation | null) => void
}

const COVER_NAMES = /^(cover|folder|front|albumart(?:_\{.*\}_large)?|albumartlarge|artwork)\.(jpe?g|png|webp)$/i
const EXTRA_EXT = /\.(pdf|cue|log|txt|nfo|jpe?g|png|webp)$/i

async function walk(dir: string, out: string[], others: string[], skip?: (abs: string) => boolean): Promise<void> {
  let d
  try {
    d = await opendir(dir)
  } catch {
    return
  }
  for await (const e of d) {
    if (isIgnoredName(e.name) || e.name.startsWith('.')) continue
    const p = join(dir, e.name)
    if (skip?.(p)) continue
    if (e.isDirectory()) await walk(p, out, others, skip)
    else if (e.isFile()) (isAudioPath(p) ? out : others).push(p)
  }
}

/** Expands files/folders into audio files (sorted) plus sidecar files (zips among them). */
export async function expandPaths(paths: string[], skip?: (abs: string) => boolean): Promise<{ audio: string[]; others: string[] }> {
  const audio: string[] = []
  const others: string[] = []
  for (const p of paths) {
    try {
      const st = await stat(p)
      if (st.isDirectory()) await walk(p, audio, others, skip)
      else if (st.isFile()) (isAudioPath(p) ? audio : others).push(p)
    } catch {
      /* vanished */
    }
  }
  const uniq = (xs: string[]) => [...new Set(xs)].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
  return { audio: uniq(audio), others: uniq(others) }
}

function commonDir(files: string[]): string {
  if (!files.length) return ''
  let parts = dirname(files[0]).split(sep)
  for (const f of files.slice(1)) {
    const q = dirname(f).split(sep)
    let i = 0
    while (i < parts.length && i < q.length && parts[i].toLowerCase() === q[i].toLowerCase()) i++
    parts = parts.slice(0, i)
  }
  return parts.join(sep)
}

export function looseKey(files: string[]): string {
  return 'import:' + createHash('sha1').update([...files].sort().join('\n')).digest('hex').slice(0, 20)
}

/** Probes tags (fast, no art) and groups audio files into album clusters → payloads. */
async function planFiles(audio: string[], others: string[], inbox: boolean | undefined): Promise<LoosePayload[]> {
  if (!audio.length) return []
  // Base = parent of the common folder, so the album folder name itself is part of the relPath.
  const common = commonDir(audio)
  const base = audio.length === 1 || dirname(common) === common ? common : dirname(common)
  const probed = await Promise.all(
    audio.map(async (f) => {
      let tags: TrackTags = {}
      try {
        tags = (await probeFile(f, { covers: false, duration: false })).tags
      } catch {
        /* unreadable files still get a job so the report shows the error */
      }
      return { relPath: relative(base, f).split(sep).join('/'), tags }
    }),
  )
  const clusters = clusterFiles(probed)
  return clusters.map((idx) => {
    const files = idx.map((i) => audio[i])
    const dirs = new Set(files.map((f) => dirname(f).toLowerCase()))
    const parentDirs = new Set([...dirs].map((d) => dirname(d)))
    const nearby = others.filter((o) => dirs.has(dirname(o).toLowerCase()) || parentDirs.has(dirname(o).toLowerCase()))
    const cover = nearby.find((o) => COVER_NAMES.test(basename(o)) && dirs.has(dirname(o).toLowerCase())) ?? nearby.find((o) => COVER_NAMES.test(basename(o)))
    const t = probed[idx[0]].tags
    const title = t.album ? `${t.albumartist ?? t.artist ?? 'Unknown'} — ${t.album}` : basename(dirname(files[0])) || basename(files[0])
    return {
      files,
      base,
      artwork: cover,
      extras: nearby.filter((o) => EXTRA_EXT.test(o) && o !== cover && /\.(pdf|cue|log)$/i.test(o)),
      inbox,
      title,
    }
  })
}

/** Plans an import of files, folders and zips → one payload per album cluster. */
export async function planLooseImport(paths: string[], opts: PlanOptions = {}): Promise<LoosePayload[]> {
  const { audio, others } = await expandPaths(paths, opts.skip)
  const zips = opts.zips ? others.filter(isZipPath) : []
  const payloads = await planFiles(
    audio,
    others.filter((o) => !isZipPath(o)),
    opts.inbox,
  )
  for (const z of zips) payloads.push(...(await planZip(z, opts.zips!, opts)))
  return payloads
}

async function planZip(zip: string, zips: ZipStaging, opts: PlanOptions): Promise<LoosePayload[]> {
  let loc: ZipLocation | null = null
  try {
    loc = await zips.locate(zip)
    if (opts.skipZip?.(loc)) return []
    loc = await zips.unpack(zip)
  } catch (e) {
    opts.onZipError?.(zip, (e as Error)?.message ?? String(e), loc)
    return []
  }
  const inner = await expandPaths([loc.content])
  const planned = await planFiles(inner.audio, inner.others, undefined)
  if (!planned.length) {
    await zips.release(loc.dir)
    opts.onZipError?.(zip, `No music found in ${basename(zip)}`, loc)
    return []
  }
  const { zip: path, dir } = loc
  return planned.map((p) => ({ ...p, zip: { path, dir, ...(opts.inbox ? { inbox: true } : {}) } }))
}

export function enqueueLoose(queue: ImportQueue, payloads: LoosePayload[]): string[] {
  return payloads.map((p) => queue.enqueue({ source: 'import', title: p.title, releaseKeys: [looseKey(p.files)], payload: p }))
}

const existing = async (files: string[]) => (await Promise.all(files.map((f) => stat(f).then(() => f, () => null)))).filter((f): f is string => !!f)

/** Acquirer for loose imports. With `zips`, a zip job whose temp copy was cleaned up (Retry, restart) unpacks the zip again. */
export function createLooseAcquirer(zips: ZipStaging | null = null): Acquirer {
  return async (payload: LoosePayload, opts): Promise<SourceRelease> => {
    // Re-check existence: the job may have waited (or been restarted) since it was planned.
    let present = await existing(payload.files)
    if (present.length < payload.files.length && payload.zip && zips) {
      const name = basename(payload.zip.path)
      opts?.progress?.({ phase: 'processing', fraction: 0, message: `Unpacking ${name}` })
      try {
        const loc = await zips.unpack(payload.zip.path, opts?.signal)
        if (loc.dir !== payload.zip.dir) {
          // A different file now: its unpack isn't what this job planned, so don't leave it behind.
          await zips.release(loc.dir)
          if (!present.length) throw new Error(`${name} has changed since it was added; import it again`)
        }
      } catch (e) {
        if (!present.length) throw e
      }
      present = await existing(payload.files)
    }
    if (!present.length) throw new Error(payload.zip ? `${basename(payload.zip.path)} is no longer there` : 'The files are no longer there')
    return looseRelease(payload, present)
  }
}

export const looseAcquirer: Acquirer = createLooseAcquirer()

function looseRelease(payload: LoosePayload, present: string[]): SourceRelease {
  return {
    source: 'import',
    releaseKeys: [looseKey(payload.files)],
    albumTags: {},
    tracks: present.map((file) => ({ file, tags: {}, raw: { relPath: relative(payload.base, file).split(sep).join('/') } })),
    artwork: payload.artwork ? { file: payload.artwork } : undefined,
    extras: payload.extras,
    title: payload.title,
  }
}
