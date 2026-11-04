// Zip unpacking for imports: which entries are kept, how names are made safe, and what is refused.

import { afterAll, describe, expect, it } from 'vitest'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { musicEntryPath, unzip, ZipError } from '@main/import/zip'
import { sandbox } from '../helpers/sandbox'
import { makeZip } from '../fixtures/bandcamp/helpers'

const box = sandbox('zip')
afterAll(() => box.cleanup())

const rel = (dest: string, files: string[]) => files.map((f) => f.slice(dest.length + 1).replace(/\\/g, '/')).sort()

/** Patches every central-directory header (flags at +8, method at +10). */
function patchCentral(buf: Buffer, f: { flags?: number; method?: number }): Buffer {
  const out = Buffer.from(buf)
  for (let i = 0; i <= out.length - 4; i++) {
    if (out.readUInt32LE(i) !== 0x02014b50) continue
    if (f.flags != null) out.writeUInt16LE(f.flags, i + 8)
    if (f.method != null) out.writeUInt16LE(f.method, i + 10)
  }
  return out
}

describe('musicEntryPath', () => {
  it('keeps audio and the sidecars imports use, with Unicode names', () => {
    expect(musicEntryPath('Sigur Rós/Ágætis byrjun/01 Intro.flac')).toBe('Sigur Rós/Ágætis byrjun/01 Intro.flac')
    expect(musicEntryPath('Album/cover.JPG')).toBe('Album/cover.jpg')
    expect(musicEntryPath('Album/rip.log')).toBe('Album/rip.log')
    expect(musicEntryPath('Album/Booklet.pdf')).toBe('Album/Booklet.pdf')
    expect(musicEntryPath('日本語/曲.mp3')).toBe('日本語/曲.mp3')
  })

  it('makes names safe for every filesystem', () => {
    expect(musicEntryPath('Re:Zero/What? "Live".mp3')).toBe("Re-Zero/What 'Live'.mp3")
    expect(musicEntryPath('con/aux.flac')).toBe('_con/_aux.flac')
  })

  it('skips folders, junk and anything that is not music', () => {
    expect(musicEntryPath('Album/')).toBeNull()
    expect(musicEntryPath('__MACOSX/Album/._01.mp3')).toBeNull()
    expect(musicEntryPath('Album/.DS_Store')).toBeNull()
    expect(musicEntryPath('.hidden/01.mp3')).toBeNull()
    expect(musicEntryPath('Album/setup.exe')).toBeNull()
    expect(musicEntryPath('Album/video.mkv')).toBeNull()
    expect(musicEntryPath('Album/nested.zip')).toBeNull()
  })

  it('rejects zip-slip paths', () => {
    expect(() => musicEntryPath('../evil.mp3')).toThrow(ZipError)
    expect(() => musicEntryPath('a/../../evil.mp3')).toThrow(/Unsafe/)
    expect(() => musicEntryPath('C:/evil.mp3')).toThrow(/Unsafe/)
    expect(() => musicEntryPath('/etc/evil.mp3')).toThrow(/Unsafe/)
  })
})

describe('unzip', () => {
  it('extracts only what the mapper keeps', async () => {
    const zip = join(box.dir, 'album.zip')
    writeFileSync(
      zip,
      makeZip([
        { name: 'Album/01 One.mp3', data: 'one' },
        { name: 'Album/02 Two.mp3', data: 'two' },
        { name: 'Album/cover.jpg', data: 'jpg' },
        { name: 'Album/notes.exe', data: 'nope' },
        { name: '__MACOSX/Album/._01 One.mp3', data: 'junk' },
      ]),
    )
    const dest = join(box.dir, 'album-out')
    const files = await unzip(zip, dest, { mapPath: (n) => musicEntryPath(n) })
    expect(rel(dest, files)).toEqual(['Album/01 One.mp3', 'Album/02 Two.mp3', 'Album/cover.jpg'])
    expect(readFileSync(join(dest, 'Album/02 Two.mp3'), 'utf8')).toBe('two')
  })

  it('keeps entries whose safe names collide', async () => {
    const zip = join(box.dir, 'collide.zip')
    writeFileSync(zip, makeZip([{ name: 'A/Song?.mp3', data: '1' }, { name: 'A/Song.mp3', data: '2' }]))
    const dest = join(box.dir, 'collide-out')
    expect(rel(dest, await unzip(zip, dest, { mapPath: (n) => musicEntryPath(n) }))).toEqual(['A/Song (2).mp3', 'A/Song.mp3'])
  })

  it('refuses zip-slip archives before writing anything', async () => {
    const zip = join(box.dir, 'evil.zip')
    writeFileSync(zip, makeZip([{ name: 'ok.mp3', data: 'fine' }, { name: '../evil.mp3', data: 'pwned' }]))
    const dest = join(box.dir, 'evil-out')
    await expect(unzip(zip, dest, { mapPath: (n) => musicEntryPath(n) })).rejects.toMatchObject({ kind: 'unsafe' })
    expect(existsSync(join(box.dir, 'evil.mp3'))).toBe(false)
    expect(existsSync(join(dest, 'ok.mp3'))).toBe(false)
  })

  it('explains password-protected and unsupported zips', async () => {
    const base = makeZip([{ name: 'a.mp3', data: 'x' }])
    const enc = join(box.dir, 'locked.zip')
    writeFileSync(enc, patchCentral(base, { flags: 0x0801, method: 8 }))
    await expect(unzip(enc, join(box.dir, 'locked-out'), { mapPath: (n) => musicEntryPath(n) })).rejects.toMatchObject({
      kind: 'encrypted',
      message: expect.stringMatching(/locked\.zip is password-protected/),
    })
    const d64 = join(box.dir, 'deflate64.zip')
    writeFileSync(d64, patchCentral(base, { method: 9 }))
    await expect(unzip(d64, join(box.dir, 'd64-out'), { mapPath: (n) => musicEntryPath(n) })).rejects.toMatchObject({
      kind: 'unsupported',
      message: expect.stringMatching(/method 9/),
    })
  })

  it('refuses when there is not enough room', async () => {
    const zip = join(box.dir, 'big.zip')
    writeFileSync(zip, makeZip([{ name: 'a.mp3', data: 'x'.repeat(1000) }]))
    await expect(unzip(zip, join(box.dir, 'big-out'), { mapPath: (n) => musicEntryPath(n), maxBytes: 999 })).rejects.toMatchObject({ kind: 'too-large' })
  })

  it('reports a corrupt zip as unreadable', async () => {
    const zip = join(box.dir, 'corrupt.zip')
    writeFileSync(zip, Buffer.concat([Buffer.from('PK\x03\x04'), Buffer.alloc(40)]))
    await expect(unzip(zip, join(box.dir, 'corrupt-out'), { mapPath: (n) => musicEntryPath(n) })).rejects.toMatchObject({
      kind: 'unreadable',
      message: expect.stringMatching(/corrupt\.zip can't be read/),
    })
  })

  it('stops when cancelled', async () => {
    const zip = join(box.dir, 'cancel.zip')
    writeFileSync(zip, makeZip([{ name: 'a.mp3', data: 'x' }]))
    const ctrl = new AbortController()
    ctrl.abort()
    await expect(unzip(zip, join(box.dir, 'cancel-out'), { mapPath: (n) => musicEntryPath(n), signal: ctrl.signal })).rejects.toMatchObject({ kind: 'cancelled' })
  })
})
