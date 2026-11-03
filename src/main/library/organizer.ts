// Computes library paths for tracks and places files without ever overwriting: files are staged
// under an ASCII temp name in the target folder and hard-linked into place (link fails with
// EEXIST instead of replacing), so Syncthing never sees partial files or silent clobbers.

import { randomBytes } from 'node:crypto'
import { copyFile, link, mkdir, open, readdir, rename, rmdir, stat, unlink } from 'node:fs/promises'
import { constants } from 'node:fs'
import { dirname, join } from 'node:path'
import type { TrackTags } from '@shared/types'
import { DEFAULT_TEMPLATE, renderRelStem } from '@shared/path-template'
import { foldKey, sanitizeComponent } from '@shared/sanitize'
import { effectiveAlbumArtist } from './indexer'

export const TMP_SUFFIX = '.valence-tmp'

export function toAbs(root: string, rel: string): string {
  return join(root, ...rel.split('/'))
}

/** Reuses the on-disk casing of existing folders so case-insensitive and case-sensitive devices agree. */
export async function resolveDirCasing(root: string, relDir: string): Promise<string> {
  const parts = relDir.split('/').filter(Boolean)
  const out: string[] = []
  for (const part of parts) {
    let names: string[] = []
    try {
      names = await readdir(toAbs(root, out.join('/')))
    } catch {
      out.push(part)
      continue
    }
    const key = foldKey(part)
    out.push(names.find((n) => foldKey(n) === key) ?? part)
  }
  return out.join('/')
}

export interface CollisionContext {
  tags: TrackTags
  /** True when the existing file at that path is this same track (re-placing over itself). */
  isSelf?: (relPath: string) => boolean
}

/** Suffix candidates for a title collision, in order: disc, track artist, then a counter. */
export function collisionSuffixes(tags: TrackTags): string[] {
  const out: string[] = []
  if (tags.discnumber && (tags.totaldiscs ?? 0) > 1) out.push(` (Disc ${tags.discnumber})`)
  const albumArtist = effectiveAlbumArtist(tags)
  if (tags.artist && foldKey(tags.artist) !== foldKey(albumArtist)) out.push(` (${sanitizeComponent(tags.artist, 40)})`)
  for (let n = 2; n < 100; n++) out.push(` (${n})`)
  return out
}

async function listFolded(absDir: string): Promise<Set<string>> {
  try {
    return new Set((await readdir(absDir)).map(foldKey))
  } catch {
    return new Set()
  }
}

/** Picks a free relative path for a track, honouring collisions within the target folder. */
export async function chooseRelPath(
  root: string,
  tags: TrackTags,
  ext: string,
  opts: { template?: string; isSelf?: (rel: string) => boolean; taken?: Set<string> } = {},
): Promise<string> {
  const stem = renderRelStem(opts.template ?? DEFAULT_TEMPLATE, tags)
  const slash = stem.lastIndexOf('/')
  const relDir = await resolveDirCasing(root, slash < 0 ? '' : stem.slice(0, slash))
  const base = slash < 0 ? stem : stem.slice(slash + 1)
  const existing = await listFolded(toAbs(root, relDir))
  const free = (name: string) => {
    const rel = relDir ? `${relDir}/${name}` : name
    if (opts.isSelf?.(rel)) return true
    return !existing.has(foldKey(name)) && !opts.taken?.has(foldKey(rel))
  }
  const dotExt = ext.startsWith('.') ? ext : `.${ext}`
  for (const suffix of ['', ...collisionSuffixes(tags)]) {
    const name = `${sanitizeComponent(base + suffix)}${dotExt}`
    if (free(name)) return relDir ? `${relDir}/${name}` : name
  }
  return `${relDir}/${base} (${randomBytes(3).toString('hex')})${dotExt}`
}

function tmpName(): string {
  return `.${randomBytes(6).toString('hex')}${TMP_SUFFIX}`
}

async function fsyncFile(path: string): Promise<void> {
  const fh = await open(path, 'r+')
  try {
    await fh.sync()
  } finally {
    await fh.close()
  }
}

/** Atomically links `tmp` to `final`; never replaces an existing file. Returns false if `final` exists. */
async function linkNoClobber(tmp: string, final: string): Promise<boolean> {
  try {
    await link(tmp, final)
    await unlink(tmp)
    return true
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    if (code === 'EEXIST') return false
    if (code === 'EPERM' || code === 'ENOTSUP' || code === 'EXDEV' || code === 'EOPNOTSUPP' || code === 'ENOSYS') {
      // Filesystem without hard links (exFAT, some network shares): exclusive copy instead.
      try {
        await copyFile(tmp, final, constants.COPYFILE_EXCL)
      } catch (e2) {
        if ((e2 as NodeJS.ErrnoException).code === 'EEXIST') return false
        throw e2
      }
      await unlink(tmp)
      return true
    }
    throw e
  }
}

export interface PlaceResult {
  relPath: string
  absPath: string
}

/**
 * Copies `src` into the library at `relPath` (or the next free collision name, re-chosen via
 * `rechoose` if the path got taken concurrently).
 */
export async function placeFile(
  src: string,
  root: string,
  relPath: string,
  opts: { rechoose?: () => Promise<string>; move?: boolean } = {},
): Promise<PlaceResult> {
  let rel = relPath
  for (let attempt = 0; attempt < 5; attempt++) {
    const final = toAbs(root, rel)
    const dir = dirname(final)
    await mkdir(dir, { recursive: true })
    const tmp = join(dir, tmpName())
    if (opts.move) {
      try {
        await rename(src, tmp)
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EXDEV') throw e
        await copyFile(src, tmp)
        await fsyncFile(tmp)
        await unlink(src)
      }
    } else {
      await copyFile(src, tmp)
      await fsyncFile(tmp)
    }
    if (await linkNoClobber(tmp, final)) return { relPath: rel, absPath: final }
    if (opts.move) src = tmp
    else await unlink(tmp).catch(() => {})
    if (!opts.rechoose) throw new Error(`Target exists: ${rel}`)
    rel = await opts.rechoose()
  }
  throw new Error(`Could not place file at ${relPath}`)
}

/** Moves a file inside the library without clobbering. Handles case-only renames. */
export async function moveWithinLibrary(root: string, fromRel: string, toRel: string): Promise<void> {
  if (fromRel === toRel) return
  const from = toAbs(root, fromRel)
  const to = toAbs(root, toRel)
  await mkdir(dirname(to), { recursive: true })
  if (foldKey(fromRel) === foldKey(toRel)) {
    const tmp = join(dirname(to), tmpName())
    await rename(from, tmp)
    await rename(tmp, to)
  } else {
    if (!(await linkNoClobber(from, to))) throw new Error(`Target exists: ${toRel}`)
    // linkNoClobber unlinks its first argument on success.
  }
  await pruneEmptyDirs(root, dirname(fromRel.replace(/\//g, '/')))
}

/** Removes now-empty folders from `relDir` upwards (never the root). Ignores OS junk files. */
export async function pruneEmptyDirs(root: string, relDir: string): Promise<void> {
  let rel = relDir === '.' ? '' : relDir
  while (rel) {
    const abs = toAbs(root, rel)
    let names: string[]
    try {
      names = await readdir(abs)
    } catch {
      return
    }
    const junk = names.filter((n) => /^(desktop\.ini|thumbs\.db|\.ds_store)$/i.test(n))
    if (names.length !== junk.length) return
    for (const j of junk) await unlink(join(abs, j)).catch(() => {})
    try {
      await rmdir(abs)
    } catch {
      return
    }
    const i = rel.lastIndexOf('/')
    rel = i < 0 ? '' : rel.slice(0, i)
  }
}

export async function fileExists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  )
}
