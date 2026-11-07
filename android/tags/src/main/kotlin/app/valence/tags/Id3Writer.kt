package app.valence.tags

import java.io.ByteArrayOutputStream
import java.io.OutputStream
import java.io.RandomAccessFile

/**
 * Rewrites an MP3's leading ID3v2.3/2.4 tag (or adds a v2.3 one, as the desktop writes). Frames
 * that aren't being edited are copied as raw bytes; when the new tag fits in the old one's space
 * the rest becomes padding, so the audio stays where it was.
 */
internal object Id3Writer {
    private const val NEW_PADDING = 4096
    private val FRAME_ID = Regex("[A-Z0-9]{4}")

    private val TEXT_FRAMES = mapOf(
        TagField.TITLE to "TIT2", TagField.ARTIST to "TPE1", TagField.ALBUM to "TALB",
        TagField.ALBUM_ARTIST to "TPE2", TagField.GENRE to "TCON", TagField.COMPOSER to "TCOM",
    )

    /** Frames that carry the date in either version (a v2.3 tag may also hold a v2.4-style TDRC). */
    private val DATE_FRAMES = setOf("TYER", "TDAT", "TIME", "TRDA", "TDRC")

    /** ID3v2.3 values the reader (music-metadata) splits on '/'. */
    private val SLASH_SPLIT = setOf(TagField.ARTIST, TagField.ALBUM_ARTIST, TagField.COMPOSER)

    private class Frame(val id: String, val raw: ByteArray)

    /** Native frame ids an edit of [field] touches, for the verifier. */
    fun frameIds(field: TagField): Set<String> = when (field) {
        TagField.DATE -> DATE_FRAMES
        TagField.TRACK_NO, TagField.TRACK_TOTAL -> setOf("TRCK")
        TagField.DISC_NO, TagField.DISC_TOTAL -> setOf("TPOS")
        else -> setOf(TEXT_FRAMES.getValue(field))
    }

    fun write(raf: RandomAccessFile, out: OutputStream, c: Changes): Written {
        val len = raf.length()
        var major = 3
        var audioStart = 0L
        val frames = ArrayList<Frame>()
        val head = if (len >= 10) raf.bytesAt(0, 10) else ByteArray(0)
        val hasTag = head.size == 10 && head.matches(0, "ID3")
        if (hasTag) {
            major = head.u8(3)
            if (major == 2) throw TagWriteException("This MP3 has an old ID3v2.2 tag, which the editor can't change")
            if (major !in 3..4 || head.u8(4) == 0xFF) throw TagWriteException("This MP3's ID3 tag is a version the editor doesn't know")
            val flags = head.u8(5)
            if (flags and 0x80 != 0) throw TagWriteException("This MP3's ID3 tag is unsynchronised, which the editor can't change")
            var size = 0
            for (i in 6..9) {
                if (head.u8(i) >= 0x80) throw TagWriteException("This MP3's ID3 tag is damaged")
                size = (size shl 7) or head.u8(i)
            }
            audioStart = 10L + size + (if (major == 4 && flags and 0x10 != 0) 10 else 0)
            if (audioStart > len) throw TagWriteException("This MP3's ID3 tag is damaged")
            if (audioStart + 10 <= len && raf.bytesAt(audioStart, 3).matches(0, "ID3")) {
                throw TagWriteException("This MP3 has several ID3 tags, which the editor can't change")
            }
            val body = raf.bytesAt(10, size)
            var p = 0
            if (flags and 0x40 != 0) {
                // Extended header: dropped (its CRC, if any, would no longer match).
                if (body.size < 4) throw TagWriteException("This MP3's ID3 tag is damaged")
                p = if (major == 4) {
                    ((body.u8(0) and 0x7F) shl 21) or ((body.u8(1) and 0x7F) shl 14) or ((body.u8(2) and 0x7F) shl 7) or (body.u8(3) and 0x7F)
                } else {
                    body.u32be(0).toInt() + 4
                }
                if (p < 4 || p > body.size) throw TagWriteException("This MP3's ID3 tag is damaged")
            }
            while (p + 10 <= body.size) {
                if (body[p] == 0.toByte()) break // padding
                val id = body.ascii(p, 4)
                if (!FRAME_ID.matches(id)) throw TagWriteException("This MP3's ID3 tag has frames the editor can't read")
                val b0 = body.u8(p + 4); val b1 = body.u8(p + 5); val b2 = body.u8(p + 6); val b3 = body.u8(p + 7)
                // The reader's rule: v2.4 sizes are syncsafe unless a byte has its high bit set (some writers got it wrong).
                val fsize = if (major == 4 && (b0 or b1 or b2 or b3) and 0x80 == 0) {
                    ((b0 shl 21) or (b1 shl 14) or (b2 shl 7) or b3).toLong()
                } else {
                    (b0.toLong() shl 24) or (b1.toLong() shl 16) or (b2.toLong() shl 8) or b3.toLong()
                }
                if (p + 10 + fsize > body.size) throw TagWriteException("This MP3's ID3 tag is damaged")
                frames.add(Frame(id, body.copyOfRange(p, p + 10 + fsize.toInt())))
                p += 10 + fsize.toInt()
            }
            // Whatever follows the last frame is padding (or a few stray bytes the reader ignores too).
        }

        val expected = HashMap<TagField, String?>()
        val unchecked = HashSet<TagField>()
        for ((field, value) in c.text) {
            if (field == TagField.DATE) continue
            val id = TEXT_FRAMES.getValue(field)
            replace(frames, setOf(id), listOfNotNull(value?.let { text(major, id, it) }))
            expected[field] = value
            if (major == 3 && field in SLASH_SPLIT && value != null && '/' in value) unchecked.add(field)
        }
        if (TagField.DATE in c.text) {
            val date = c.text[TagField.DATE]
            val new = ArrayList<Frame>()
            if (date != null) {
                if (major == 4) {
                    new.add(text(major, "TDRC", date))
                    expected[TagField.DATE] = date
                } else {
                    new.add(text(major, "TYER", date.substring(0, 4)))
                    if (date.length == 10) new.add(text(major, "TDAT", date.substring(8, 10) + date.substring(5, 7)))
                    expected[TagField.DATE] = if (date.length == 10) date else date.substring(0, 4)
                }
            } else {
                expected[TagField.DATE] = null
            }
            replace(frames, DATE_FRAMES, new)
        }
        c.track?.let { (no, total) -> replace(frames, setOf("TRCK"), listOfNotNull(no?.let { text(major, "TRCK", if (total != null) "$it/$total" else "$it") })) }
        c.disc?.let { (no, total) -> replace(frames, setOf("TPOS"), listOfNotNull(no?.let { text(major, "TPOS", if (total != null) "$it/$total" else "$it") })) }
        TagWriter.expectNumbers(c, expected, totalNeedsNumber = true)

        val body = ByteArrayOutputStream()
        for (f in frames) body.write(f.raw)
        val room = if (hasTag) audioStart - 10 else -1L
        val size = if (body.size() <= room) room else body.size().toLong() + NEW_PADDING
        if (size >= 1L shl 28) throw TagWriteException("The tag would be too big")
        val header = ByteArrayOutputStream()
        header.write(latin1Bytes("ID3"))
        header.write(major); header.write(0); header.write(0)
        header.write(syncsafe(size.toInt()))
        out.write(header.toByteArray())
        body.writeTo(out)
        writeZeros(out, size - body.size())
        if (hasId3v1(raf) && audioStart <= len - 128) {
            // The reader takes ID3v1's track number over ID3v2's, and falls back to its other fields
            // when ID3v2 has none, so the trailer has to say the same thing.
            raf.copyTo(out, audioStart, len - 128)
            out.write(id3v1(raf.bytesAt(len - 128, 128), c))
        } else {
            raf.copyTo(out, audioStart, len)
        }
        return Written(expected, unchecked)
    }

    fun hasId3v1(raf: RandomAccessFile): Boolean = raf.length() >= 128 && raf.bytesAt(raf.length() - 128, 3).matches(0, "TAG")

    /** ID3v1 field names (as the reader reports them) an edit of [field] touches, for the verifier. */
    fun v1Ids(field: TagField): Set<String> = when (field) {
        TagField.TITLE -> setOf("title")
        TagField.ARTIST -> setOf("artist")
        TagField.ALBUM -> setOf("album")
        TagField.GENRE -> setOf("genre")
        TagField.DATE -> setOf("year")
        TagField.TRACK_NO, TagField.TRACK_TOTAL -> setOf("track")
        else -> emptySet()
    }

    private fun id3v1(old: ByteArray, c: Changes): ByteArray {
        val b = old.copyOf()
        fun put(off: Int, len: Int, v: String?) {
            for (i in 0 until len) b[off + i] = 0
            if (v == null) return
            for (i in 0 until minOf(len, v.length)) b[off + i] = (if (v[i].code < 0x100) v[i].code else '?'.code).toByte()
        }
        for ((f, v) in c.text) {
            when (f) {
                TagField.TITLE -> put(3, 30, v)
                TagField.ARTIST -> put(33, 30, v)
                TagField.ALBUM -> put(63, 30, v)
                TagField.DATE -> put(93, 4, v?.take(4))
                TagField.GENRE -> {
                    val i = if (v == null) -1 else GENRES.indexOf(v).takeIf { it >= 0 } ?: GENRES.indexOfFirst { it.equals(v, ignoreCase = true) }
                    b[127] = (if (i in 0..254) i else 255).toByte()
                }
                else -> {}
            }
        }
        // ID3v1.1 keeps the track in byte 126 when byte 125 is zero; a longer comment leaves no room for one.
        c.track?.let { (no, _) -> if (b[125] == 0.toByte()) b[126] = (if (no != null && no in 1..255) no else 0).toByte() }
        return b
    }

    /** Removes every frame with an id in [ids]; [new] goes where the first of them was (or at the end). */
    private fun replace(frames: MutableList<Frame>, ids: Set<String>, new: List<Frame>) {
        val first = frames.indexOfFirst { it.id in ids }
        frames.removeAll { it.id in ids }
        frames.addAll(if (first < 0) frames.size else first, new)
    }

    private fun text(major: Int, id: String, value: String): Frame {
        val data = ByteArrayOutputStream()
        when {
            value.all { it.code < 0x100 } -> { data.write(0); data.write(latin1Bytes(value)) }
            major == 4 -> { data.write(3); data.write(value.toByteArray(Charsets.UTF_8)) }
            else -> { data.write(1); data.write(0xFF); data.write(0xFE); data.write(value.toByteArray(Charsets.UTF_16LE)) }
        }
        val d = data.toByteArray()
        val f = ByteArrayOutputStream(d.size + 10)
        f.write(latin1Bytes(id))
        if (major == 4) f.write(syncsafe(d.size)) else f.u32be(d.size.toLong())
        f.write(0); f.write(0)
        f.write(d)
        return Frame(id, f.toByteArray())
    }

    private fun syncsafe(n: Int): ByteArray = byteArrayOf(
        ((n shr 21) and 0x7F).toByte(), ((n shr 14) and 0x7F).toByte(), ((n shr 7) and 0x7F).toByte(), (n and 0x7F).toByte(),
    )
}

internal fun writeZeros(out: OutputStream, n: Long) {
    val z = ByteArray(8192)
    var left = n
    while (left > 0) {
        val k = minOf(left, z.size.toLong()).toInt()
        out.write(z, 0, k)
        left -= k
    }
}
