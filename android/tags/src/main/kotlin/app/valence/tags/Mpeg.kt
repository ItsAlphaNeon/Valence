package app.valence.tags

import kotlin.math.roundToLong

// MPEG-1/2/2.5 audio (and raw ADTS AAC) stream info from the first frames, the way music-metadata's
// MpegParser computes it: Xing/Info frame count when present (VBRI too), else a CBR estimate.

internal object Mpeg {
    private val BITRATES = arrayOf(
        intArrayOf(0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448), // V1 L1
        intArrayOf(0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384), // V1 L2
        intArrayOf(0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320), // V1 L3
        intArrayOf(0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256), // V2 L1
        intArrayOf(0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160), // V2 L2/L3
    )
    private val RATES = arrayOf(intArrayOf(44100, 48000, 32000), intArrayOf(22050, 24000, 16000), intArrayOf(11025, 12000, 8000))
    private val ADTS_RATES = intArrayOf(96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350)

    /** Scan at most this far for the first frame (junk between the tag and the audio). */
    private const val MAX_SYNC_SCAN = 4L * 1024 * 1024

    class Frame(
        val mpeg1: Boolean, val v25: Boolean, val layer: Int, val bitrate: Int, val sampleRate: Int,
        val padding: Int, val mono: Boolean,
    ) {
        val samplesPerFrame: Int = when (layer) { 1 -> 384; 2 -> 1152; else -> if (mpeg1) 1152 else 576 }
        /** music-metadata MpegFrameHeader.frameSize: floor(spf / 8 * bitrate / rate) + padding slot. */
        val size: Int = (samplesPerFrame.toLong() / 8 * bitrate / sampleRate).toInt() + if (padding != 0) (if (layer == 1) 4 else 1) else 0
        val sideInfo: Int = if (mpeg1) (if (mono) 17 else 32) else (if (mono) 9 else 17)
        fun sameStream(o: Frame) = o.mpeg1 == mpeg1 && o.v25 == v25 && o.layer == layer && o.sampleRate == sampleRate
    }

    fun parseHeader(h: Long): Frame? {
        if ((h ushr 21) and 0x7FF != 0x7FFL) return null
        val ver = ((h ushr 19) and 3).toInt() // 0: 2.5, 1: reserved, 2: 2, 3: 1
        val layerBits = ((h ushr 17) and 3).toInt() // 1: L3, 2: L2, 3: L1
        val brIdx = ((h ushr 12) and 15).toInt()
        val srIdx = ((h ushr 10) and 3).toInt()
        if (ver == 1 || layerBits == 0 || brIdx == 0 || brIdx == 15 || srIdx == 3) return null
        val layer = 4 - layerBits
        val mpeg1 = ver == 3
        val table = if (mpeg1) layer - 1 else if (layer == 1) 3 else 4
        val bitrate = BITRATES[table][brIdx] * 1000
        val sampleRate = RATES[if (mpeg1) 0 else if (ver == 2) 1 else 2][srIdx]
        val padding = ((h ushr 9) and 1).toInt()
        val mono = ((h ushr 6) and 3).toInt() == 3
        return Frame(mpeg1, ver == 0, layer, bitrate, sampleRate, padding, mono)
    }

    private fun isAdts(b0: Int, b1: Int) = b0 == 0xFF && (b1 and 0xF6) == 0xF0

    /** True when an MPEG or ADTS frame starts at [pos]. */
    fun looksLikeFrame(src: Source, pos: Long): Boolean {
        if (!src.has(pos, 4)) return false
        if (isAdts(src.u8(pos), src.u8(pos + 1))) return true
        return parseHeader(src.u32be(pos)) != null
    }

    /** First frame at or after [from] whose successor is also a frame of the same stream, or -1. */
    private fun sync(src: Source, from: Long, end: Long, limit: Long): Long {
        var firstUnconfirmed = -1L
        var p = from
        val stop = minOf(end - 4, from + limit)
        while (p <= stop) {
            if (src.u8(p) != 0xFF) { p++; continue }
            val f = if (src.has(p, 4)) parseHeader(src.u32be(p)) else null
            if (f != null && f.size > 4) {
                val next = p + f.size
                if (next + 4 > end) return p // last frame of a tiny stream
                val g = parseHeader(src.u32be(next))
                if (g != null && g.sameStream(f)) return p
                if (firstUnconfirmed < 0) firstUnconfirmed = p
            }
            p++
        }
        return firstUnconfirmed
    }

    /**
     * Stream info for MPEG audio starting near [audioStart]. [hasId3v1] mirrors the desktop, which
     * subtracts the 128-byte ID3v1 tag from the stream size.
     */
    fun info(src: Source, audioStart: Long, hasId3v1: Boolean): AudioInfo {
        val end = src.length - if (hasId3v1) 128 else 0
        if (src.has(audioStart, 2) && isAdts(src.u8(audioStart), src.u8(audioStart + 1))) return adts(src, audioStart, end)
        val first = sync(src, audioStart, end, MAX_SYNC_SCAN)
        if (first < 0) {
            // Maybe raw AAC after junk/tags.
            throw CorruptFileException("no MPEG frame found")
        }
        val f = parseHeader(src.u32be(first))!!
        val mpegSize = (src.length - first - if (hasId3v1) 128 else 0).coerceAtLeast(0)
        val codec = when (f.layer) { 3 -> "mp3"; 2 -> "mp2"; else -> "mp1" }
        val channels = if (f.mono) 1 else 2

        // Xing / Info / VBRI in the first frame.
        val xingPos = first + 4 + f.sideInfo
        var frames = -1L
        var vbr = false
        if (src.has(xingPos, 8) && (src.matches(xingPos, "Xing") || src.matches(xingPos, "Info"))) {
            vbr = src.matches(xingPos, "Xing")
            val flags = src.u32be(xingPos + 4)
            if (flags and 1L != 0L && src.has(xingPos + 8, 4)) frames = src.u32be(xingPos + 8)
        } else if (src.has(first + 36, 18) && src.matches(first + 36, "VBRI")) {
            vbr = true
            frames = src.u32be(first + 36 + 14)
        }
        if (frames > 0) {
            val seconds = frames.toDouble() * f.samplesPerFrame / f.sampleRate
            val bitrate = if (vbr) mpegSize * 8 / seconds else frameBitrate(src, first, f, end).toDouble()
            return AudioInfo(codec, (seconds * 1000).roundToLong(), bitrate.roundToLong().toInt(), f.sampleRate, channels, null, false)
        }

        // No header: frames 1..4 decide CBR. The desktop then counts round(stream size / size of
        // frame 4) frames; that integer frame size ignores padding, so long 320k files read ~0.1%
        // long there. Replicated so both sides agree on durations.
        var p = first
        var constant = true
        var count = 0
        var lastSize = f.size
        while (count < 4 && src.has(p, 4)) {
            val g = parseHeader(src.u32be(p)) ?: break
            if (!g.sameStream(f)) break
            if (g.bitrate != f.bitrate) constant = false
            count++
            lastSize = g.size
            p += g.size
        }
        if (constant) {
            val frames = Math.round(mpegSize.toDouble() / lastSize)
            val seconds = frames.toDouble() * f.samplesPerFrame / f.sampleRate
            return AudioInfo(codec, (seconds * 1000).roundToLong(), f.bitrate, f.sampleRate, channels, null, false)
        }
        // Headerless VBR: the desktop scans every frame; estimate from samples of the stream instead.
        val avgBitrate = sampleBitrate(src, first, f, end)
        val seconds = mpegSize * 8 / avgBitrate
        return AudioInfo(codec, (seconds * 1000).roundToLong(), avgBitrate.roundToLong().toInt(), f.sampleRate, channels, null, false)
    }

    /** Bitrate of the frame after the Info frame (the Info frame itself is often a different size). */
    private fun frameBitrate(src: Source, first: Long, f: Frame, end: Long): Int {
        val next = first + f.size
        if (next + 4 <= end) parseHeader(src.u32be(next))?.let { if (it.sameStream(f)) return it.bitrate }
        return f.bitrate
    }

    /** Average bitrate of short frame runs at the start and at 25/50/75% (headerless VBR). */
    private fun sampleBitrate(src: Source, first: Long, f: Frame, end: Long): Double {
        var bits = 0.0
        var seconds = 0.0
        val span = end - first
        for (frac in doubleArrayOf(0.0, 0.25, 0.5, 0.75)) {
            var p = if (frac == 0.0) first else sync(src, first + (span * frac).toLong(), end, 64 * 1024)
            if (p < 0) continue
            var n = 0
            while (n < 24 && p + 4 <= end) {
                val g = parseHeader(src.u32be(p)) ?: break
                if (!g.sameStream(f)) break
                bits += g.bitrate.toDouble() * g.samplesPerFrame / g.sampleRate
                seconds += g.samplesPerFrame.toDouble() / g.sampleRate
                p += g.size
                n++
            }
        }
        return if (seconds > 0) bits / seconds else f.bitrate.toDouble()
    }

    /** Raw ADTS AAC: no index, so the length is estimated from the average size of the first frames. */
    private fun adts(src: Source, start: Long, end: Long): AudioInfo {
        var p = start
        var frames = 0
        var bytes = 0L
        var sampleRate = 0
        var channels = 2
        while (frames < 64 && src.has(p, 7) && p < end) {
            if (!isAdts(src.u8(p), src.u8(p + 1))) break
            val srIdx = (src.u8(p + 2) shr 2) and 15
            if (srIdx >= ADTS_RATES.size) break
            val ch = ((src.u8(p + 2) and 1) shl 2) or (src.u8(p + 3) shr 6)
            val len = ((src.u8(p + 3) and 3) shl 11) or (src.u8(p + 4) shl 3) or (src.u8(p + 5) shr 5)
            if (len < 7) break
            if (frames == 0) { sampleRate = ADTS_RATES[srIdx]; if (ch > 0) channels = ch }
            frames++
            bytes += len
            p += len
        }
        if (frames == 0 || sampleRate == 0) throw CorruptFileException("bad ADTS stream")
        val avg = bytes.toDouble() / frames
        val total = (end - start) / avg
        val seconds = total * 1024 / sampleRate
        val bitrate = avg * 8 * sampleRate / 1024
        return AudioInfo("aac", (seconds * 1000).roundToLong(), bitrate.roundToLong().toInt(), sampleRate, channels, null, false)
    }
}
