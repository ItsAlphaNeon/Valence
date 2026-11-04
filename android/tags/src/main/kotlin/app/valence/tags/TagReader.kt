package app.valence.tags

import java.io.File
import java.io.IOException

/**
 * Reads audio info and tags the way the desktop does (music-metadata + src/main/tags/read.ts).
 * Only headers and tag regions are read; picture bytes are left on disk and fetched on demand with
 * [readPicture]. Corrupt input throws IOException (or [UnsupportedFormatException] for files that
 * aren't a supported audio format) or yields partial tags; it never reads the whole file.
 */
object TagReader {
    fun read(file: File): ReadResult = Source(file).use { src ->
        val col = Collector()
        var info = guard { parse(src, col, file.name) }
        // Desktop probeFile: no bitrate from the stream -> file size over the (rounded) duration.
        if (info.bitrate == 0 && info.durationMs > 0) {
            info = info.copy(bitrate = Math.round(src.length * 8.0 / (info.durationMs / 1000.0)).toInt())
        }
        val tags = guard { toTrackTags(col) }
        val pic = choosePicture(col)?.let { PictureRef(it.mime ?: "application/octet-stream", it.refOffset, it.length) }
        ReadResult(info, tags, pic)
    }

    /** The picture the desktop shows (front cover, else the first one), or null when there is none. */
    fun readPicture(file: File): ByteArray? = Source(file).use { src ->
        val col = Collector()
        guard { parse(src, col, file.name) }
        val p = choosePicture(col) ?: return null
        guard { load(src, p) }
    }

    /** The bytes of a picture that [read] reported. Throws IOException if the file no longer has it. */
    fun readPicture(file: File, ref: PictureRef): ByteArray = Source(file).use { src ->
        if (ref.length <= 0) throw IOException("empty picture reference")
        // Fast path: an unmodified image sits at the reference (most pictures).
        if (src.has(ref.offset, ref.length.toLong())) {
            val head = src.bytesUpTo(ref.offset, 16)
            if (sniffImageMime(head) != null) return src.bytes(ref.offset, ref.length)
        }
        // Encoded pictures (base64, unsynchronised, compressed) or unknown formats: parse again and decode.
        val col = Collector()
        guard { parse(src, col, file.name) }
        val all = col.native.mapNotNull { it.value as? PictureEntry }
        val p = all.firstOrNull { it.refOffset == ref.offset && it.length == ref.length }
            ?: all.firstOrNull { it.refOffset == ref.offset }
            ?: throw IOException("picture not found at ${ref.offset}")
        guard { load(src, p) }
    }

    private fun load(src: Source, p: PictureEntry): ByteArray = p.loader?.invoke() ?: src.bytes(p.refOffset, p.length)

    /** Turns parser bugs on hostile input (index errors and the like) into IOExceptions. */
    private inline fun <T> guard(fn: () -> T): T = try {
        fn()
    } catch (e: IOException) {
        throw e
    } catch (e: UnsupportedFormatException) {
        throw e
    } catch (e: RuntimeException) {
        throw CorruptFileException("corrupt file: $e")
    } catch (e: StackOverflowError) {
        throw CorruptFileException("corrupt file: nesting too deep")
    }

    private val MPEG_EXTENSIONS = setOf("mp3", "mp2", "mp1", "mpga", "aac")

    internal fun parse(src: Source, col: Collector, name: String): AudioInfo {
        if (src.length < 4) throw UnsupportedFormatException("file too small")
        // Leading ID3v2 tags (MP3, also seen in front of FLAC and raw AAC).
        val audioStart = Id3v2.parseAll(src, 0, col)
        val hadId3 = audioStart > 0
        val p = audioStart
        return when {
            src.has(p, 4) && src.matches(p, "fLaC") -> {
                val info = Flac.read(src, p, col)
                trailingTags(src, col)
                info
            }
            src.has(p, 4) && src.matches(p, "OggS") -> Ogg.read(src, p, col)
            !hadId3 && Mp4.detect(src) -> Mp4.read(src, col)
            !hadId3 && Riff.isWave(src) -> Riff.readWave(src, col)
            !hadId3 && Riff.isAiff(src) -> Riff.readAiff(src, col)
            hadId3 || Mpeg.looksLikeFrame(src, p) || name.substringAfterLast('.', "").lowercase() in MPEG_EXTENSIONS -> {
                val v1 = Id3v1.present(src)
                val info = try {
                    Mpeg.info(src, p, v1)
                } catch (e: CorruptFileException) {
                    if (!hadId3) throw UnsupportedFormatException("not an audio file") else throw e
                }
                trailingTags(src, col)
                info
            }
            else -> throw UnsupportedFormatException("unsupported or unknown audio format")
        }
    }

    /** APEv2 then ID3v1 at the end of the file (music-metadata's ID3v1Parser order). */
    private fun trailingTags(src: Source, col: Collector) {
        try {
            Ape.parse(src, col)
        } catch (e: Exception) {
            // Damaged APE tag: ignore.
        }
        try {
            Id3v1.parse(src, col)
        } catch (e: Exception) {
            // Damaged ID3v1 tag: ignore.
        }
    }
}
