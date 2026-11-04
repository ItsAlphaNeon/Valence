package app.valence.tags

import kotlin.math.roundToLong

// WAV (RIFF/WAVE) and AIFF/AIFC: stream info from fmt/COMM, length from data/SSND, tags from an
// embedded ID3v2 chunk ("id3 " / "ID3 ") plus RIFF LIST/INFO and AIFF text chunks.

internal object Riff {
    private const val MAX_TEXT = 64 * 1024

    fun isWave(src: Source) = src.has(0, 12) && src.matches(0, "RIFF") && src.matches(8, "WAVE")
    fun isAiff(src: Source) = src.has(0, 12) && src.matches(0, "FORM") && (src.matches(8, "AIFF") || src.matches(8, "AIFC"))

    private fun cString(b: ByteArray): String {
        var n = b.indexOf(0)
        if (n < 0) n = b.size
        return latin1(b, 0, n)
    }

    fun readWave(src: Source, col: Collector): AudioInfo {
        val riffEnd = minOf(src.length, 8 + src.u32le(4))
        var pos = 12L
        var formatTag = 0
        var channels = 0
        var sampleRate = 0
        var avgBytes = 0L
        var blockAlign = 0
        var bits = 0
        var factSamples = -1L
        var dataSize = -1L
        var chunks = 0
        while (pos + 8 <= riffEnd && chunks++ < 10_000) {
            val id = src.ascii(pos, 4)
            val size = src.u32le(pos + 4)
            val body = pos + 8
            val avail = minOf(size, src.length - body)
            try {
                when (id) {
                    "fmt " -> if (avail >= 16) {
                        val b = src.bytes(body, minOf(avail, 40L).toInt())
                        formatTag = b.u16le(0)
                        channels = b.u16le(2)
                        sampleRate = b.u32le(4).clampToInt()
                        avgBytes = b.u32le(8)
                        blockAlign = b.u16le(12)
                        bits = b.u16le(14)
                        if (formatTag == 0xFFFE && b.size >= 26) formatTag = b.u16le(24) // extensible: sub-format GUID
                    }
                    "fact" -> if (avail >= 4) factSamples = src.u32le(body)
                    "data" -> dataSize = avail
                    "id3 ", "ID3 " -> Id3v2.parseAll(src, body, col)
                    "LIST" -> if (avail >= 4 && src.matches(body, "INFO")) info(src, body + 4, body + avail, col)
                }
            } catch (e: Exception) {
                if (id == "fmt ") throw e
                // Damaged tag chunk: keep what was read.
            }
            if (size > src.length) break
            pos = body + size + (size and 1)
        }
        if (sampleRate <= 0) throw CorruptFileException("WAV without a fmt chunk")
        val pcm = formatTag == 1 || formatTag == 3
        val samples = when {
            factSamples > 0 -> factSamples
            dataSize > 0 && blockAlign > 0 && dataSize != 0xFFFFFFFFL -> dataSize / blockAlign
            else -> 0L
        }
        val seconds = samples.toDouble() / sampleRate
        val bitrate = if (avgBytes > 0) avgBytes * 8.0 else if (seconds > 0) dataSize * 8 / seconds else 0.0
        val codec = when (formatTag) {
            1, 3 -> "pcm"
            0x55 -> "mp3"
            else -> "unknown"
        }
        return AudioInfo(codec, (seconds * 1000).roundToLong(), bitrate.roundToLong().toInt(), sampleRate, channels, if (pcm && bits > 0) bits else null, pcm)
    }

    private fun info(src: Source, from: Long, end: Long, col: Collector) {
        var p = from
        var n = 0
        while (p + 8 <= end && n++ < 1000) {
            val id = src.ascii(p, 4)
            val size = src.u32le(p + 4)
            if (size > end - p - 8) break
            if (size in 1..MAX_TEXT) {
                val v = cString(src.bytes(p + 8, size.toInt()))
                col.add(TagType.EXIF, id, v)
            }
            p += 8 + size + (size and 1)
        }
    }

    /** 80-bit IEEE extended sample rate, the way music-metadata decodes it (integer rates). */
    private fun extendedRate(b: ByteArray, off: Int): Int {
        val shift = b.u16be(off) - 16398
        val base = b.u16be(off + 2)
        return if (shift < 0) base shr minOf(-shift, 31) else if (shift > 15) 0 else base shl shift
    }

    fun readAiff(src: Source, col: Collector): AudioInfo {
        val aifc = src.matches(8, "AIFC")
        val formEnd = minOf(src.length, 8 + src.u32be(4))
        var pos = 12L
        var channels = 0
        var frames = 0L
        var bits = 0
        var sampleRate = 0
        var compression = "NONE"
        var soundBytes = -1L
        var chunks = 0
        while (pos + 8 <= formEnd && chunks++ < 10_000) {
            val id = src.ascii(pos, 4)
            val size = src.u32be(pos + 4)
            val body = pos + 8
            val avail = minOf(size, src.length - body)
            try {
                when (id) {
                    "COMM" -> if (avail >= 18) {
                        val b = src.bytes(body, minOf(avail, 22L).toInt())
                        channels = b.u16be(0)
                        frames = b.u32be(2)
                        bits = b.u16be(6)
                        sampleRate = extendedRate(b, 8)
                        if (aifc && b.size >= 22) compression = b.ascii(18, 4)
                    }
                    "SSND" -> if (avail >= 8) soundBytes = (size - 8 - src.u32be(body)).coerceAtLeast(0)
                    "ID3 ", "id3 " -> Id3v2.parseAll(src, body, col)
                    "NAME", "AUTH", "(c) ", "ANNO" -> if (avail in 1..MAX_TEXT.toLong()) {
                        col.add(TagType.AIFF, id, cString(src.bytes(body, avail.toInt())))
                    }
                }
            } catch (e: Exception) {
                if (id == "COMM") throw e
            }
            if (size > src.length) break
            pos = body + size + (size and 1)
        }
        if (sampleRate <= 0) throw CorruptFileException("AIFF without a COMM chunk")
        val pcm = compression in setOf("NONE", "sowt", "twos", "raw ", "in24", "in32", "fl32", "fl64", "FL32", "FL64")
        val seconds = frames.toDouble() / sampleRate
        val bitrate = if (soundBytes >= 0 && seconds > 0) 8.0 * soundBytes / seconds else 0.0
        return AudioInfo(
            if (pcm) "pcm" else compression.trim().lowercase().ifEmpty { "unknown" },
            (seconds * 1000).roundToLong(), bitrate.roundToLong().toInt(), sampleRate, channels,
            if (pcm && bits > 0) bits else null, pcm,
        )
    }
}
