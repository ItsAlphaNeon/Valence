// Fixes for node-taglib-sharp (6.0.3), whose tag writer runs synchronously on the main process.
//
// Moving audio data when a tag changes size:
//   - File.insert (tag grew) shuffles the rest of the file in chunks the size of the growth, so a
//     track number going from "7" to "123" moves a 2 MB Opus file 2 bytes at a time: a million
//     reads and a million writes, about 4 s with the whole app frozen.
//   - File.removeBlock (tag shrank) moves it 1 KB at a time.
// Both are replaced with the same moves in 1 MB chunks.
//
// Ogg packets that are a multiple of 255 bytes long. Ogg sizes a packet with 255-byte lacing values
// and ends it with one below 255, so such a packet needs a closing 0. The port dropped TagLib's
// "is this packet complete?" check and leaves the 0 out whenever the packet is last on its page,
// so about one tag write in 255 leaves the comment packet unterminated. Players read it as ending at
// the page boundary; node-taglib-sharp can't, and every later write to that file fails ("page
// header must be at least 27 bytes"). The writer now closes complete packets, and the reader
// accepts files already written that way so they can be rewritten correctly.
//
// Imported for its side effect by the tag writer, before any file is opened.

import { createRequire } from 'node:module'
import { File, FileAccessMode, OggFile, type ByteVector } from 'node-taglib-sharp'

/** Bytes moved per read and per write. */
export const MOVE_CHUNK = 1 << 20

function checkOffset(v: number, name: string): void {
  if (!Number.isSafeInteger(v) || v < 0) throw new Error(`Argument out of range: ${name} must be a safe, positive integer`)
}

const originalInsert = File.prototype.insert

File.prototype.insert = function (this: File, data: ByteVector, start: number, replace = 0): void {
  // Same size or smaller: the original overwrites in place, then calls removeBlock (below).
  if (!data || data.length <= replace) return originalInsert.call(this, data, start, replace)
  checkOffset(start, 'start')
  checkOffset(replace, 'replace')
  this.mode = FileAccessMode.Write
  const grow = data.length - replace
  const tail = start + replace
  // Everything after the replaced block moves `grow` bytes later. Last chunk first, so no chunk is
  // overwritten before it has been read.
  for (let end = this.length; end > tail; ) {
    const n = Math.min(MOVE_CHUNK, end - tail)
    this.seek(end - n)
    const block = this.readBlock(n)
    this.seek(end - n + grow)
    this.writeBlock(block)
    end -= n
  }
  this.seek(start)
  this.writeBlock(data)
}

File.prototype.removeBlock = function (this: File, start: number, length: number): void {
  checkOffset(start, 'start')
  if (!Number.isSafeInteger(length)) throw new Error('Argument out of range: length must be a safe integer')
  if (length <= 0) return
  this.mode = FileAccessMode.Write
  const end = this.length
  let write = start
  // Everything after the removed block moves `length` bytes earlier, first chunk first.
  for (let read = start + length; read < end; ) {
    this.seek(read)
    const block = this.readBlock(Math.min(MOVE_CHUNK, end - read))
    if (!block.length) break
    this.seek(write)
    this.writeBlock(block)
    read += block.length
    write += block.length
  }
  ;(this as unknown as { truncate(length: number): void }).truncate(write)
}

// ---- Ogg ----

// The page classes aren't exported from the package root; these are the same module instances it uses.
const internal = createRequire(import.meta.url)
interface PageHeader {
  flags: number
  size: number
  streamSerialNumber: number
  packetSizes: number[]
  lastPacketComplete: boolean
  _lastPacketComplete: boolean
  render(): ByteVector
}
interface Page {
  header: PageHeader
  /** Header plus data, as on disk. */
  size: number
}
interface BitStream {
  codec: { readPacket(packet: ByteVector): boolean }
  _previousPacket?: ByteVector
  readPage(page: Page): boolean
}
const { OggPageHeader, OggPageFlags } = internal('node-taglib-sharp/dist/ogg/oggPageHeader.js') as {
  OggPageHeader: { prototype: PageHeader }
  OggPageFlags: { FirstPacketContinued: number; FirstPageOfStream: number }
}
const OggPage = (internal('node-taglib-sharp/dist/ogg/oggPage.js') as { default: { fromFile(file: File, position: number): Page } }).default
const OggPaginator = (internal('node-taglib-sharp/dist/ogg/oggPaginator.js') as { default: { prototype: { paginate(): { change: number; pages: Page[] } } } }).default
const OggBitStream = (internal('node-taglib-sharp/dist/ogg/oggBitStream.js') as { default: new (page: Page) => BitStream }).default

// Writing: a page's last packet is complete unless the next page continues it.
const originalPaginate = OggPaginator.prototype.paginate
OggPaginator.prototype.paginate = function (this: unknown) {
  const result = originalPaginate.call(this)
  result.pages.forEach((page, i) => {
    const next = result.pages[i + 1]
    page.header._lastPacketComplete = !next || (next.header.flags & OggPageFlags.FirstPacketContinued) === 0
  })
  return result
}

// ...and a complete packet whose size is a multiple of 255 gets its closing 0 lacing value.
const originalRender = OggPageHeader.prototype.render
OggPageHeader.prototype.render = function (this: PageHeader): ByteVector {
  const out = originalRender.call(this)
  const sizes = this.packetSizes
  if (!this.lastPacketComplete || !sizes.length || sizes[sizes.length - 1] % 255 !== 0) return out
  out.set(26, out.get(26) + 1) // page segment count
  out.addByte(0)
  return out
}

// Reading: same as OggFile.readStreams, except that a packet held over from the previous page ends
// there when this page doesn't continue it. If that completes the stream's headers, this page is
// audio and stays out of the header pages that a save rewrites.
const oggFile = OggFile.prototype as unknown as { readStreams(pages?: Page[]): { end: number; streams: Map<number, BitStream> } }
oggFile.readStreams = function (this: File, pages?: Page[]) {
  const streams = new Map<number, BitStream>()
  const active: BitStream[] = []
  let position = 0
  do {
    const page = OggPage.fromFile(this, position)
    let stream: BitStream | undefined
    if ((page.header.flags & OggPageFlags.FirstPageOfStream) !== 0) {
      stream = new OggBitStream(page)
      streams.set(page.header.streamSerialNumber, stream)
      active.push(stream)
    }
    stream ??= streams.get(page.header.streamSerialNumber)
    const at = stream ? active.indexOf(stream) : -1
    if (stream && at >= 0) {
      const held = stream._previousPacket
      if (held && (page.header.flags & OggPageFlags.FirstPacketContinued) === 0) {
        stream._previousPacket = undefined
        if (stream.codec.readPacket(held)) {
          active.splice(at, 1)
          continue
        }
      }
      if (stream.readPage(page)) active.splice(at, 1)
    }
    pages?.push(page)
    position += page.size
  } while (active.length > 0)
  return { end: position, streams }
}
