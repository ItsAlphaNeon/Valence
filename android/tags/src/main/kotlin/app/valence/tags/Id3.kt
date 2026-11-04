package app.valence.tags

import java.util.zip.DataFormatException
import java.util.zip.Inflater

// ID3v2.2/2.3/2.4, ID3v1 and APEv2, decoded the way music-metadata does (FrameParser / ID3v2Parser).

/** Non-picture frames larger than this are skipped (a corrupt size can't make us allocate more). */
private const val MAX_TEXT_FRAME = 16 * 1024 * 1024

/** ID3v2.3 frames whose values music-metadata also splits on '/' (FrameParser.splitValue). */
private val SLASH_SPLIT = hashSetOf(
    "TPE1", "TPE2", "TPE3", "TPE4", "TCOM", "TEXT", "TOLY", "TOPE", "TP1", "TCM", "TXT", "TOA", "TOL", "TSRC", "IPL", "IPLS",
)
private val SLASH_SPLIT_TXXX = hashSetOf("ARTISTS", "MUSICBRAINZ ARTIST ID", "MUSICBRAINZ ALBUM ARTIST ID", "MUSICBRAINZ ALBUM TYPE", "ISRC")

/** Frames we decode; everything else is skipped without being read. */
private fun interesting(id: String): Boolean = when {
    id.isEmpty() -> false
    id[0] == 'T' -> true
    else -> id == "COMM" || id == "COM" || id == "USLT" || id == "ULT" || id == "POPM" || id == "POP" ||
        id == "UFID" || id == "UFI" || id == "APIC" || id == "PIC"
}

internal object Id3v2 {
    class Header(val start: Long, val major: Int, val flags: Int, val size: Int) {
        val end: Long get() = start + 10 + size + (if (major == 4 && flags and 0x10 != 0) 10 else 0)
    }

    fun header(src: Source, pos: Long): Header? {
        if (!src.has(pos, 10) || !src.matches(pos, "ID3")) return null
        val major = src.u8(pos + 3)
        if (major !in 2..4 || src.u8(pos + 4) == 0xFF) return null
        var size = 0
        for (i in 6..9) {
            val b = src.u8(pos + i)
            if (b >= 0x80) return null
            size = (size shl 7) or b
        }
        return Header(pos, major, src.u8(pos + 5), size)
    }

    /** Parses consecutive ID3v2 tags starting at [start]; returns where they end (== start if none). */
    fun parseAll(src: Source, start: Long, col: Collector?): Long {
        var pos = start
        var guard = 0
        while (guard++ < 64) {
            val h = header(src, pos) ?: break
            if (col != null) {
                try {
                    parseTag(src, h, col)
                } catch (e: Exception) {
                    // Corrupt tag: keep whatever frames were read before the damage.
                }
            }
            pos = minOf(h.end, src.length)
        }
        return pos
    }

    /** Frame body view: either straight from the file, or a de-unsynchronised in-memory copy. */
    private abstract class Body(val size: Int) {
        abstract fun u8(i: Int): Int
        abstract fun bytes(i: Int, n: Int): ByteArray
        abstract fun fileOffset(i: Int): Long
        abstract val raw: Boolean
    }

    private class FileBody(val src: Source, val base: Long, size: Int) : Body(size) {
        override fun u8(i: Int) = src.u8(base + i)
        override fun bytes(i: Int, n: Int) = src.bytes(base + i, n)
        override fun fileOffset(i: Int) = base + i
        override val raw = true
    }

    private class MemBody(val data: ByteArray, val base: Long, val removed: IntArray, val removedCount: Int) : Body(data.size) {
        override fun u8(i: Int) = data[i].toInt() and 0xFF
        override fun bytes(i: Int, n: Int) = data.copyOfRange(i, i + n)
        override fun fileOffset(i: Int): Long {
            // removed[] holds decoded positions where a 0x00 stuffing byte was dropped.
            var lo = 0
            var hi = removedCount
            while (lo < hi) {
                val mid = (lo + hi) ushr 1
                if (removed[mid] <= i) lo = mid + 1 else hi = mid
            }
            return base + i + lo
        }
        override val raw = false
    }

    private class Ctx(val type: TagType, val major: Int, val col: Collector) {
        // Last non-empty text of the frames music-metadata's mapRecordingDate looks at (ID3v2.3 only).
        val dateParts = HashMap<String, String>()
    }

    private fun parseTag(src: Source, h: Header, col: Collector) {
        val type = when (h.major) { 2 -> TagType.ID3V22; 3 -> TagType.ID3V23; else -> TagType.ID3V24 }
        val bodyStart = h.start + 10
        val bodyLen = minOf(h.size.toLong(), src.length - bodyStart).toInt()
        if (bodyLen <= 0) return
        if (h.major == 2 && h.flags and 0x40 != 0) return // ID3v2.2 compression: undefined, ignore the tag
        val ctx = Ctx(type, h.major, col)
        val body: Body
        if (h.flags and 0x80 != 0 && h.major < 4) {
            // Whole-tag unsynchronisation: frame sizes count decoded bytes, so decode it all first.
            val raw = src.bytes(bodyStart, bodyLen)
            val removed = IntArray(bodyLen / 2 + 1)
            var count = 0
            var w = 0
            var r = 0
            while (r < raw.size) {
                val b = raw[r]
                raw[w++] = b
                if (b == 0xFF.toByte() && r + 1 < raw.size && raw[r + 1] == 0.toByte()) {
                    if (count < removed.size) removed[count++] = w
                    r += 2
                } else r++
            }
            body = MemBody(raw.copyOf(w), bodyStart, removed, count)
        } else {
            body = FileBody(src, bodyStart, bodyLen)
        }
        var off = 0
        if (h.flags and 0x40 != 0) {
            if (body.size < 4) return
            val ext = if (h.major == 4) {
                ((body.u8(0) and 0x7F) shl 21) or ((body.u8(1) and 0x7F) shl 14) or ((body.u8(2) and 0x7F) shl 7) or (body.u8(3) and 0x7F)
            } else {
                val n = (body.u8(0).toLong() shl 24) or (body.u8(1).toLong() shl 16) or (body.u8(2).toLong() shl 8) or body.u8(3).toLong()
                if (n > body.size) return
                n.toInt() + 4
            }
            if (ext < (if (h.major == 4) 6 else 10) || ext > body.size) return
            off = ext
        }
        parseFrames(ctx, body, off, h.flags and 0x80 != 0 && h.major == 4)
        if (h.major == 3) mapRecordingDate(ctx)
    }

    private fun parseFrames(ctx: Ctx, body: Body, start: Int, tagUnsync24: Boolean) {
        val hl = if (ctx.major == 2) 6 else 10
        var off = start.toLong()
        while (off < body.size) {
            val o = off.toInt()
            if (body.u8(o) == 0) break // padding
            if (off + hl > body.size) break
            val idLen = if (ctx.major == 2) 3 else 4
            val idChars = CharArray(idLen) { body.u8(o + it).toChar() }
            val id = String(idChars)
            val frameSize: Long
            var flags = 0
            if (ctx.major == 2) {
                frameSize = ((body.u8(o + 3) shl 16) or (body.u8(o + 4) shl 8) or body.u8(o + 5)).toLong()
            } else {
                val b0 = body.u8(o + 4); val b1 = body.u8(o + 5); val b2 = body.u8(o + 6); val b3 = body.u8(o + 7)
                frameSize = if (ctx.major == 4 && (b0 or b1 or b2 or b3) and 0x80 == 0) {
                    ((b0 shl 21) or (b1 shl 14) or (b2 shl 7) or b3).toLong()
                } else {
                    // ID3v2.3, or a v2.4 writer that used plain big-endian sizes (bytes with the high bit set).
                    (b0.toLong() shl 24) or (b1.toLong() shl 16) or (b2.toLong() shl 8) or b3.toLong()
                }
                flags = (body.u8(o + 8) shl 8) or body.u8(o + 9)
            }
            val dataOff = o + hl
            val dataLen = minOf(frameSize, (body.size - dataOff).toLong()).toInt()
            if (dataLen > 0 && interesting(id)) {
                try {
                    handleFrame(ctx, body, id, flags, o, dataOff, dataLen, tagUnsync24)
                } catch (e: Exception) {
                    // A bad frame doesn't spoil the rest of the tag.
                }
            }
            off = dataOff + frameSize
        }
    }

    private fun handleFrame(ctx: Ctx, body: Body, id: String, flags: Int, frameOff: Int, dataOff: Int, dataLen: Int, tagUnsync24: Boolean) {
        var skip = 0
        var unsync = false
        var compressed = false
        var decodedSize = -1
        when (ctx.major) {
            3 -> {
                if (flags and 0x40 != 0) return // encrypted
                if (flags and 0x80 != 0) {
                    if (dataLen < 4) return
                    decodedSize = ((body.u8(dataOff).toLong() shl 24) or (body.u8(dataOff + 1).toLong() shl 16) or
                        (body.u8(dataOff + 2).toLong() shl 8) or body.u8(dataOff + 3).toLong()).clampToInt()
                    skip += 4
                    compressed = true
                }
                if (flags and 0x20 != 0) skip += 1 // group id
            }
            4 -> {
                if (flags and 0x04 != 0) return // encrypted
                if (flags and 0x40 != 0) skip += 1 // group id
                if (flags and 0x01 != 0) {
                    if (dataLen < skip + 4) return
                    val p = dataOff + skip
                    decodedSize = ((body.u8(p) and 0x7F) shl 21) or ((body.u8(p + 1) and 0x7F) shl 14) or
                        ((body.u8(p + 2) and 0x7F) shl 7) or (body.u8(p + 3) and 0x7F)
                    skip += 4
                }
                unsync = flags and 0x02 != 0 || tagUnsync24
                compressed = flags and 0x08 != 0
            }
        }
        if (skip >= dataLen) return
        val pOff = dataOff + skip
        val pLen = dataLen - skip
        val isPicture = id == "APIC" || id == "PIC"
        if (isPicture && body.raw && !unsync && !compressed) {
            rawPicture(ctx, body as FileBody, id, pOff, pLen)
            return
        }
        if (!isPicture && pLen > MAX_TEXT_FRAME) return
        var data = body.bytes(pOff, pLen)
        if (unsync) data = removeUnsync(data)
        if (compressed) data = inflate(data, if (decodedSize > 0) decodedSize else data.size * 4, body.size.toLong()) ?: return
        if (isPicture) {
            val p = parsePictureHeader(ctx.major, data, 0, data.size) ?: return
            val dataStart = p.dataStart
            val len = data.size - dataStart
            val mime = p.mime ?: sniffImageMime(data, dataStart, len)
            val bytes = data
            ctx.col.add(ctx.type, id, PictureEntry(p.type, mime, body.fileOffset(frameOff), len) { bytes.copyOfRange(dataStart, bytes.size) })
            return
        }
        parseFrame(ctx, id, data)
    }

    private class PicHeader(val mime: String?, val type: Int, val description: String, val dataStart: Int)

    /** APIC: enc, mime\0 (v2.2 PIC: 3-char format), type, description\0, data. */
    private fun parsePictureHeader(major: Int, b: ByteArray, off: Int, end: Int): PicHeader? {
        if (end - off < 2) return null
        val enc = b.u8(off)
        var p = off + 1
        val format: String
        if (major == 2) {
            if (p + 3 > end) return null
            format = latin1(b, p, 3)
            p += 3
        } else {
            val z = findZero(b, p, end, 0)
            if (z >= end) return null
            format = latin1(b, p, z - p)
            p = z + 1
        }
        if (p >= end) return null
        val type = b.u8(p)
        p++
        val z = findZero(b, p, end, enc)
        if (z >= end) return null // description not terminated inside what we have
        val desc = decodeText(b, p, z - p, enc)
        p = z + terminatorLength(enc)
        if (p > end) return null
        return PicHeader(normalizeMime(format), type, desc, p)
    }

    /** Plain APIC straight from the file: read only its header, point the ref at the image bytes. */
    private fun rawPicture(ctx: Ctx, body: FileBody, id: String, pOff: Int, pLen: Int) {
        var n = minOf(pLen, 1024)
        var head = body.bytes(pOff, n)
        var p = parsePictureHeader(ctx.major, head, 0, n)
        if (p == null && n < pLen) {
            n = minOf(pLen, 256 * 1024)
            head = body.bytes(pOff, n)
            p = parsePictureHeader(ctx.major, head, 0, n)
        }
        if (p == null) return
        val len = pLen - p.dataStart
        if (len <= 0) return
        val offset = body.fileOffset(pOff + p.dataStart)
        val mime = p.mime ?: sniffImageMime(body.src.bytesUpTo(offset, 16))
        ctx.col.add(ctx.type, id, PictureEntry(p.type, mime, offset, len, null))
    }

    private fun parseFrame(ctx: Ctx, id: String, d: ByteArray) {
        if (d.isEmpty()) return
        val col = ctx.col
        val type = ctx.type
        val enc = d.u8(0)
        when {
            id == "TXXX" || id == "TXX" -> {
                val z = findZero(d, 1, d.size, enc)
                val desc = decodeText(d, 1, minOf(z, d.size) - 1, enc)
                val vStart = minOf(d.size, z + terminatorLength(enc))
                val text = trimNullPadding(decodeText(d, vStart, d.size - vStart, enc))
                val nid = if (desc.isEmpty()) "TXXX" else "TXXX:$desc"
                val values = splitValue(ctx.major, "TXXX", text, desc)
                for (v in values) col.add(type, nid, v)
                if (ctx.major == 3 && jsUpper(desc) == "DISCOGS_RELEASED" && values.isNotEmpty() && values.last().isNotEmpty()) {
                    ctx.dateParts["DISCOGS_RELEASED"] = values.last()
                }
            }
            id[0] == 'T' -> {
                val text = trimNullPadding(decodeText(d, 1, d.size - 1, enc))
                when (id) {
                    "TRK", "TRCK", "TPOS", "TIT1", "TIT2", "TIT3" -> if (text.isNotEmpty()) col.add(type, id, text)
                    "TCOM", "TEXT", "TOLY", "TOPE", "TPE1", "TSRC" -> for (v in splitValue(ctx.major, id, text)) col.add(type, id, v)
                    "TCO", "TCON" -> for (v in splitValue(ctx.major, id, text)) for (g in parseGenre(v)) col.add(type, id, g)
                    "TMCL", "TIPL" -> {}
                    else -> {
                        val values = if (ctx.major >= 4) splitValue(ctx.major, id, text) else listOf(text)
                        for (v in values) col.add(type, id, v)
                        if (ctx.major == 3 && values.isNotEmpty() && values.last().isNotEmpty()) ctx.dateParts[id] = values.last()
                    }
                }
            }
            id == "COMM" || id == "COM" || id == "USLT" || id == "ULT" -> {
                var descriptor = ""
                var text = ""
                if (d.size >= 4) {
                    val z = findZero(d, 4, d.size, enc)
                    descriptor = decodeText(d, 4, minOf(z, d.size) - 4, enc)
                    val t = minOf(d.size, z + terminatorLength(enc))
                    val z2 = findZero(d, t, d.size, enc)
                    text = decodeText(d, t, minOf(z2, d.size) - t, enc)
                }
                col.add(type, id, CommentValue(descriptor, text))
            }
            id == "UFID" || id == "UFI" -> {
                val z = findZero(d, 0, d.size, 0)
                val owner = latin1(d, 0, minOf(z, d.size))
                if (owner == "http://musicbrainz.org" && z < d.size) {
                    col.add(type, "UFID:http://musicbrainz.org", trimNullPadding(latin1(d, z + 1, d.size - z - 1)))
                }
            }
            id == "POPM" || id == "POP" -> {
                val z = findZero(d, 0, d.size, 0)
                val email = latin1(d, 0, minOf(z, d.size))
                val rating = if (z + 1 < d.size) d.u8(z + 1) else 0
                col.add(type, id, PopmValue(email, rating))
            }
        }
    }

    /** music-metadata ID3v2Parser.mapRecordingDate (ID3v2.3). */
    private fun mapRecordingDate(ctx: Ctx) {
        val parts = ctx.dateParts
        val explicit = parts["TDRC"] ?: parts["TDRV"] ?: parts["DISCOGS_RELEASED"]
        if (explicit != null) {
            ctx.col.postMap(ctx.type.prio, "date", explicit)
            return
        }
        val year = parts["TYER"] ?: return
        if (!FOUR.matches(year)) return
        var date = year
        val dm = parts["TDAT"]
        if (dm != null && FOUR.matches(dm)) {
            val day = dm.substring(0, 2).toInt()
            val month = dm.substring(2).toInt()
            val y = year.toInt()
            val leap = y % 4 == 0 && (y % 100 != 0 || y % 400 == 0)
            val days = intArrayOf(31, if (leap) 29 else 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31)
            if (month in 1..12 && day >= 1 && day <= days[month - 1]) {
                date += "-${dm.substring(2)}-${dm.substring(0, 2)}"
                val time = parts["TIME"]
                if (time != null && TIME.matches(time)) date += "T${time.substring(0, 2)}:${time.substring(2)}"
            }
        }
        ctx.col.postMap(ctx.type.prio, "date", date)
    }

    private val FOUR = Regex("\\d{4}")
    private val TIME = Regex("([01]\\d|2[0-3])[0-5]\\d")

    private fun splitValue(major: Int, tag: String, text: String, description: String = ""): List<String> {
        var values = text.split('\u0000')
        if (major < 4 && values.size == 1 &&
            (tag in SLASH_SPLIT || (tag == "TXXX" && jsUpper(description) in SLASH_SPLIT_TXXX))
        ) {
            values = text.split('/')
        }
        return values.map { jsTrim(trimNullPadding(it)) }
    }
}

internal fun removeUnsync(b: ByteArray): ByteArray {
    val out = ByteArray(b.size)
    var w = 0
    var r = 0
    while (r < b.size) {
        out[w++] = b[r]
        r += if (b[r] == 0xFF.toByte() && r + 1 < b.size && b[r + 1] == 0.toByte()) 2 else 1
    }
    return if (w == b.size) out else out.copyOf(w)
}

/** zlib-inflates at most [expected] bytes (capped, so a hostile size field can't exhaust memory). */
internal fun inflate(b: ByteArray, expected: Int, cap: Long): ByteArray? {
    val limit = minOf(expected.toLong(), maxOf(cap * 64, 1L shl 20), 64L shl 20).toInt()
    val inf = Inflater()
    return try {
        inf.setInput(b)
        val out = ByteArray(limit)
        var n = 0
        while (n < limit && !inf.finished()) {
            val r = inf.inflate(out, n, limit - n)
            if (r == 0 && (inf.needsInput() || inf.needsDictionary())) break
            n += r
        }
        out.copyOf(n)
    } catch (e: DataFormatException) {
        null
    } finally {
        inf.end()
    }
}

internal fun terminatorLength(enc: Int): Int = if (enc == 1 || enc == 2) 2 else 1

/** First terminator position in [from, end) (UTF-16: a 00 00 pair on an even boundary), or end. */
internal fun findZero(b: ByteArray, from: Int, end: Int, enc: Int): Int {
    if (enc == 1 || enc == 2) {
        var i = from
        while (i + 1 < end) {
            if (b[i] == 0.toByte() && b[i + 1] == 0.toByte()) return i
            i += 2
        }
        return end
    }
    for (i in from until end) if (b[i] == 0.toByte()) return i
    return end
}

internal fun latin1(b: ByteArray, off: Int, len: Int): String {
    if (len <= 0) return ""
    val c = CharArray(len) { (b[off + it].toInt() and 0xFF).toChar() }
    return String(c)
}

/** music-metadata util.decodeString for an ID3 text encoding byte. */
internal fun decodeText(b: ByteArray, off0: Int, len0: Int, enc: Int): String {
    var off = off0
    var len = len0
    if (len <= 0) return ""
    while (len >= 2 && b[off] == 0xFF.toByte() && b[off + 1] == 0xFE.toByte()) { off += 2; len -= 2 }
    if (len <= 0) return ""
    return when (enc) {
        0 -> latin1(b, off, len)
        1 -> if (len >= 2 && b[off] == 0xFE.toByte() && b[off + 1] == 0xFF.toByte()) {
            String(b, off + 2, (len - 2) and 1.inv(), Charsets.UTF_16BE)
        } else String(b, off, len and 1.inv(), Charsets.UTF_16LE)
        2 -> String(b, off, len and 1.inv(), Charsets.UTF_16BE)
        else -> utf8(b, off, len)
    }
}

internal object Id3v1 {
    fun present(src: Source): Boolean = src.length >= 128 && src.matches(src.length - 128, "TAG")

    private fun str(b: ByteArray, off: Int, len: Int): String? {
        var end = off
        while (end < off + len && b[end] != 0.toByte()) end++
        val s = jsTrim(latin1(b, off, end - off))
        return s.ifEmpty { null }
    }

    fun parse(src: Source, col: Collector) {
        if (!present(src)) return
        val b = src.bytes(src.length - 128, 128)
        val hasTrack = b[125] == 0.toByte() && b[126] != 0.toByte()
        val t = TagType.ID3V1
        str(b, 3, 30)?.let { col.add(t, "title", it) }
        str(b, 33, 30)?.let { col.add(t, "artist", it) }
        str(b, 63, 30)?.let { col.add(t, "album", it) }
        str(b, 97, if (hasTrack) 28 else 30)?.let { col.add(t, "comment", it) }
        if (hasTrack) col.add(t, "track", b.u8(126).toString())
        str(b, 93, 4)?.let { col.add(t, "year", it) }
        GENRES.getOrNull(b.u8(127))?.let { col.add(t, "genre", it) }
    }
}

/** APEv2 tags at the end of a file (before ID3v1 and Lyrics3v2). */
internal object Ape {
    /** End of the APE region to look under: file end minus ID3v1 and Lyrics3v2. */
    private fun searchEnd(src: Source): Long {
        var end = src.length
        if (Id3v1.present(src)) {
            end -= 128
            if (src.length >= 143 && src.matches(src.length - 128 - 9, "LYRICS200")) {
                val n = parseIntJs(src.ascii(src.length - 143, 6))
                if (n != null && n > 0) end -= n + 15
            }
        }
        return end
    }

    fun parse(src: Source, col: Collector) {
        val end = searchEnd(src)
        if (end <= 32 || !src.matches(end - 32, "APETAGEX")) return
        val f = src.bytes(end - 32, 32)
        val size = f.u32le(12)
        val count = f.u32le(16)
        val flags = f.u32le(20)
        if (flags and 0x20000000L != 0L) return // that's a header, not a footer
        if (size < 32 || size > end) return
        var pos = end - size
        var remaining = size - 32
        val type = TagType.APE
        for (i in 0 until minOf(count, 4096L)) {
            if (remaining < 8) break
            val vsize = src.u32le(pos)
            val iflags = src.u32le(pos + 4)
            pos += 8
            remaining -= 8
            if (vsize >= remaining) break
            val keyMax = minOf(256L, remaining - vsize).toInt()
            val kb = src.bytes(pos, keyMax)
            val z = kb.indexOf(0)
            if (z < 0) break
            val key = latin1(kb, 0, z)
            pos += z + 1
            remaining -= z + 1 + vsize
            when (((iflags shr 1) and 3).toInt()) {
                0 -> if (vsize <= MAX_TEXT_FRAME) {
                    val v = String(src.bytes(pos, vsize.toInt()), Charsets.UTF_8)
                    for (part in v.split('\u0000')) col.add(type, key, part)
                }
                1 -> {
                    val head = src.bytes(pos, minOf(vsize, 1024L).toInt())
                    var dz = head.indexOf(0)
                    if (dz < 0) dz = head.size
                    val dataPos = pos + dz + 1
                    val len = vsize - dz - 1
                    if (len > 0) {
                        val upper = jsUpper(key)
                        val picType = if (upper.contains("(FRONT)")) 3 else if (upper.contains("(BACK)")) 4 else 0
                        val mime = sniffImageMime(src.bytesUpTo(dataPos, 16))
                        col.add(type, key, PictureEntry(picType, mime, dataPos, len.toInt(), null))
                    }
                }
            }
            pos += vsize
        }
    }
}
