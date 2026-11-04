// node-taglib-sharp (6.0.3) moves audio data in tiny steps when a tag changes size, all with
// synchronous reads and writes on the main process:
//   - File.insert (tag grew) shuffles the rest of the file in chunks the size of the growth, so a
//     track number going from "7" to "123" moves a 2 MB Opus file 2 bytes at a time: a million
//     reads and a million writes, about 4 s with the whole app frozen.
//   - File.removeBlock (tag shrank) moves it 1 KB at a time.
// Both are replaced with the same moves in 1 MB chunks. Imported for its side effect by the tag
// writer, before any file is saved.

import { File, FileAccessMode, type ByteVector } from 'node-taglib-sharp'

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
