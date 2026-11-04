package app.valence.tags

import kotlin.math.roundToLong

// MP4 / M4A (AAC, ALAC, ...): atom walk over moov (mdhd, hdlr, stsd) and udta/meta/ilst, plus mdat size.

internal object Mp4 {
    private const val MAX_ITEM = 16 * 1024 * 1024

    private class Atom(val pos: Long, val type: String, val headerLen: Int, val size: Long) {
        val body: Long get() = pos + headerLen
        val end: Long get() = pos + size
        val bodyLen: Long get() = size - headerLen
    }

    private class Track {
        var handler = ""
        var timescale = 0L
        var duration = 0L
        var format = ""
        var channels = 0
        var sampleSize = 0
        var sampleRate = 0
        var alacBits = 0
        var alacRate = 0
        var alacChannels = 0
    }

    private class State(val src: Source, val col: Collector) {
        val tracks = ArrayList<Track>()
        var mdatBytes = 0L
        var atoms = 0
    }

    /** True if an atom of a type we know starts at 0 (ftyp, or a bare moov/mdat/free... file). */
    fun detect(src: Source): Boolean {
        if (!src.has(0, 8)) return false
        val t = src.ascii(4, 4)
        if (t == "ftyp") return true
        if (t !in setOf("moov", "free", "wide", "skip", "mdat", "pnot")) return false
        val size = src.u32be(0)
        return size == 1L || (size >= 8 && size <= src.length)
    }

    private fun atomAt(src: Source, pos: Long, limit: Long): Atom? {
        if (pos + 8 > limit || !src.has(pos, 8)) return null
        var size = src.u32be(pos)
        val type = src.ascii(pos + 4, 4)
        var hl = 8
        if (size == 1L) {
            if (!src.has(pos + 8, 8)) return null
            size = src.u64be(pos + 8)
            hl = 16
        } else if (size == 0L) {
            size = limit - pos
        }
        if (size < hl) return null
        if (pos + size > limit) size = limit - pos // truncated: clamp to the parent
        if (size < hl) return null
        return Atom(pos, type, hl, size)
    }

    private inline fun children(st: State, from: Long, end: Long, fn: (Atom) -> Unit) {
        var p = from
        while (p + 8 <= end) {
            if (++st.atoms > 100_000) return
            val a = atomAt(st.src, p, end) ?: return
            fn(a)
            p = a.end
        }
    }

    fun read(src: Source, col: Collector): AudioInfo {
        val st = State(src, col)
        children(st, 0, src.length) { a ->
            when (a.type) {
                "moov" -> moov(st, a)
                "mdat" -> st.mdatBytes += a.bodyLen
            }
        }
        val audio = st.tracks.firstOrNull { it.handler == "soun" } ?: st.tracks.firstOrNull { it.format.isNotEmpty() }
            ?: throw CorruptFileException("MP4 without an audio track")
        val seconds = if (audio.timescale > 0) audio.duration.toDouble() / audio.timescale else 0.0
        val codec = when (audio.format) {
            "mp4a" -> "aac"
            "alac" -> "alac"
            "fLaC" -> "flac"
            "Opus" -> "opus"
            ".mp3" -> "mp3"
            "ac-3" -> "ac3"
            "ec-3" -> "ac3"
            else -> audio.format.lowercase().trim().ifEmpty { "unknown" }
        }
        val lossless = codec == "alac" || codec == "flac"
        val sampleRate = when {
            audio.alacRate > 0 -> audio.alacRate
            audio.sampleRate > 0 -> audio.sampleRate
            else -> audio.timescale.clampToInt()
        }
        val channels = if (audio.alacChannels > 0) audio.alacChannels else audio.channels
        val bits = if (audio.alacBits > 0) audio.alacBits else audio.sampleSize
        val bitrate = if (seconds > 0) st.mdatBytes * 8 / seconds else 0.0
        return AudioInfo(
            codec, (seconds * 1000).roundToLong(), bitrate.roundToLong().toInt(), sampleRate, channels,
            if (lossless && bits > 0) bits else null, lossless,
        )
    }

    private fun moov(st: State, moov: Atom) {
        children(st, moov.body, moov.end) { a ->
            when (a.type) {
                "trak" -> st.tracks.add(trak(st, a))
                "udta" -> children(st, a.body, a.end) { u -> if (u.type == "meta") meta(st, u) }
                "meta" -> meta(st, a)
            }
        }
    }

    private fun trak(st: State, trak: Atom): Track {
        val t = Track()
        children(st, trak.body, trak.end) { a ->
            if (a.type == "mdia") children(st, a.body, a.end) { m ->
                when (m.type) {
                    "mdhd" -> mdhd(st.src, m, t)
                    "hdlr" -> if (m.bodyLen >= 12) t.handler = st.src.ascii(m.body + 8, 4)
                    "minf" -> children(st, m.body, m.end) { i ->
                        if (i.type == "stbl") children(st, i.body, i.end) { s -> if (s.type == "stsd") stsd(st, s, t) }
                    }
                }
            }
        }
        return t
    }

    private fun mdhd(src: Source, a: Atom, t: Track) {
        if (a.bodyLen < 24) return
        val version = src.u8(a.body)
        if (version == 1) {
            if (a.bodyLen < 32) return
            t.timescale = src.u32be(a.body + 20)
            t.duration = src.u64be(a.body + 24)
        } else {
            t.timescale = src.u32be(a.body + 12)
            t.duration = src.u32be(a.body + 16)
        }
    }

    private fun stsd(st: State, a: Atom, t: Track) {
        val src = st.src
        if (a.bodyLen < 16) return
        val entry = atomAt(src, a.body + 8, a.end) ?: return
        t.format = entry.type
        val d = entry.body // 6 reserved + 2 data ref index, then the sound description
        if (entry.bodyLen < 28) return
        val version = src.u16be(d + 8)
        t.channels = src.u16be(d + 16)
        t.sampleSize = src.u16be(d + 18)
        t.sampleRate = (src.u32be(d + 24) ushr 16).toInt()
        val childStart = d + when (version) { 1 -> 44; 2 -> 64; else -> 28 }
        if (version == 2 && entry.bodyLen >= 64) {
            val rate = java.lang.Double.longBitsToDouble(src.u64be(d + 32))
            if (rate > 0 && rate < 1e7) t.sampleRate = rate.toInt()
            t.channels = src.u32be(d + 40).toInt()
            t.sampleSize = src.u32be(d + 48).toInt()
        }
        children(st, childStart, entry.end) { c ->
            if (c.type == "alac" && c.bodyLen >= 28) {
                val b = src.bytes(c.body, 28)
                t.alacBits = b.u8(4 + 5)
                t.alacChannels = b.u8(4 + 9)
                t.alacRate = b.u32be(4 + 20).toInt()
            }
        }
    }

    private fun meta(st: State, meta: Atom) {
        val src = st.src
        // ISO full box (version/flags) unless it is the QuickTime flavour that starts with a child atom.
        var start = meta.body
        if (meta.bodyLen >= 4 && src.u32be(meta.body) == 0L) start += 4
        children(st, start, meta.end) { a -> if (a.type == "ilst") ilst(st, a) }
    }

    private fun ilst(st: State, ilst: Atom) {
        children(st, ilst.body, ilst.end) { item ->
            if (item.type[0] == '\u0000') return@children // indexed (keys) item: not used by music files
            try {
                if (item.type == "covr") covr(st, item) else item(st, item)
            } catch (e: Exception) {
                // Damaged item: skip it.
            }
        }
    }

    private fun covr(st: State, item: Atom) {
        val src = st.src
        children(st, item.body, item.end) { d ->
            if (d.type != "data" || d.bodyLen < 8) return@children
            if (src.u8(d.body) != 0) return@children
            val type = src.u24be(d.body + 1)
            val offset = d.body + 8
            val len = (d.bodyLen - 8).clampToInt()
            if (len <= 0) return@children
            val mime = when (type) {
                13 -> "image/jpeg"
                14 -> "image/png"
                27 -> "image/bmp"
                else -> sniffImageMime(src.bytesUpTo(offset, 16))
            }
            st.col.add(TagType.ITUNES, "covr", PictureEntry(0, mime, offset, len, null))
        }
    }

    private fun item(st: State, item: Atom) {
        if (item.size > MAX_ITEM) return
        val b = st.src.bytes(item.body, item.bodyLen.toInt())
        var key = item.type
        var p = 0
        while (p + 8 <= b.size) {
            var size = b.u32be(p)
            if (size < 8 || size > b.size - p) size = (b.size - p).toLong()
            val type = b.ascii(p + 4, 4)
            val body = p + 8
            val end = p + size.toInt()
            when (type) {
                "mean", "name" -> if (end - body >= 4) key += ":" + utf8(b, body + 4, end - body - 4)
                "data" -> if (end - body >= 8 && b.u8(body) == 0) value(st, key, b.u24be(body + 1), b, body + 8, end)
            }
            p = end
        }
    }

    private fun value(st: State, key: String, type: Int, b: ByteArray, off: Int, end: Int) {
        val len = end - off
        val col = st.col
        val t = TagType.ITUNES
        when (type) {
            0 -> when (key) {
                "trkn", "disk" -> if (len >= 6) col.add(t, key, "${b.u16be(off + 2)}/${b.u16be(off + 4)}")
                    else if (len >= 4) col.add(t, key, "${b.u16be(off + 2)}")
                "gnre" -> if (len >= 2) GENRES.getOrNull(b.u16be(off) - 1)?.let { col.add(t, key, it) }
            }
            1, 18 -> col.add(t, key, utf8(b, off, len))
            21, 22 -> beInt(b, off, len, type == 21)?.let { col.add(t, key, it) }
            65 -> if (len >= 1) col.add(t, key, b[off].toLong())
            66 -> if (len >= 2) col.add(t, key, b.u16be(off).toShort().toLong())
            67 -> if (len >= 4) col.add(t, key, b.u32be(off).toInt().toLong())
        }
    }

    private fun beInt(b: ByteArray, off: Int, len: Int, signed: Boolean): Long? = when (len) {
        1 -> if (signed) b[off].toLong() else b.u8(off).toLong()
        2 -> if (signed) b.u16be(off).toShort().toLong() else b.u16be(off).toLong()
        3 -> b.u24be(off).toLong().let { if (signed && it and 0x800000L != 0L) it - 0x1000000L else it }
        4 -> if (signed) b.u32be(off).toInt().toLong() else b.u32be(off)
        8 -> b.u64be(off)
        else -> null
    }
}
