package app.valence.tags

import java.io.File
import java.io.RandomAccessFile
import java.security.MessageDigest

/**
 * Checks a freshly written copy against the original before it may replace it: same audio (bytes,
 * and for MP4 the same chunk positions), same stream info, every tag that wasn't edited still there
 * with the same value, and each edited field reading back as asked.
 */
internal object TagVerifier {
    private val LABELS = mapOf(
        TagField.TITLE to "title", TagField.ARTIST to "artist", TagField.ALBUM to "album", TagField.ALBUM_ARTIST to "album artist",
        TagField.GENRE to "genre", TagField.COMPOSER to "composer", TagField.DATE to "year", TagField.TRACK_NO to "track number",
        TagField.TRACK_TOTAL to "track count", TagField.DISC_NO to "disc number", TagField.DISC_TOTAL to "disc count",
    )

    private class Parsed(val info: AudioInfo, val tags: TrackTags, val native: List<String>)

    fun verify(kind: TagWriter.Kind, src: File, dst: File, c: Changes, w: Written) {
        val fields = c.text.keys + (if (c.track != null) setOf(TagField.TRACK_NO, TagField.TRACK_TOTAL) else emptySet()) +
            (if (c.disc != null) setOf(TagField.DISC_NO, TagField.DISC_TOTAL) else emptySet())
        val before = parse(src, src.name, fields)
        val after = parse(dst, src.name, fields)

        val a = before.info
        val b = after.info
        if (a.codec != b.codec || a.durationMs != b.durationMs || a.sampleRate != b.sampleRate || a.channels != b.channels ||
            a.bitDepth != b.bitDepth || a.lossless != b.lossless
        ) fail("the audio details changed")

        if (!payload(kind, src).contentEquals(payload(kind, dst))) fail("the audio changed")

        if (before.native != after.native) fail("other tags changed")

        for (f in fields) {
            if (f in w.unchecked) continue
            val want = cleanOrNull(w.expected[f])
            val got = after.tags.valueOf(f)
            if (want != got) {
                throw TagWriteException(
                    "The new ${LABELS[f]} didn't read back as written (another tag in the file may override it), so the file was left as it was",
                )
            }
        }
    }

    private fun fail(what: String): Nothing = throw TagWriteException("Saving went wrong ($what), so the file was left as it was")

    /** Reads [file] the way the library does; [native] lists every tag except the ones [fields] touch. */
    private fun parse(file: File, name: String, fields: Set<TagField>): Parsed = Source(file).use { src ->
        val col = Collector()
        val info = TagReader.parse(src, col, name)
        val skip = HashMap<TagType, Set<String>>()
        val id3 = fields.flatMap { Id3Writer.frameIds(it) }.toSet()
        skip[TagType.ID3V23] = id3
        skip[TagType.ID3V24] = id3
        skip[TagType.VORBIS] = fields.flatMap { VorbisCommentBlock.keysOf(it) }.toSet()
        skip[TagType.ITUNES] = fields.flatMap { Mp4Writer.itemsOf(it) }.toSet()
        skip[TagType.ID3V1] = fields.flatMap { Id3Writer.v1Ids(it) }.toSet()
        val native = col.native.filter { t -> skip[t.type]?.contains(t.id) != true }.map { t ->
            val v = when (val x = t.value) {
                is PictureEntry -> {
                    val bytes = x.loader?.invoke() ?: src.bytes(x.refOffset, x.length)
                    "picture ${x.pictureType} ${x.mime} ${x.length} ${hex(sha(bytes))}"
                }
                is CommentValue -> "comment ${x.descriptor}\u0000${x.text}"
                is PopmValue -> "popm ${x.email} ${x.rating}"
                else -> x.toString()
            }
            "${t.type}|${t.id}|$v"
        }
        Parsed(info, toTrackTags(col), native)
    }

    private fun payload(kind: TagWriter.Kind, file: File): ByteArray = RandomAccessFile(file, "r").use { raf ->
        val md = MessageDigest.getInstance("SHA-256")
        when (kind) {
            TagWriter.Kind.MP3 -> {
                // The ID3v1 trailer is a tag too: its fields are compared above, with the other tags.
                val start = Source(file).use { Id3v2.parseAll(it, 0, null) }
                val v1 = Id3Writer.hasId3v1(raf)
                md.update((if (v1) 1 else 0).toByte())
                digestRange(raf, md, start, raf.length() - if (v1) 128 else 0)
            }
            TagWriter.Kind.FLAC -> {
                val start = FlacWriter.flacStart(raf)
                var p = start + 4
                while (true) {
                    val h = raf.bytesAt(p, 4)
                    val type = h.u8(0) and 0x7F
                    val size = h.u24be(1)
                    // Every block but the comments and padding must be unchanged (STREAMINFO, pictures, seek table...).
                    if (type != 4 && type != 1) { md.update(type.toByte()); md.update(raf.bytesAt(p + 4, size)) }
                    p += 4 + size
                    if (h.u8(0) and 0x80 != 0) break
                }
                digestRange(raf, md, p, raf.length())
            }
            TagWriter.Kind.OGG -> {
                val h = OggWriter.headers(raf)
                md.update(raf.bytesAt(0, h.first.end.toInt()))
                for (pk in h.packets.drop(1)) md.update(pk)
                var pos = h.end
                while (pos < raf.length()) {
                    val pg = OggWriter.readPage(raf, pos)
                    if (pg == null) { digestRange(raf, md, pos, raf.length()); break }
                    val bytes = raf.bytesAt(pg.pos, (pg.end - pg.pos).toInt())
                    val stored = bytes.u32le(22).toInt()
                    for (k in 22..25) bytes[k] = 0
                    if (OggWriter.crc(bytes) != stored) fail("a page checksum is wrong")
                    // Everything but the sequence number and checksum.
                    md.update(bytes, 4, 14)
                    md.update(bytes, 26, bytes.size - 26)
                    pos = pg.end
                }
            }
            TagWriter.Kind.MP4 -> {
                for (r in Mp4Writer.mdatRanges(raf)) digestRange(raf, md, r.first, r.last + 1)
                md.update(Mp4Writer.chunkMap(raf).toString().toByteArray())
            }
        }
        md.digest()
    }

    private fun digestRange(raf: RandomAccessFile, md: MessageDigest, from: Long, to: Long) {
        val buf = ByteArray(256 * 1024)
        var p = from
        raf.seek(p)
        while (p < to) {
            val n = raf.read(buf, 0, minOf(buf.size.toLong(), to - p).toInt())
            if (n < 0) break
            md.update(buf, 0, n)
            p += n
        }
    }

    private fun sha(b: ByteArray): ByteArray = MessageDigest.getInstance("SHA-256").digest(b)
    private fun hex(b: ByteArray): String = b.joinToString("") { "%02x".format(it) }
}
