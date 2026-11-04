package app.valence.tags

import java.io.EOFException
import kotlin.math.roundToLong

// Ogg Vorbis / Opus / FLAC: headers and comments from the first pages, length from the last page.

internal class OggPage(val pos: Long, val headerType: Int, val granule: Long, val serial: Long, val headerLen: Int, val bodyLen: Int, val lacing: ByteArray) {
    val bodyPos: Long get() = pos + headerLen
    val end: Long get() = bodyPos + bodyLen
}

internal object Ogg {
    fun readPage(src: Source, pos: Long): OggPage? {
        if (!src.has(pos, 27) || !src.matches(pos, "OggS") || src.u8(pos + 4) != 0) return null
        val n = src.u8(pos + 26)
        if (!src.has(pos + 27, n.toLong())) return null
        val lacing = src.bytes(pos + 27, n)
        var body = 0
        for (b in lacing) body += b.toInt() and 0xFF
        return OggPage(pos, src.u8(pos + 5), src.u64le(pos + 6), src.u32le(pos + 14), 27 + n, body, lacing)
    }

    /** Length of the first packet in [p] if it ends on this page, else -1. */
    private fun firstPacketLength(p: OggPage): Int {
        var len = 0
        for (b in p.lacing) {
            val v = b.toInt() and 0xFF
            len += v
            if (v < 255) return len
        }
        return -1
    }

    /** Bytes of one logical stream, continuing across pages (other serials are skipped). */
    class Stream(private val src: Source, private var page: OggPage, private var inBody: Int) : ByteStream {
        private var pages = 0

        private fun advance(): Boolean {
            var pos = page.end
            while (true) {
                if (++pages > 100_000) return false
                val next = readPage(src, pos) ?: return false
                if (next.serial == page.serial) { page = next; inBody = 0; return true }
                pos = next.end
            }
        }

        override fun read(n: Int): ByteArray {
            if (n < 0 || n > remainingBound()) throw EOFException("Ogg packet overrun")
            val out = ByteArray(n)
            var done = 0
            while (done < n) {
                if (inBody >= page.bodyLen) { if (!advance()) throw EOFException("Ogg stream ended"); continue }
                val k = minOf(n - done, page.bodyLen - inBody)
                src.read(page.bodyPos + inBody, out, done, k)
                done += k
                inBody += k
            }
            return out
        }

        override fun skip(n: Long) {
            if (n < 0 || n > remainingBound()) throw EOFException("Ogg packet overrun")
            var left = n
            while (left > 0) {
                if (inBody >= page.bodyLen) { if (!advance()) throw EOFException("Ogg stream ended"); continue }
                val k = minOf(left, (page.bodyLen - inBody).toLong()).toInt()
                inBody += k
                left -= k
            }
        }

        override fun position(): Long {
            if (inBody >= page.bodyLen) advance()
            return page.bodyPos + inBody
        }
        override fun fork(): ByteStream = Stream(src, page, inBody)
        override fun remainingBound(): Long = src.length - position()
    }

    /** Granule of the last page of [serial] (scans back from the end), or -1. */
    private fun lastGranule(src: Source, serial: Long, notBefore: Long): Long {
        var chunk = 8 * 1024 // the last page is usually a few KB; grow if it isn't found
        var end = src.length
        var scanned = 0L
        while (end > notBefore && scanned < 4L * 1024 * 1024) {
            val start = maxOf(notBefore, end - chunk)
            val b = src.bytes(start, (end - start).toInt())
            var i = b.size - 4
            while (i >= 0) {
                if (b[i] == 'O'.code.toByte() && b.matches(i, "OggS")) {
                    val p = readPage(src, start + i)
                    if (p != null && p.serial == serial && p.granule != -1L) return p.granule
                }
                i--
            }
            scanned += end - start
            if (start == notBefore) break
            end = start + 3 // overlap so a capture pattern split across chunks is still seen
            chunk = minOf(chunk * 2, 64 * 1024)
        }
        return -1
    }

    fun read(src: Source, start: Long, col: Collector): AudioInfo {
        val first = readPage(src, start) ?: throw CorruptFileException("bad Ogg page")
        val idLen = firstPacketLength(first)
        if (idLen < 0) throw CorruptFileException("Ogg ID header spans pages")
        val id = src.bytes(first.bodyPos, minOf(idLen, 64))
        val stream = Stream(src, first, idLen)
        return when {
            id.matches(0, "\u0001vorbis") -> vorbis(src, first, id, stream, col)
            id.matches(0, "OpusHead") -> opus(src, first, id, stream, col)
            id.matches(0, "\u007FFLAC") -> flac(src, first, id, stream, col)
            else -> throw UnsupportedFormatException("unsupported Ogg codec")
        }
    }

    private fun vorbis(src: Source, first: OggPage, id: ByteArray, s: Stream, col: Collector): AudioInfo {
        if (id.size < 28) throw CorruptFileException("short Vorbis header")
        val channels = id.u8(11)
        val sampleRate = id.u32le(12).toInt()
        val nominal = id.u32le(20).toInt()
        val commentStart = s.position()
        try {
            val magic = s.read(7)
            if (magic.matches(0, "\u0003vorbis")) VorbisComments.parse(s, col)
        } catch (e: Exception) {
            // Damaged comment packet: keep partial tags.
        }
        val granule = lastGranule(src, first.serial, commentStart)
        val seconds = if (granule > 0 && sampleRate > 0) granule.toDouble() / sampleRate else 0.0
        val bitrate = if (nominal > 0) nominal.toDouble() else if (seconds > 0) src.length * 8 / seconds else 0.0
        return AudioInfo("vorbis", (seconds * 1000).roundToLong(), bitrate.roundToLong().toInt(), sampleRate, channels, null, false)
    }

    private fun opus(src: Source, first: OggPage, id: ByteArray, s: Stream, col: Collector): AudioInfo {
        if (id.size < 19) throw CorruptFileException("short Opus header")
        val channels = id.u8(9)
        val preSkip = id.u16le(10)
        val inputRate = id.u32le(12).toInt()
        val commentStart = s.position()
        try {
            val magic = s.read(8)
            if (magic.matches(0, "OpusTags")) VorbisComments.parse(s, col)
        } catch (e: Exception) {
            // Damaged comment packet: keep partial tags.
        }
        val granule = lastGranule(src, first.serial, commentStart)
        val seconds = if (granule > preSkip) (granule - preSkip).toDouble() / 48000 else 0.0
        val dataStart = desktopOpusDataStart(src, first)
        val bitrate = if (seconds > 0) (src.length - if (dataStart >= 0) dataStart else commentStart) * 8 / seconds else 0.0
        val rate = if (inputRate > 0) inputRate else 48000
        return AudioInfo("opus", (seconds * 1000).roundToLong(), bitrate.roundToLong().toInt(), rate, channels, null, false)
    }

    /**
     * Where music-metadata's OpusStream thinks the audio starts ("lastPos"): it flushes the comment
     * pages when it reads the next packet-starting page, then subtracts the comment pages' body sizes
     * from the reader position. So: end of that next page minus the comment pages' bodies. -1 if unknown.
     */
    private fun desktopOpusDataStart(src: Source, first: OggPage): Long {
        var pos = first.end
        var commentPage: OggPage? = null
        var n = 0
        while (n++ < 10_000) {
            // Broken page chain (or no audio): the desktop gives up here; callers fall back to the file size.
            val p = readPage(src, pos) ?: return -1
            pos = p.end
            if (p.serial != first.serial) continue
            if (commentPage == null) { commentPage = p; continue }
            if (p.headerType and 1 == 0 || p.headerType and 4 != 0) return p.end - bodies(src, commentPage, if (p.headerType and 1 != 0) p.end else p.pos)
        }
        return -1
    }

    /** Body bytes of [from]'s serial in the pages from [from] up to [until]. */
    private fun bodies(src: Source, from: OggPage, until: Long): Long {
        var sum = 0L
        var pos = from.pos
        var n = 0
        while (pos < until && n++ < 10_000) {
            val p = readPage(src, pos) ?: break
            if (p.serial == from.serial) sum += p.bodyLen
            pos = p.end
        }
        return sum
    }

    private fun flac(src: Source, first: OggPage, id: ByteArray, s: Stream, col: Collector): AudioInfo {
        // 0x7F "FLAC" major minor headers(2) "fLaC" STREAMINFO block (4-byte header + 34 bytes)
        if (id.size < 13 + 4 + 18 || !id.matches(9, "fLaC")) throw CorruptFileException("bad Ogg FLAC header")
        val si = Flac.streamInfo(id, 13 + 4)
        val headers = id.u16be(7)
        try {
            var n = 0
            while (n++ < (if (headers == 0) 64 else headers)) {
                val h = s.read(4)
                val type = h.u8(0) and 0x7F
                val len = h.u24be(1).toLong()
                when (type) {
                    4 -> {
                        val block = s.fork()
                        VorbisComments.parse(LimitedStream(block, len), col)
                        s.skip(len)
                    }
                    6 -> {
                        val mark = s.position() - 4
                        val loaderBase = s.fork()
                        val head = s.read(minOf(len, 4096L).toInt())
                        s.skip(len - head.size)
                        val p = parseFlacPictureHeader(head)
                        if (p != null) {
                            val length = minOf(p.dataLength, len - p.dataStart).clampToInt()
                            if (length > 0) {
                                val start = p.dataStart
                                col.add(TagType.VORBIS, "METADATA_BLOCK_PICTURE", PictureEntry(p.type, p.mime, mark, length) {
                                    val st = loaderBase.fork()
                                    st.skip(start.toLong())
                                    st.read(length)
                                })
                            }
                        }
                    }
                    else -> s.skip(len)
                }
                if (h.u8(0) and 0x80 != 0) break
            }
        } catch (e: Exception) {
            // Damaged header packets: keep partial tags.
        }
        val granule = lastGranule(src, first.serial, first.end)
        val seconds = if (granule > 0 && si.sampleRate > 0) granule.toDouble() / si.sampleRate else 0.0
        val bitrate = if (seconds > 0) src.length * 8 / seconds else 0.0
        return AudioInfo("flac", (seconds * 1000).roundToLong(), bitrate.roundToLong().toInt(), si.sampleRate, si.channels, si.bitsPerSample, true)
    }

    /** Caps reads/skips of an inner stream at [limit] bytes (one metadata block). */
    private class LimitedStream(private val inner: ByteStream, private var limit: Long) : ByteStream {
        override fun read(n: Int): ByteArray {
            if (n > limit) throw EOFException("block overrun")
            limit -= n
            return inner.read(n)
        }
        override fun skip(n: Long) {
            if (n > limit) throw EOFException("block overrun")
            limit -= n
            inner.skip(n)
        }
        override fun position() = inner.position()
        override fun fork(): ByteStream = LimitedStream(inner.fork(), limit)
        override fun remainingBound() = minOf(limit, inner.remainingBound())
    }
}
