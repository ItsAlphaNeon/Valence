package app.valence.tags

import java.io.Closeable
import java.io.EOFException
import java.io.File
import java.io.IOException
import java.io.RandomAccessFile

/**
 * Random-access reads over one file through a small window cache, so the many tiny header reads a
 * tag parse makes cost one disk read per 16 KB region. Every read is bounds-checked against the
 * file length (EOFException), so a corrupt size field can never allocate more than the file holds.
 */
internal class Source(file: File) : Closeable {
    private val raf = RandomAccessFile(file, "r")
    val length: Long = raf.length()
    private val window = ByteArray(WINDOW)
    private var winStart = 0L
    private var winLen = 0

    /** Bytes physically read from disk; lets tests check that read() stays small. */
    var bytesRead = 0L
        private set

    fun has(pos: Long, n: Long): Boolean = pos >= 0 && n >= 0 && pos <= length && n <= length - pos

    private fun check(pos: Long, n: Int) {
        if (n < 0 || !has(pos, n.toLong())) throw EOFException("read of $n bytes at $pos past end ($length)")
    }

    fun read(pos: Long, dst: ByteArray, off: Int, n: Int) {
        check(pos, n)
        if (n == 0) return
        if (pos >= winStart && pos + n <= winStart + winLen) {
            System.arraycopy(window, (pos - winStart).toInt(), dst, off, n)
            return
        }
        if (n > WINDOW / 2) {
            readRaw(pos, dst, off, n)
            return
        }
        fill(pos, n)
        System.arraycopy(window, 0, dst, off, n)
    }

    /**
     * Loads the window at [pos]: a full window when reading on from the current one (tag frames,
     * comment lists), a small one after a seek (page headers, frame headers, trailing tags).
     */
    private fun fill(pos: Long, need: Int) {
        val sequential = winLen > 0 && pos >= winStart && pos <= winStart + winLen + SMALL
        val size = maxOf(need, if (sequential) WINDOW else SMALL)
        val n = minOf(size.toLong(), length - pos).toInt()
        readRaw(pos, window, 0, n)
        winStart = pos
        winLen = n
    }

    private fun readRaw(pos: Long, dst: ByteArray, off: Int, n: Int) {
        raf.seek(pos)
        var done = 0
        while (done < n) {
            val r = raf.read(dst, off + done, n - done)
            if (r < 0) throw EOFException("unexpected end of file at ${pos + done}")
            done += r
        }
        bytesRead += n
    }

    fun bytes(pos: Long, n: Int): ByteArray {
        check(pos, n)
        val b = ByteArray(n)
        read(pos, b, 0, n)
        return b
    }

    /** Up to [n] bytes at [pos], fewer at the end of the file. */
    fun bytesUpTo(pos: Long, n: Int): ByteArray {
        if (pos < 0 || pos >= length) return ByteArray(0)
        return bytes(pos, minOf(n.toLong(), length - pos).toInt())
    }

    fun u8(pos: Long): Int {
        if (pos >= winStart && pos < winStart + winLen) return window[(pos - winStart).toInt()].toInt() and 0xFF
        check(pos, 1)
        fill(pos, 1)
        return window[0].toInt() and 0xFF
    }

    fun u16be(pos: Long): Int = (u8(pos) shl 8) or u8(pos + 1)
    fun u24be(pos: Long): Int = (u8(pos) shl 16) or (u8(pos + 1) shl 8) or u8(pos + 2)
    fun u32be(pos: Long): Long = (u16be(pos).toLong() shl 16) or u16be(pos + 2).toLong()
    fun u64be(pos: Long): Long = (u32be(pos) shl 32) or u32be(pos + 4)
    fun u32le(pos: Long): Long = u8(pos).toLong() or (u8(pos + 1).toLong() shl 8) or (u8(pos + 2).toLong() shl 16) or (u8(pos + 3).toLong() shl 24)
    fun u64le(pos: Long): Long = u32le(pos) or (u32le(pos + 4) shl 32)

    fun ascii(pos: Long, n: Int): String {
        if (!has(pos, n.toLong())) return ""
        val b = bytes(pos, n)
        val c = CharArray(n) { (b[it].toInt() and 0xFF).toChar() }
        return String(c)
    }

    fun matches(pos: Long, magic: String): Boolean {
        if (!has(pos, magic.length.toLong())) return false
        for (i in magic.indices) if (u8(pos + i) != magic[i].code) return false
        return true
    }

    override fun close() = raf.close()

    companion object {
        const val WINDOW = 16 * 1024
        const val SMALL = 4 * 1024
    }
}

internal class CorruptFileException(message: String) : IOException(message)

// Big/little-endian helpers over byte arrays (callers bounds-check or catch IndexOutOfBounds).
internal fun ByteArray.u8(i: Int): Int = this[i].toInt() and 0xFF
internal fun ByteArray.u16be(i: Int): Int = (u8(i) shl 8) or u8(i + 1)
internal fun ByteArray.u16le(i: Int): Int = u8(i) or (u8(i + 1) shl 8)
internal fun ByteArray.u24be(i: Int): Int = (u8(i) shl 16) or (u8(i + 1) shl 8) or u8(i + 2)
internal fun ByteArray.u32be(i: Int): Long = (u16be(i).toLong() shl 16) or u16be(i + 2).toLong()
internal fun ByteArray.u32le(i: Int): Long = u16le(i).toLong() or (u16le(i + 2).toLong() shl 16)
internal fun ByteArray.u64be(i: Int): Long = (u32be(i) shl 32) or u32be(i + 4)
internal fun ByteArray.u64le(i: Int): Long = u32le(i) or (u32le(i + 4) shl 32)
internal fun ByteArray.ascii(i: Int, n: Int): String {
    val end = minOf(size, i + n)
    val c = CharArray(maxOf(0, end - i)) { (this[i + it].toInt() and 0xFF).toChar() }
    return String(c)
}
internal fun ByteArray.matches(i: Int, magic: String): Boolean {
    if (i < 0 || i + magic.length > size) return false
    for (k in magic.indices) if (u8(i + k) != magic[k].code) return false
    return true
}

internal fun Long.clampToInt(): Int = if (this > Int.MAX_VALUE) Int.MAX_VALUE else if (this < 0) 0 else this.toInt()
