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
