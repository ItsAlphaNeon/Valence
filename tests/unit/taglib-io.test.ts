import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import fs, { copyFileSync, readFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { ByteVector, File } from 'node-taglib-sharp'
import { genAudio } from '../helpers/audio'
import { sandbox } from '../helpers/sandbox'
import { MOVE_CHUNK } from '@main/tags/taglib-io'
import { writeTags } from '@main/tags/write'
import { probeFile } from '@main/tags/read'
import { pcmMd5 } from '@main/media/ffmpeg'

// The byte moves node-taglib-sharp makes when a tag changes size (replaced in taglib-io.ts).
describe('taglib file moves', () => {
  const sb = sandbox('taglib-io')
  let src: string
  let original: Buffer
  beforeAll(async () => {
    // ~3 MB (320 kbps CBR), so moves span several chunks.
    src = await genAudio(join(sb.dir, 'src.mp3'), 'mp3_320', { seconds: 80 })
    original = readFileSync(src)
    expect(original.length).toBeGreaterThan(2 * MOVE_CHUNK)
  })
  afterAll(() => sb.cleanup())
  afterEach(() => vi.restoreAllMocks())

  let n = 0
  function edit(fn: (f: File) => void): Buffer {
    const path = join(sb.dir, `case-${n++}.mp3`)
    copyFileSync(src, path)
    const f = File.createFromPath(path)
    try {
      fn(f)
    } finally {
      f.dispose()
    }
    return readFileSync(path)
  }

  const splice = (start: number, replace: number, data: Buffer) => Buffer.concat([original.subarray(0, start), data, original.subarray(start + replace)])

  // [name, (file length) => [start, bytes replaced, bytes written]]
  const insertCases: Array<[string, (size: number) => [number, number, number]]> = [
    ['grows by 2 at the start', () => [0, 100, 102]],
    ['grows by 2 in the middle', () => [1_234_567, 10, 12]],
    ['grows by more than a chunk', () => [4096, 0, MOVE_CHUNK + 333]],
    ['grows near the end (tail shorter than the growth)', (size) => [size - 50, 20, 5000]],
    ['writes at the very end', (size) => [size, 0, 10]],
    ['same size', () => [5000, 64, 64]],
    ['shrinks by 2', () => [0, 102, 100]],
    ['shrinks by more than a chunk', () => [100, MOVE_CHUNK + 777, 5]],
  ]

  for (const [name, at] of insertCases) {
    it(`insert: ${name}`, () => {
      const [start, replace, len] = at(original.length)
      const data = randomBytes(len)
      const out = edit((f) => f.insert(ByteVector.fromByteArray(data), start, replace))
      expect(out.equals(splice(start, replace, data))).toBe(true)
    })
  }

  it('insert: a small growth takes a handful of writes, not one per byte moved', () => {
    const spy = vi.spyOn(fs, 'writeSync')
    edit((f) => f.insert(ByteVector.fromByteArray(randomBytes(3)), 10, 1))
    expect(spy.mock.calls.length).toBeLessThan(10)
  })

  it('removeBlock: middle, end and past the end', () => {
    expect(edit((f) => f.removeBlock(777, 2)).equals(splice(777, 2, Buffer.alloc(0)))).toBe(true)
    expect(edit((f) => f.removeBlock(100, MOVE_CHUNK * 2)).equals(splice(100, MOVE_CHUNK * 2, Buffer.alloc(0)))).toBe(true)
    expect(edit((f) => f.removeBlock(original.length - 10, 10)).equals(original.subarray(0, original.length - 10))).toBe(true)
    expect(edit((f) => f.removeBlock(original.length - 10, 500)).equals(original.subarray(0, original.length - 10))).toBe(true)
    expect(edit((f) => f.removeBlock(10, 0)).equals(original)).toBe(true)
  })

  it('removeBlock: moves in chunks, not 1 KB at a time', () => {
    const spy = vi.spyOn(fs, 'writeSync')
    edit((f) => f.removeBlock(10, 1))
    expect(spy.mock.calls.length).toBeLessThan(10)
  })
})

// The YouTube season renumber: a track number gaining digits grows the Vorbis comment by a few bytes.
describe('opus renumber', () => {
  const sb = sandbox('taglib-opus')
  afterAll(() => sb.cleanup())

  it('rewrites a growing track number quickly and keeps the audio intact', async () => {
    const path = await genAudio(join(sb.dir, 'rip.opus'), 'opus', { seconds: 60 })
    writeTags(path, { title: 'Rip', album: 'SiIvaGunner: Season 9', tracknumber: 7, totaltracks: 9 })
    const audio = await pcmMd5(path)
    const spy = vi.spyOn(fs, 'writeSync')
    writeTags(path, { title: 'Rip', album: 'SiIvaGunner: Season 9', tracknumber: 123, totaltracks: 300 })
    expect(spy.mock.calls.length).toBeLessThan(100)
    spy.mockRestore()
    const r = await probeFile(path)
    expect(r.tags.tracknumber).toBe(123)
    expect(r.tags.totaltracks).toBe(300)
    expect(Math.round(r.format.durationMs / 1000)).toBe(60)
    expect(await pcmMd5(path)).toBe(audio)
  })
})

// Ogg packets that are a multiple of 255 bytes long need a closing 0 lacing value.
describe('ogg comment packets of a multiple of 255 bytes', () => {
  const sb = sandbox('taglib-ogg')
  afterAll(() => sb.cleanup())

  interface PageInfo { start: number; flags: number; segs: number[]; dataStart: number; end: number }
  function pages(buf: Buffer): PageInfo[] {
    const out: PageInfo[] = []
    for (let pos = 0; pos + 27 <= buf.length && buf.toString('latin1', pos, pos + 4) === 'OggS'; ) {
      const n = buf[pos + 26]
      const segs = [...buf.subarray(pos + 27, pos + 27 + n)]
      const dataStart = pos + 27 + n
      const end = dataStart + segs.reduce((a, b) => a + b, 0)
      out.push({ start: pos, flags: buf[pos + 5], segs, dataStart, end })
      pos = end
    }
    return out
  }
  /** The comment packet (second header packet, from page 1): its length and whether a lacing value below 255 closes it. */
  function comment(buf: Buffer): { length: number; closed: boolean; page: PageInfo } {
    const all = pages(buf)
    let length = 0
    for (let i = 1; i < all.length; i++) {
      for (const s of all[i].segs) {
        length += s
        if (s < 255) return { length, closed: true, page: all[i] }
      }
      if (!(all[i + 1] && all[i + 1].flags & 1)) return { length, closed: false, page: all[i] }
    }
    throw new Error('no comment packet')
  }

  let path: string
  let audio: string
  let fill = -1
  beforeAll(async () => {
    path = await genAudio(join(sb.dir, 'rip.opus'), 'opus', { seconds: 20 })
    audio = await pcmMd5(path)
    // Grow the comment a byte at a time until the packet is an exact multiple of 255.
    for (let k = 0; k < 300 && fill < 0; k++) {
      writeTags(path, { title: 'Rip', album: 'SiIvaGunner: Season X', tracknumber: 1, comment: 'x'.repeat(k) })
      if (comment(readFileSync(path)).length % 255 === 0) fill = k
    }
    expect(fill).toBeGreaterThanOrEqual(0)
  })

  it('closes the packet when writing it', () => {
    const c = comment(readFileSync(path))
    expect(c.length % 255).toBe(0)
    expect(c.closed).toBe(true)
  })

  it('reads and rewrites a file written without the closing value, keeping the audio', async () => {
    // Recreate what earlier writes left: drop the closing 0 and re-checksum the page.
    const buf = readFileSync(path)
    const c = comment(buf)
    expect(buf[c.page.dataStart - 1]).toBe(0)
    const page = Buffer.concat([buf.subarray(c.page.start, c.page.dataStart - 1), buf.subarray(c.page.dataStart, c.page.end)])
    page[26] -= 1
    page.writeUInt32LE(0, 22)
    page.writeUInt32LE(ByteVector.fromByteArray(page).checksum, 22)
    const broken = join(sb.dir, 'broken.opus')
    fs.writeFileSync(broken, Buffer.concat([buf.subarray(0, c.page.start), page, buf.subarray(c.page.end)]))
    expect(comment(readFileSync(broken)).closed).toBe(false)

    expect((await probeFile(broken)).tags.tracknumber).toBe(1)
    writeTags(broken, { title: 'Rip', album: 'SiIvaGunner: Season X', tracknumber: 85, totaltracks: 231, comment: 'x'.repeat(fill) })
    expect(comment(readFileSync(broken)).closed).toBe(true)
    expect((await probeFile(broken)).tags).toMatchObject({ tracknumber: 85, totaltracks: 231 })
    expect(await pcmMd5(broken)).toBe(audio)
  })
})
