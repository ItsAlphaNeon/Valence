package app.valence.tags

import java.io.EOFException
import kotlin.math.roundToLong

/** Largest ordinary comment we decode; bigger ones (other than pictures) are skipped. */
private const val MAX_COMMENT = 1024 * 1024
private const val MAX_COMMENTS = 10_000L

/** A forward byte stream over the file: contiguous (FLAC) or spread across Ogg pages. */
internal interface ByteStream {
    fun read(n: Int): ByteArray
    fun skip(n: Long)
    /** File offset of the next byte. */
    fun position(): Long
    /** A fresh stream that re-reads from the current position (used to load a picture later). */
    fun fork(): ByteStream
    /** Upper bound on bytes left (for sanity checks against size fields). */
    fun remainingBound(): Long

    fun u32le(): Long {
        val b = read(4)
        return b.u32le(0)
    }
}

internal class SourceStream(private val src: Source, private var pos: Long, private val end: Long) : ByteStream {
    override fun read(n: Int): ByteArray {
        if (n < 0 || n > end - pos) throw EOFException("block overrun")
        val b = src.bytes(pos, n)
        pos += n
        return b
    }
    override fun skip(n: Long) {
        if (n < 0 || n > end - pos) throw EOFException("block overrun")
        pos += n
    }
    override fun position() = pos
    override fun fork(): ByteStream = SourceStream(src, pos, end)
    override fun remainingBound() = end - pos
}

/** Lenient base64 (skips anything outside the alphabet, stops at '='), like atob on well-formed input. */
internal fun base64Decode(s: ByteArray, off: Int = 0, len: Int = s.size - off, limit: Int = Int.MAX_VALUE): ByteArray {
    val out = java.io.ByteArrayOutputStream(minOf(len / 4 * 3 + 3, limit))
    var acc = 0
    var bits = 0
    var i = off
    val end = off + len
    while (i < end && out.size() < limit) {
        val c = s[i++].toInt() and 0xFF
        val v = when (c) {
            in 'A'.code..'Z'.code -> c - 'A'.code
            in 'a'.code..'z'.code -> c - 'a'.code + 26
            in '0'.code..'9'.code -> c - '0'.code + 52
            '+'.code, '-'.code -> 62
            '/'.code, '_'.code -> 63
            '='.code -> break
            else -> continue
        }
        acc = (acc shl 6) or v
        bits += 6
        if (bits >= 8) {
            bits -= 8
            out.write((acc shr bits) and 0xFF)
        }
    }
    return out.toByteArray()
}

/** FLAC METADATA_BLOCK_PICTURE header; [dataStart] is relative to the start of the block body. */
internal class FlacPicture(val type: Int, val mime: String?, val dataStart: Int, val dataLength: Long)

internal fun parseFlacPictureHeader(b: ByteArray): FlacPicture? {
    if (b.size < 8) return null
    val type = b.u32be(0).toInt()
    val mimeLen = b.u32be(4)
    if (mimeLen > b.size - 8) return null
    var p = 8 + mimeLen.toInt()
    val mime = latin1(b, 8, mimeLen.toInt())
    if (p + 4 > b.size) return null
    val descLen = b.u32be(p)
    if (descLen > b.size - p - 4) return null
    p += 4 + descLen.toInt()
    if (p + 20 > b.size) return null
    val dataLen = b.u32be(p + 16)
    return FlacPicture(type, normalizeMime(mime), p + 20, dataLen)
}

internal object VorbisComments {
    /**
     * Reads a Vorbis comment list (vendor, count, "KEY=value"...) into [col]. Pictures are reported
     * by position; their base64 is never decoded here beyond the small header.
     */
    fun parse(s: ByteStream, col: Collector) {
        val vendorLen = s.u32le()
        if (vendorLen > s.remainingBound()) return
        s.skip(vendorLen)
        val count = s.u32le()
        var i = 0L
        while (i < minOf(count, MAX_COMMENTS)) {
            i++
            val len = s.u32le()
            if (len > s.remainingBound()) return
            val headLen = minOf(len, 64L).toInt()
            val valueStartMark = s.position()
            val head = s.read(headLen)
            var eq = -1
            for (k in 0 until headLen) if (head[k] == '='.code.toByte()) { eq = k; break }
            val keyGuess = if (eq >= 0) jsUpper(latin1(head, 0, eq)) else null
            if (keyGuess == "METADATA_BLOCK_PICTURE" && len < (512L shl 20)) {
                picture(s, col, head, eq + 1, len - eq - 1, valueStartMark)
                continue
            }
            if (len > MAX_COMMENT || keyGuess == "COVERART") {
                s.skip(len - headLen)
                continue
            }
            val all = if (len > headLen) head + s.read((len - headLen).toInt()) else head
            val text = utf8(all)
            val sep = text.indexOf('=')
            val key = jsUpper(if (sep < 0) "" else text.substring(0, sep))
            val value = text.substring(sep + 1)
            col.add(TagType.VORBIS, key, value)
        }
    }

    private fun picture(s: ByteStream, col: Collector, head: ByteArray, valueOff: Int, valueLen: Long, mark: Long) {
        // Decode just enough base64 for the header (type, mime, description, sizes).
        val loader = s.fork() // positioned after the head bytes
        var prefix = head.copyOfRange(valueOff, head.size)
        val already = prefix.size.toLong()
        var want = minOf(valueLen, 4096L)
        if (want > already) prefix += s.read((want - already).toInt())
        var hdr = parseFlacPictureHeader(base64Decode(prefix))
        if (hdr == null && valueLen > want) {
            val more = minOf(valueLen, 1L shl 20)
            prefix += s.read((more - want).toInt())
            want = more
            hdr = parseFlacPictureHeader(base64Decode(prefix))
        }
        s.skip(valueLen - want)
        if (hdr == null) return
        val decodedMax = valueLen / 4 * 3
        val length = minOf(hdr.dataLength, decodedMax - hdr.dataStart).clampToInt()
        if (length <= 0) return
        val preRead = head.copyOfRange(valueOff, head.size)
        val dataStart = hdr.dataStart
        val entry = PictureEntry(hdr.type, hdr.mime, mark + valueOff, length) {
            val b64 = preRead + loader.fork().read((valueLen - preRead.size).toInt())
            val decoded = base64Decode(b64, limit = dataStart + length)
            decoded.copyOfRange(dataStart, minOf(decoded.size, dataStart + length))
        }
        col.add(TagType.VORBIS, "METADATA_BLOCK_PICTURE", entry)
    }
}

internal object Flac {
    class StreamInfo(val sampleRate: Int, val channels: Int, val bitsPerSample: Int, val totalSamples: Long)

    fun streamInfo(b: ByteArray, off: Int): StreamInfo {
        val x = b.u64be(off + 10)
        val sampleRate = (x ushr 44).toInt()
        val channels = ((x ushr 41) and 7).toInt() + 1
        val bps = ((x ushr 36) and 31).toInt() + 1
        val total = x and 0xFFFFFFFFFL
        return StreamInfo(sampleRate, channels, bps, total)
    }

    /** Reads a FLAC PICTURE block body at [pos] (length [len]) as a raw picture reference. */
    fun pictureBlock(src: Source, pos: Long, len: Long, col: Collector) {
        var head = src.bytes(pos, minOf(len, 1024L).toInt())
        var p = parseFlacPictureHeader(head)
        if (p == null && len > head.size) {
            head = src.bytes(pos, minOf(len, 1L shl 20).toInt())
            p = parseFlacPictureHeader(head)
        }
        if (p == null) return
        val length = minOf(p.dataLength, len - p.dataStart).clampToInt()
        if (length <= 0) return
        val offset = pos + p.dataStart
        val mime = p.mime ?: sniffImageMime(src.bytesUpTo(offset, 16))
        col.add(TagType.VORBIS, "METADATA_BLOCK_PICTURE", PictureEntry(p.type, mime, offset, length, null))
    }

    fun read(src: Source, start: Long, col: Collector): AudioInfo {
        var pos = start + 4
        var info: StreamInfo? = null
        var blocks = 0
        while (blocks++ < 1024) {
            if (!src.has(pos, 4)) break
            val h = src.u8(pos)
            val last = h and 0x80 != 0
            val type = h and 0x7F
            val len = src.u24be(pos + 1).toLong()
            val body = pos + 4
            if (!src.has(body, len)) break
            try {
                when (type) {
                    0 -> if (len >= 18) info = streamInfo(src.bytes(body, 18), 0)
                    4 -> VorbisComments.parse(SourceStream(src, body, body + len), col)
                    6 -> pictureBlock(src, body, len, col)
                }
            } catch (e: Exception) {
                if (type == 0) throw e
                // Damaged comment or picture block: keep what was read.
            }
            pos = body + len
            if (last) break
        }
        val si = info ?: throw CorruptFileException("FLAC without STREAMINFO")
        val seconds = if (si.sampleRate > 0) si.totalSamples.toDouble() / si.sampleRate else 0.0
        val bitrate = if (seconds > 0) (src.length - pos) * 8 / seconds else 0.0
        return AudioInfo("flac", (seconds * 1000).roundToLong(), bitrate.roundToLong().toInt(), si.sampleRate, si.channels, si.bitsPerSample, true)
    }
}
