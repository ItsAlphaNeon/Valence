// placeFile on filesystems without hard links: Windows reports exFAT's refusal as EISDIR. Files must
// still be placed (exclusive copy), never clobber, and never leave a .valence-tmp behind.

import { afterAll, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { sandbox } from '../helpers/sandbox'

const linkError = vi.hoisted(() => ({ code: null as string | null }))
vi.mock('node:fs/promises', async (orig) => {
  const real = await orig<typeof import('node:fs/promises')>()
  return {
    ...real,
    link: async (from: string, to: string) => {
      if (linkError.code) throw Object.assign(new Error(`${linkError.code}: link '${from}' -> '${to}'`), { code: linkError.code })
      return real.link(from, to)
    },
  }
})

import { placeFile } from '@main/library/organizer'

const tmpFiles = (dir: string) => readdirSync(dir).filter((f) => f.endsWith('.valence-tmp'))

describe('placeFile without hard links', () => {
  const sb = sandbox('nolinks')
  afterAll(() => {
    linkError.code = null
    sb.cleanup()
  })

  it('copies into place when link fails with EISDIR (exFAT on Windows)', async () => {
    linkError.code = 'EISDIR'
    const root = join(sb.dir, 'copy')
    const src = join(sb.dir, 'copy-src.flac')
    writeFileSync(src, 'master')
    await placeFile(src, root, 'Artist/Album/Song.flac')
    expect(readFileSync(join(root, 'Artist', 'Album', 'Song.flac'), 'utf8')).toBe('master')
    expect(existsSync(src)).toBe(true)
    expect(tmpFiles(join(root, 'Artist', 'Album'))).toEqual([])

    const moved = join(sb.dir, 'move-src.flac')
    writeFileSync(moved, 'moved master')
    await placeFile(moved, root, 'Artist/Album/Other.flac', { move: true })
    expect(readFileSync(join(root, 'Artist', 'Album', 'Other.flac'), 'utf8')).toBe('moved master')
    expect(existsSync(moved)).toBe(false)
    expect(tmpFiles(join(root, 'Artist', 'Album'))).toEqual([])
  })

  it('still never overwrites an existing file', async () => {
    linkError.code = 'EISDIR'
    const root = join(sb.dir, 'clobber')
    mkdirSync(join(root, 'A'), { recursive: true })
    writeFileSync(join(root, 'A', 'T.flac'), 'old')
    const src = join(sb.dir, 'clobber-src.flac')
    writeFileSync(src, 'new')
    const r = await placeFile(src, root, 'A/T.flac', { move: true, rechoose: async () => 'A/T (2).flac' })
    expect(r.relPath).toBe('A/T (2).flac')
    expect(readFileSync(join(root, 'A', 'T.flac'), 'utf8')).toBe('old')
    expect(readFileSync(join(root, 'A', 'T (2).flac'), 'utf8')).toBe('new')
    expect(tmpFiles(join(root, 'A'))).toEqual([])
  })

  it('puts a moved source back and leaves no temp file when placing fails', async () => {
    linkError.code = 'EACCES'
    const root = join(sb.dir, 'fail')
    const src = join(sb.dir, 'fail-src.flac')
    writeFileSync(src, 'keep me')
    await expect(placeFile(src, root, 'A/T.flac', { move: true })).rejects.toThrow(/EACCES/)
    expect(readFileSync(src, 'utf8')).toBe('keep me')
    expect(tmpFiles(join(root, 'A'))).toEqual([])

    const copySrc = join(sb.dir, 'fail-copy.flac')
    writeFileSync(copySrc, 'copy')
    await expect(placeFile(copySrc, root, 'A/U.flac')).rejects.toThrow(/EACCES/)
    expect(existsSync(copySrc)).toBe(true)
    expect(tmpFiles(join(root, 'A'))).toEqual([])
  })
})
