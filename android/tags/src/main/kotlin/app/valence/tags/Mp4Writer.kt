package app.valence.tags

import java.io.ByteArrayOutputStream
import java.io.OutputStream
import java.io.RandomAccessFile

/**
 * MP4 / M4A: rebuilds moov/udta/meta/ilst with the edited items. If moov sits in front of the audio
 * and grows, a free atom right after it absorbs the growth when it can; otherwise the audio moves and
 * every chunk offset (stco/co64) that points past moov moves with it.
 */
internal object Mp4Writer {
    private val CONTAINERS = setOf("moov", "trak", "mdia", "minf", "stbl", "udta", "meta", "ilst")

    /** iTunes item names an edit of [field] replaces; the first is the one written. */
    fun itemsOf(field: TagField): Set<String> = when (field) {
        TagField.TITLE -> setOf("©nam")
        TagField.ARTIST -> setOf("©ART")
        TagField.ALBUM -> setOf("©alb")
        TagField.ALBUM_ARTIST -> setOf("aART")
        TagField.GENRE -> linkedSetOf("©gen", "gnre")
        TagField.COMPOSER -> setOf("©wrt")
        TagField.DATE -> setOf("©day")
        TagField.TRACK_NO, TagField.TRACK_TOTAL -> setOf("trkn")
        TagField.DISC_NO, TagField.DISC_TOTAL -> setOf("disk")
    }

    /** One atom of the moov tree: containers on the path to ilst and to the chunk offsets are opened up. */
    private class Box(val type: String, var data: ByteArray?, var children: MutableList<Box>?, val fullBox: ByteArray? = null) {
        /** Bytes after a container's last child too short to be an atom (QuickTime's 4-byte terminator), kept as they are. */
        var tail = ByteArray(0)

        fun serialize(o: ByteArrayOutputStream) {
            val body = ByteArrayOutputStream()
            fullBox?.let { body.write(it) }
            if (children != null) { children!!.forEach { it.serialize(body) }; body.write(tail) } else body.write(data!!)
            val size = 8L + body.size()
            if (size > 0xFFFFFFFFL) throw TagWriteException("The file is too big to change")
            o.u32be(size); o.write(latin1Bytes(type)); body.writeTo(o)
        }

        fun child(type: String): Box? = children?.firstOrNull { it.type == type }
    }

    private class Top(val pos: Long, val size: Long, val type: String) {
        val end get() = pos + size
    }

    private fun topLevel(raf: RandomAccessFile): List<Top> {
        val len = raf.length()
        val out = ArrayList<Top>()
        var p = 0L
        while (p + 8 <= len) {
            val h = raf.bytesAt(p, 8)
            var size = h.u32be(0)
            val type = h.ascii(4, 4)
            if (size == 1L) size = raf.bytesAt(p + 8, 8).u64be(0)
            else if (size == 0L) size = len - p
            if (size < 8 || p + size > len) throw TagWriteException("This M4A file is damaged")
            out.add(Top(p, size, type))
            p += size
            if (out.size > 100_000) throw TagWriteException("This M4A file is damaged")
        }
        return out
    }

    private fun container(type: String, b: ByteArray, from: Int, to: Int, fullBox: ByteArray? = null): Box {
        val box = Box(type, null, null, fullBox)
        val (kids, tail) = parse(b, from, to, type)
        box.children = kids
        box.tail = tail
        return box
    }

    private fun parse(b: ByteArray, from: Int, to: Int, parent: String): Pair<MutableList<Box>, ByteArray> {
        val list = ArrayList<Box>()
        var p = from
        while (p + 8 <= to) {
            var size = b.u32be(p)
            var hl = 8
            if (size == 1L) { size = b.u64be(p + 8); hl = 16 } else if (size == 0L) size = (to - p).toLong()
            if (size < hl || p + size > to) throw TagWriteException("This M4A file is damaged")
            val type = b.ascii(p + 4, 4)
            val end = p + size.toInt()
            val box = when {
                parent == "ilst" -> Box(type, b.copyOfRange(p + hl, end), null)
                type == "meta" -> {
                    // ISO full box (version/flags) unless it's the QuickTime flavour that starts with a child atom.
                    val full = end - (p + hl) >= 4 && b.u32be(p + hl) == 0L
                    val start = p + hl + if (full) 4 else 0
                    container(type, b, start, end, if (full) b.copyOfRange(p + hl, p + hl + 4) else null)
                }
                type in CONTAINERS -> container(type, b, p + hl, end)
                else -> Box(type, b.copyOfRange(p + hl, end), null)
            }
            list.add(box)
            p = end
        }
        return list to b.copyOfRange(p, to)
    }

    fun write(raf: RandomAccessFile, out: OutputStream, c: Changes): Written {
        val tops = topLevel(raf)
        if (tops.any { it.type == "moof" }) throw TagWriteException("Fragmented MP4 files can't be edited")
        val moovs = tops.filter { it.type == "moov" }
        if (moovs.size != 1) throw TagWriteException("This M4A file is damaged")
        val old = moovs[0]
        if (old.size > 64L * 1024 * 1024) throw TagWriteException("This M4A file's header is too big to edit")
        val raw = raf.bytesAt(old.pos, old.size.toInt())
        val hl = if (raw.u32be(0) == 1L) 16 else 8
        val moov = container("moov", raw, hl, raw.size)

        val ilst = ilstOf(moov)
        val expected = HashMap<TagField, String?>()
        for ((field, value) in c.text) {
            val names = itemsOf(field)
            replace(ilst, names, listOfNotNull(value?.let { textItem(names.first(), it) }))
            expected[field] = value
        }
        c.track?.let { (no, total) -> replace(ilst, setOf("trkn"), listOfNotNull(no?.let { pairItem("trkn", it, total ?: 0, 8) })) }
        c.disc?.let { (no, total) -> replace(ilst, setOf("disk"), listOfNotNull(no?.let { pairItem("disk", it, total ?: 0, 6) })) }
        TagWriter.expectNumbers(c, expected, totalNeedsNumber = true)

        var bytes = ByteArrayOutputStream().also { moov.serialize(it) }.toByteArray()
        val delta = bytes.size - old.size
        val idx = tops.indexOf(old)
        val mdatAfter = tops.drop(idx + 1).any { it.type == "mdat" }
        val next = tops.getOrNull(idx + 1)?.takeIf { it.type == "free" || it.type == "skip" }
        var replaceFree = false
        var newFree = -1L
        if (mdatAfter && delta != 0L) {
            val room = (next?.size ?: 0L) - delta
            if (next != null && (room == 0L || room >= 8)) {
                replaceFree = true
                newFree = room
            } else {
                shiftOffsets(moov, old.end, delta)
                bytes = ByteArrayOutputStream().also { moov.serialize(it) }.toByteArray()
                if (bytes.size - old.size != delta) throw TagWriteException("The file's layout isn't one the editor understands")
            }
        }

        for ((i, t) in tops.withIndex()) {
            when {
                i == idx -> out.write(bytes)
                replaceFree && t === next -> if (newFree > 0) {
                    val f = ByteArrayOutputStream(); f.u32be(newFree); f.write(latin1Bytes("free")); f.writeTo(out)
                    writeZeros(out, newFree - 8)
                }
                else -> raf.copyTo(out, t.pos, t.end)
            }
        }
        return Written(expected)
    }

    /** moov/udta/meta/ilst, creating whichever part is missing. */
    private fun ilstOf(moov: Box): Box {
        val kids = moov.children!!
        val udta = moov.child("udta") ?: Box("udta", null, ArrayList()).also { kids.add(it) }
        val meta = udta.child("meta") ?: Box("meta", null, arrayListOf(hdlr()), ByteArray(4)).also { udta.children!!.add(it) }
        return meta.child("ilst") ?: Box("ilst", null, ArrayList()).also { meta.children!!.add(it) }
    }

    private fun hdlr(): Box {
        val o = ByteArrayOutputStream()
        o.u32be(0) // version/flags
        o.u32be(0) // pre-defined
        o.write(latin1Bytes("mdir"))
        o.write(latin1Bytes("appl")); o.u32be(0); o.u32be(0)
        o.write(0) // empty name
        return Box("hdlr", o.toByteArray(), null)
    }

    private fun replace(ilst: Box, names: Set<String>, new: List<Box>) {
        val kids = ilst.children!!
        val first = kids.indexOfFirst { it.type in names }
        kids.removeAll { it.type in names }
        kids.addAll(if (first < 0) kids.size else first, new)
    }

    private fun dataBox(type: Int, value: ByteArray): Box {
        val o = ByteArrayOutputStream()
        o.u32be(type.toLong()); o.u32be(0); o.write(value)
        return Box("data", o.toByteArray(), null)
    }

    private fun textItem(name: String, value: String) = Box(name, null, arrayListOf(dataBox(1, value.toByteArray(Charsets.UTF_8))))

    private fun pairItem(name: String, no: Int, total: Int, len: Int): Box {
        val o = ByteArrayOutputStream()
        o.u16be(0); o.u16be(no); o.u16be(total)
        if (len == 8) o.u16be(0)
        return Box(name, null, arrayListOf(dataBox(0, o.toByteArray())))
    }

    /** Moves every chunk offset at or past [from] by [delta]. */
    private fun shiftOffsets(moov: Box, from: Long, delta: Long) {
        for (trak in moov.children!!.filter { it.type == "trak" }) {
            val stbl = trak.child("mdia")?.child("minf")?.child("stbl") ?: continue
            for (box in stbl.children!!) {
                val b = box.data ?: continue
                when (box.type) {
                    "stco" -> {
                        val n = b.u32be(4).toInt()
                        if (8 + 4L * n > b.size) throw TagWriteException("This M4A file is damaged")
                        for (k in 0 until n) {
                            val i = 8 + 4 * k
                            val v = b.u32be(i)
                            if (v >= from) {
                                val nv = v + delta
                                if (nv < 0 || nv > 0xFFFFFFFFL) throw TagWriteException("The file is too big to change")
                                b[i] = (nv ushr 24).toByte(); b[i + 1] = (nv ushr 16).toByte(); b[i + 2] = (nv ushr 8).toByte(); b[i + 3] = nv.toByte()
                            }
                        }
                    }
                    "co64" -> {
                        val n = b.u32be(4).toInt()
                        if (8 + 8L * n > b.size) throw TagWriteException("This M4A file is damaged")
                        for (k in 0 until n) {
                            val i = 8 + 8 * k
                            val v = b.u64be(i)
                            if (v >= from) {
                                val nv = v + delta
                                for (j in 0 until 8) b[i + j] = (nv ushr (56 - 8 * j)).toByte()
                            }
                        }
                    }
                }
            }
        }
    }

    // ---- For the verifier ------------------------------------------------------------------------

    /** Each track's chunk offsets, as (index of the mdat atom, offset inside it). */
    fun chunkMap(raf: RandomAccessFile): List<List<Pair<Int, Long>>> {
        val tops = topLevel(raf)
        val mdats = tops.filter { it.type == "mdat" }
        val old = tops.single { it.type == "moov" }
        val raw = raf.bytesAt(old.pos, old.size.toInt())
        val hl = if (raw.u32be(0) == 1L) 16 else 8
        val moov = container("moov", raw, hl, raw.size)
        return moov.children!!.filter { it.type == "trak" }.map { trak ->
            val stbl = trak.child("mdia")?.child("minf")?.child("stbl")
            val offsets = ArrayList<Long>()
            stbl?.children?.forEach { box ->
                val b = box.data ?: return@forEach
                when (box.type) {
                    "stco" -> for (k in 0 until b.u32be(4).toInt()) offsets.add(b.u32be(8 + 4 * k))
                    "co64" -> for (k in 0 until b.u32be(4).toInt()) offsets.add(b.u64be(8 + 8 * k))
                }
            }
            offsets.map { off ->
                val m = mdats.indexOfFirst { off >= it.pos && off < it.end }
                if (m < 0) throw TagWriteException("A chunk offset points outside the audio")
                m to off - mdats[m].pos
            }
        }
    }

    /** The audio atoms' positions, for hashing their bytes. */
    fun mdatRanges(raf: RandomAccessFile): List<LongRange> = topLevel(raf).filter { it.type == "mdat" }.map { it.pos until it.end }
}
