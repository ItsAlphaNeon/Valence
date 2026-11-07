package app.valence.tags

import java.io.BufferedOutputStream
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.io.OutputStream
import java.io.RandomAccessFile

/** The fields the tag editor can change. */
enum class TagField { TITLE, ARTIST, ALBUM, ALBUM_ARTIST, GENRE, COMPOSER, DATE, TRACK_NO, TRACK_TOTAL, DISC_NO, DISC_TOTAL }

/** A tag edit was refused or failed its check; [message] is meant for people. */
class TagWriteException(message: String) : IOException(message)

/**
 * New values for some fields of one file: a blank value removes the field, a field that isn't in
 * the map is left as it is. Values are trimmed; numbers and dates are checked here.
 */
class TagEdit(values: Map<TagField, String?>) {
    val values: Map<TagField, String?> = values.mapValues { (f, v) -> clean(f, v) }

    val isEmpty: Boolean get() = values.isEmpty()

    /**
     * True when [tags] already read as this edit asks, so writing would change nothing a reader
     * sees (e.g. merging an album where most songs already have the right name).
     */
    fun isAppliedIn(tags: TrackTags): Boolean = values.all { (f, v) -> tags.valueOf(f) == v }

    companion object {
        private val DATE = Regex("\\d{4}(-(0[1-9]|1[0-2])(-(0[1-9]|[12]\\d|3[01]))?)?")
        private val NUMBERS = setOf(TagField.TRACK_NO, TagField.TRACK_TOTAL, TagField.DISC_NO, TagField.DISC_TOTAL)

        /** Why [value] can't go in [field], or null if it can. */
        fun problem(field: TagField, value: String?): String? {
            val v = value?.trim().orEmpty()
            if (v.isEmpty()) return null
            return when (field) {
                in NUMBERS -> if (v.toIntOrNull()?.takeIf { it in 1..65535 } == null) "Use a whole number from 1 to 65535" else null
                TagField.DATE -> if (!DATE.matches(v)) "Use a year (2024) or a date (2024-05-31)" else null
                else -> if (v.length > 4096) "Too long" else null
            }
        }

        private fun clean(field: TagField, value: String?): String? {
            val v = value?.trim()?.takeIf { it.isNotEmpty() } ?: return null
            problem(field, v)?.let { throw IllegalArgumentException(it) }
            return if (field in NUMBERS) v.toInt().toString() else v
        }
    }
}

/** The current value of [field] in [tags], as the editor shows it. */
fun TrackTags.valueOf(field: TagField): String? = when (field) {
    TagField.TITLE -> title
    TagField.ARTIST -> artist
    TagField.ALBUM -> album
    TagField.ALBUM_ARTIST -> albumArtist
    TagField.GENRE -> genre
    TagField.COMPOSER -> composer
    TagField.DATE -> date
    TagField.TRACK_NO -> trackNo?.toString()
    TagField.TRACK_TOTAL -> trackTotal?.toString()
    TagField.DISC_NO -> discNo?.toString()
    TagField.DISC_TOTAL -> discTotal?.toString()
}

/**
 * What one write does, worked out from the edit and the file's current tags: [text] for the plain
 * fields, and the final number/total pairs when a track or disc field changes (a number and its
 * total are always written together).
 */
internal class Changes(
    val text: Map<TagField, String?>,
    val track: Pair<Int?, Int?>?,
    val disc: Pair<Int?, Int?>?,
)

/** What the writer expects the reader to see afterwards; [unchecked] fields can't be compared exactly. */
internal class Written(val expected: Map<TagField, String?>, val unchecked: Set<TagField> = emptySet())

/**
 * Writes tags in place of the desktop's node-taglib-sharp, for the phone's tag editor. Only the
 * fields being edited change: every other frame, comment, atom and the audio stay byte-for-byte as
 * they were, and audio keeps its offset when the old tag has room (padding, free atoms).
 *
 * Supported: MP3 (ID3v2.3 / v2.4; a file without one gets v2.3), FLAC, Ogg Opus and Ogg Vorbis, and
 * MP4/M4A. Anything else, or a file laid out in a way the writer doesn't handle, is refused.
 */
object TagWriter {
    private val TEXT = listOf(TagField.TITLE, TagField.ARTIST, TagField.ALBUM, TagField.ALBUM_ARTIST, TagField.GENRE, TagField.COMPOSER, TagField.DATE)

    internal enum class Kind { MP3, FLAC, OGG, MP4 }

    /** Why [file]'s tags can't be edited, or null if they can (a quick look at the file's start). */
    fun unsupportedReason(file: File): String? = try {
        kindOf(file)
        null
    } catch (e: TagWriteException) {
        e.message
    } catch (e: IOException) {
        "Can't read the file (${e.message})"
    }

    /**
     * Writes [src] with [edit] applied to the new file [dst], then checks [dst] against [src]: the
     * audio is the same bytes, each edited field reads back as asked, and nothing else changed.
     * Throws [TagWriteException] (and deletes [dst]) if anything is off. [src] is only read.
     */
    fun writeVerified(src: File, dst: File, edit: TagEdit) {
        try {
            val before = TagReader.read(src)
            val changes = resolve(edit, before.tags)
            val kind = kindOf(src)
            val written = RandomAccessFile(src, "r").use { raf ->
                FileOutputStream(dst).use { fos ->
                    val out = BufferedOutputStream(fos, 64 * 1024)
                    val w = when (kind) {
                        Kind.MP3 -> Id3Writer.write(raf, out, changes)
                        Kind.FLAC -> FlacWriter.write(raf, out, changes)
                        Kind.OGG -> OggWriter.write(raf, out, changes)
                        Kind.MP4 -> Mp4Writer.write(raf, out, changes)
                    }
                    out.flush()
                    fos.fd.sync()
                    w
                }
            }
            TagVerifier.verify(kind, src, dst, changes, written)
        } catch (e: Throwable) {
            dst.delete()
            throw when (e) {
                is TagWriteException -> e
                is UnsupportedFormatException -> TagWriteException("This kind of file isn't supported")
                is IOException -> TagWriteException("Couldn't write the tags (${e.message})")
                is IllegalArgumentException -> TagWriteException(e.message ?: "Invalid value")
                is RuntimeException -> TagWriteException("The file's layout isn't one the editor understands")
                else -> e
            }
        }
    }

    internal fun kindOf(file: File): Kind = Source(file).use { src ->
        if (src.length < 8) throw TagWriteException("The file is too small to be audio")
        val p = Id3v2.parseAll(src, 0, null)
        val hadId3 = p > 0
        when {
            src.matches(p, "fLaC") -> Kind.FLAC
            src.matches(p, "OggS") -> Kind.OGG
            !hadId3 && Mp4.detect(src) -> Kind.MP4
            !hadId3 && (Riff.isWave(src) || Riff.isAiff(src)) -> throw TagWriteException("Tags in WAV and AIFF files can't be edited here")
            hadId3 || Mpeg.looksLikeFrame(src, p) || file.name.substringAfterLast('.', "").lowercase() == "mp3" -> Kind.MP3
            else -> throw TagWriteException("This kind of file isn't supported")
        }
    }

    internal fun resolve(edit: TagEdit, current: TrackTags): Changes {
        val v = edit.values
        val text = TEXT.filter { it in v }.associateWith { v[it] }
        fun pair(no: TagField, total: TagField, curNo: Int?, curTotal: Int?): Pair<Int?, Int?>? =
            if (no !in v && total !in v) null
            else Pair(if (no in v) v[no]?.toInt() else curNo, if (total in v) v[total]?.toInt() else curTotal)
        return Changes(
            text,
            pair(TagField.TRACK_NO, TagField.TRACK_TOTAL, current.trackNo, current.trackTotal),
            pair(TagField.DISC_NO, TagField.DISC_TOTAL, current.discNo, current.discTotal),
        )
    }

    /** Expected values for the number fields, given what a format can hold ([totalNeedsNumber]: no "of N" without an N). */
    internal fun expectNumbers(c: Changes, out: MutableMap<TagField, String?>, totalNeedsNumber: Boolean) {
        c.track?.let { (no, total) ->
            out[TagField.TRACK_NO] = no?.toString()
            out[TagField.TRACK_TOTAL] = if (totalNeedsNumber && no == null) null else total?.toString()
        }
        c.disc?.let { (no, total) ->
            out[TagField.DISC_NO] = no?.toString()
            out[TagField.DISC_TOTAL] = if (totalNeedsNumber && no == null) null else total?.toString()
        }
    }
}

// ---- Small byte helpers shared by the writers -----------------------------------------------------

internal fun RandomAccessFile.bytesAt(pos: Long, n: Int): ByteArray {
    if (n < 0 || pos < 0 || pos + n > length()) throw CorruptFileException("read of $n bytes at $pos past the end")
    val b = ByteArray(n)
    seek(pos)
    readFully(b)
    return b
}

/** Copies [from, to) of the file to [out]. */
internal fun RandomAccessFile.copyTo(out: OutputStream, from: Long, to: Long) {
    val buf = ByteArray(256 * 1024)
    var p = from
    seek(p)
    while (p < to) {
        val n = read(buf, 0, minOf(buf.size.toLong(), to - p).toInt())
        if (n < 0) throw CorruptFileException("unexpected end of file at $p")
        out.write(buf, 0, n)
        p += n
    }
}

internal fun ByteArrayOutputStream.u32be(v: Long) {
    write((v ushr 24).toInt() and 0xFF); write((v ushr 16).toInt() and 0xFF); write((v ushr 8).toInt() and 0xFF); write(v.toInt() and 0xFF)
}

internal fun ByteArrayOutputStream.u32le(v: Long) {
    write(v.toInt() and 0xFF); write((v ushr 8).toInt() and 0xFF); write((v ushr 16).toInt() and 0xFF); write((v ushr 24).toInt() and 0xFF)
}

internal fun ByteArrayOutputStream.u16be(v: Int) {
    write((v ushr 8) and 0xFF); write(v and 0xFF)
}

internal fun latin1Bytes(s: String): ByteArray = ByteArray(s.length) { s[it].code.toByte() }
