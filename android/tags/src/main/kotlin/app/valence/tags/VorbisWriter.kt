package app.valence.tags

import java.io.ByteArrayOutputStream
import java.io.OutputStream
import java.io.RandomAccessFile

/** A Vorbis comment list (FLAC's VORBIS_COMMENT block, Ogg's comment header) held as raw entries. */
internal class VorbisCommentBlock(val vendor: ByteArray, val entries: MutableList<ByteArray>) {

    fun serialize(): ByteArray {
        val o = ByteArrayOutputStream()
        o.u32le(vendor.size.toLong()); o.write(vendor)
        o.u32le(entries.size.toLong())
        for (e in entries) { o.u32le(e.size.toLong()); o.write(e) }
        return o.toByteArray()
    }

    /** Applies [c] (Picard's field names, as the desktop writes them) and says what the reader should now see. */
    fun apply(c: Changes): Written {
        val expected = HashMap<TagField, String?>()
        for ((field, value) in c.text) {
            val keys = keysOf(field)
            replace(keys, listOfNotNull(value?.let { entry(keys.first(), it) }))
            expected[field] = value
        }
        c.track?.let { (no, total) ->
            replace(setOf("TRACKNUMBER"), listOfNotNull(no?.let { entry("TRACKNUMBER", "$it") }))
            replace(setOf("TRACKTOTAL", "TOTALTRACKS"), listOfNotNull(total?.let { entry("TRACKTOTAL", "$it") }))
        }
        c.disc?.let { (no, total) ->
            replace(setOf("DISCNUMBER"), listOfNotNull(no?.let { entry("DISCNUMBER", "$it") }))
            replace(setOf("DISCTOTAL", "TOTALDISCS"), listOfNotNull(total?.let { entry("DISCTOTAL", "$it") }))
        }
        TagWriter.expectNumbers(c, expected, totalNeedsNumber = false)
        return Written(expected)
    }

    private fun keyOf(e: ByteArray): String {
        val eq = e.indexOf('='.code.toByte())
        return String(e, 0, if (eq < 0) e.size else eq, Charsets.ISO_8859_1).uppercase()
    }

    private fun replace(keys: Set<String>, new: List<ByteArray>) {
        val first = entries.indexOfFirst { keyOf(it) in keys }
        entries.removeAll { keyOf(it) in keys }
        entries.addAll(if (first < 0) entries.size else first, new)
    }

    private fun entry(key: String, value: String): ByteArray = "$key=$value".toByteArray(Charsets.UTF_8)

    companion object {
        /** Comment names an edit of [field] replaces; the first is the one written. */
        fun keysOf(field: TagField): Set<String> = when (field) {
            TagField.TITLE -> setOf("TITLE")
            TagField.ARTIST -> setOf("ARTIST")
            TagField.ALBUM -> setOf("ALBUM")
            TagField.ALBUM_ARTIST -> linkedSetOf("ALBUMARTIST", "ALBUM ARTIST")
            TagField.GENRE -> setOf("GENRE")
            TagField.COMPOSER -> setOf("COMPOSER")
            TagField.DATE -> setOf("DATE")
            TagField.TRACK_NO, TagField.TRACK_TOTAL -> setOf("TRACKNUMBER", "TRACKTOTAL", "TOTALTRACKS")
            TagField.DISC_NO, TagField.DISC_TOTAL -> setOf("DISCNUMBER", "DISCTOTAL", "TOTALDISCS")
        }

        /** Parses a comment list at [off]; returns it and where it ends. */
        fun parse(b: ByteArray, off: Int): Pair<VorbisCommentBlock, Int> {
            fun u32(i: Int): Int {
                if (i + 4 > b.size) throw TagWriteException("The file's comment block is damaged")
                val v = b.u32le(i)
                if (v > b.size) throw TagWriteException("The file's comment block is damaged")
                return v.toInt()
            }
            var p = off
            val vlen = u32(p); p += 4
            if (p + vlen > b.size) throw TagWriteException("The file's comment block is damaged")
            val vendor = b.copyOfRange(p, p + vlen); p += vlen
            val n = u32(p); p += 4
            val list = ArrayList<ByteArray>(n)
            repeat(n) {
                val l = u32(p); p += 4
                if (p + l > b.size) throw TagWriteException("The file's comment block is damaged")
                list.add(b.copyOfRange(p, p + l)); p += l
            }
            return VorbisCommentBlock(vendor, list) to p
        }
    }
}

/**
 * FLAC: replaces the VORBIS_COMMENT block (adding one if there is none). Padding blocks are merged
 * into one at the end that absorbs the size change, so the audio frames stay where they were.
 */
internal object FlacWriter {
    private const val NEW_PADDING = 4096

    fun write(raf: RandomAccessFile, out: OutputStream, c: Changes): Written {
        val len = raf.length()
        val start = flacStart(raf)
        var p = start + 4
        val blocks = ArrayList<Pair<Int, ByteArray>>()
        while (true) {
            if (p + 4 > len) throw TagWriteException("This FLAC file is damaged")
            val h = raf.bytesAt(p, 4)
            val type = h.u8(0) and 0x7F
            val size = h.u24be(1)
            if (type == 127) throw TagWriteException("This FLAC file is damaged")
            blocks.add(type to raf.bytesAt(p + 4, size))
            p += 4 + size
            if (h.u8(0) and 0x80 != 0) break
            if (blocks.size > 10_000) throw TagWriteException("This FLAC file is damaged")
        }
        val audioStart = p
        if (blocks.first().first != 0) throw TagWriteException("This FLAC file is damaged")
        if (blocks.count { it.first == 4 } > 1) throw TagWriteException("This FLAC file has two comment blocks, which the editor can't change")

        val at = blocks.indexOfFirst { it.first == 4 }
        val vc = if (at >= 0) VorbisCommentBlock.parse(blocks[at].second, 0).first
            else VorbisCommentBlock("Valence".toByteArray(), ArrayList())
        val written = vc.apply(c)
        val data = vc.serialize()
        if (data.size >= 1 shl 24) throw TagWriteException("The tags would be too big")
        if (at >= 0) blocks[at] = 4 to data else blocks.add(1, 4 to data)

        val oldTotal = audioStart - (start + 4)
        val kept = blocks.filter { it.first != 1 }.toMutableList()
        val total = kept.sumOf { 4L + it.second.size }
        when {
            oldTotal - total >= 4 -> kept.add(1 to ByteArray((oldTotal - total - 4).toInt()))
            oldTotal == total -> {}
            else -> kept.add(1 to ByteArray(NEW_PADDING))
        }
        raf.copyTo(out, 0, start)
        val o = ByteArrayOutputStream()
        o.write(latin1Bytes("fLaC"))
        for ((i, b) in kept.withIndex()) {
            o.write(b.first or (if (i == kept.lastIndex) 0x80 else 0))
            o.write((b.second.size shr 16) and 0xFF); o.write((b.second.size shr 8) and 0xFF); o.write(b.second.size and 0xFF)
            o.write(b.second)
        }
        o.writeTo(out)
        raf.copyTo(out, audioStart, len)
        return written
    }

    /** Where "fLaC" is: after any ID3v2 tags in front (kept as they are). */
    fun flacStart(raf: RandomAccessFile): Long {
        var p = 0L
        val len = raf.length()
        while (p + 10 <= len) {
            val h = raf.bytesAt(p, 10)
            if (!h.matches(0, "ID3")) break
            var size = 0L
            for (i in 6..9) size = (size shl 7) or (h.u8(i) and 0x7F).toLong()
            p += 10 + size + (if (h.u8(3) == 4 && h.u8(5) and 0x10 != 0) 10 else 0)
        }
        if (p + 4 > len || !raf.bytesAt(p, 4).matches(0, "fLaC")) throw TagWriteException("This FLAC file is damaged")
        return p
    }
}

/**
 * Ogg Opus / Ogg Vorbis: rebuilds the comment header packet and repaginates the header pages; audio
 * pages are copied as they are, renumbered (with a new checksum) only if the header page count changed.
 */
internal object OggWriter {
    class Page(val pos: Long, val headerType: Int, val granule: Long, val serial: Int, val seq: Int, val segs: IntArray, val bodyPos: Long) {
        val bodyLen: Int = segs.sum()
        val end: Long get() = bodyPos + bodyLen
    }

    fun readPage(raf: RandomAccessFile, pos: Long): Page? {
        if (pos + 27 > raf.length()) return null
        val h = raf.bytesAt(pos, 27)
        if (!h.matches(0, "OggS") || h.u8(4) != 0) return null
        val n = h.u8(26)
        if (pos + 27 + n > raf.length()) return null
        val lacing = raf.bytesAt(pos + 27, n)
        val segs = IntArray(n) { lacing.u8(it) }
        val page = Page(pos, h.u8(5), h.u64le(6), h.u32le(14).toInt(), h.u32le(18).toInt(), segs, pos + 27 + n)
        if (page.end > raf.length()) return null
        return page
    }

    /** The codec's header packets: page 0 holds the id header alone; [count] more follow (Opus 1, Vorbis 2). */
    class Headers(val first: Page, val opus: Boolean, val packets: List<ByteArray>, val pages: Int, val end: Long)

    fun headers(raf: RandomAccessFile): Headers {
        val first = readPage(raf, 0) ?: throw TagWriteException("This Ogg file is damaged")
        if (first.headerType and 0x02 == 0) throw TagWriteException("This Ogg file is damaged")
        val body = raf.bytesAt(first.bodyPos, first.bodyLen)
        val opus = body.matches(0, "OpusHead")
        if (!opus && !(body.size > 7 && body.u8(0) == 1 && body.matches(1, "vorbis"))) {
            throw TagWriteException("Only Opus and Vorbis tags can be edited in Ogg files")
        }
        // Page 0 must hold exactly the id header.
        if (first.segs.isEmpty() || first.segs.last() == 255 || first.segs.dropLast(1).any { it < 255 }) {
            throw TagWriteException("This Ogg file is laid out in a way the editor can't change")
        }
        val need = if (opus) 1 else 2
        val packets = ArrayList<ByteArray>()
        var cur = ByteArrayOutputStream()
        var pos = first.end
        var pages = 0
        while (packets.size < need) {
            val pg = readPage(raf, pos) ?: throw TagWriteException("This Ogg file is damaged")
            if (pg.serial != first.serial) throw TagWriteException("This Ogg file has several streams, which the editor can't change")
            val b = raf.bytesAt(pg.bodyPos, pg.bodyLen)
            var o = 0
            for ((i, s) in pg.segs.withIndex()) {
                cur.write(b, o, s); o += s
                if (s < 255) {
                    packets.add(cur.toByteArray()); cur = ByteArrayOutputStream()
                    if (packets.size == need && i != pg.segs.lastIndex) {
                        throw TagWriteException("This Ogg file is laid out in a way the editor can't change")
                    }
                }
            }
            pages++
            pos = pg.end
            if (pages > 100_000) throw TagWriteException("This Ogg file is damaged")
        }
        if (cur.size() > 0) throw TagWriteException("This Ogg file is laid out in a way the editor can't change")
        return Headers(first, opus, packets, pages, pos)
    }

    fun write(raf: RandomAccessFile, out: OutputStream, c: Changes): Written {
        val h = headers(raf)
        val comment = h.packets[0]
        val prefixLen = if (h.opus) 8 else 7
        val ok = if (h.opus) comment.matches(0, "OpusTags") else comment.size > 7 && comment.u8(0) == 3 && comment.matches(1, "vorbis")
        if (!ok) throw TagWriteException("This Ogg file is damaged")
        val (vc, end) = VorbisCommentBlock.parse(comment, prefixLen)
        val written = vc.apply(c)
        val packet = ByteArrayOutputStream()
        packet.write(comment, 0, prefixLen)
        packet.write(vc.serialize())
        // Vorbis: the framing bit; Opus: whatever binary data followed the comments.
        if (h.opus) packet.write(comment, end, comment.size - end) else packet.write(1)
        val newPages = paginate(listOf(packet.toByteArray()) + h.packets.drop(1), h.first.serial, 1)

        raf.copyTo(out, 0, h.first.end)
        for (pg in newPages) out.write(pg)
        val shift = newPages.size - h.pages
        if (shift == 0) {
            raf.copyTo(out, h.end, raf.length())
        } else {
            var pos = h.end
            while (pos < raf.length()) {
                val pg = readPage(raf, pos)
                if (pg == null) { raf.copyTo(out, pos, raf.length()); break }
                if (pg.serial != h.first.serial) throw TagWriteException("This Ogg file has several streams, which the editor can't change")
                val bytes = raf.bytesAt(pg.pos, (pg.end - pg.pos).toInt())
                val seq = pg.seq + shift
                bytes[18] = seq.toByte(); bytes[19] = (seq shr 8).toByte(); bytes[20] = (seq shr 16).toByte(); bytes[21] = (seq shr 24).toByte()
                setCrc(bytes)
                out.write(bytes)
                pos = pg.end
            }
        }
        return written
    }

    /** Header pages for [packets]: up to 255 segments a page; granule 0 where a packet ends, else -1. */
    fun paginate(packets: List<ByteArray>, serial: Int, firstSeq: Int): List<ByteArray> {
        class Seg(val packet: Int, val off: Int, val len: Int, val last: Boolean)
        val segs = ArrayList<Seg>()
        for ((i, p) in packets.withIndex()) {
            var o = 0
            while (true) {
                val l = minOf(255, p.size - o)
                segs.add(Seg(i, o, l, l < 255))
                o += l
                if (l < 255) break
            }
        }
        val pages = ArrayList<ByteArray>()
        var i = 0
        var seq = firstSeq
        var continued = false
        while (i < segs.size) {
            val chunk = segs.subList(i, minOf(segs.size, i + 255))
            val ends = chunk.any { it.last }
            val o = ByteArrayOutputStream()
            o.write(latin1Bytes("OggS")); o.write(0)
            o.write(if (continued) 1 else 0)
            val g = if (ends) 0L else -1L
            o.u32le(g and 0xFFFFFFFFL); o.u32le(g ushr 32)
            o.u32le(serial.toLong() and 0xFFFFFFFFL)
            o.u32le(seq.toLong() and 0xFFFFFFFFL)
            o.u32le(0)
            o.write(chunk.size)
            for (s in chunk) o.write(s.len)
            for (s in chunk) o.write(packets[s.packet], s.off, s.len)
            val bytes = o.toByteArray()
            setCrc(bytes)
            pages.add(bytes)
            continued = !chunk.last().last
            i += chunk.size
            seq++
        }
        return pages
    }

    private val CRC = IntArray(256) { n ->
        var r = n shl 24
        repeat(8) { r = if (r and 0x80000000.toInt() != 0) (r shl 1) xor 0x04C11DB7 else r shl 1 }
        r
    }

    fun crc(b: ByteArray): Int {
        var c = 0
        for (x in b) c = (c shl 8) xor CRC[((c ushr 24) xor (x.toInt() and 0xFF)) and 0xFF]
        return c
    }

    private fun setCrc(page: ByteArray) {
        for (k in 22..25) page[k] = 0
        val v = crc(page)
        page[22] = v.toByte(); page[23] = (v shr 8).toByte(); page[24] = (v shr 16).toByte(); page[25] = (v shr 24).toByte()
    }
}
