package app.valence.core

import java.io.File
import java.io.RandomAccessFile

/**
 * Byte offsets of how far each device log has been ingested, keyed by device folder + file name
 * (the desktop's `log_cursors` key is `"$device/$file"`). Keep it in the phone's local DB, never in
 * the synced folder. [get] returns 0 for an unknown file.
 */
interface CursorStore {
    fun get(device: String, file: String): Long
    fun set(device: String, file: String, offset: Long)
}

/** A [CursorStore] in memory (tests, or a caller that persists [snapshot] itself). */
class InMemoryCursorStore : CursorStore {
    private val map = LinkedHashMap<String, Long>()

    @Synchronized override fun get(device: String, file: String): Long = map["$device/$file"] ?: 0L

    @Synchronized override fun set(device: String, file: String, offset: Long) {
        map["$device/$file"] = offset
    }

    @Synchronized fun snapshot(): Map<String, Long> = LinkedHashMap(map)
}

/**
 * New events from one [LogReader] pass, sorted by HLC, plus the cursor positions just past them.
 *
 * Commit semantics: reading never moves a cursor. Store the events first (idempotently: plays
 * `INSERT OR IGNORE` on (device, hlc); favorites last-writer-wins, applying an event only if its
 * hlc is greater than the stored row's), and only then call [commit], which writes the new
 * offsets to the [CursorStore]. If the process dies, or storing fails, before [commit], the next
 * pass returns the same events again (plus anything newer), which the idempotent store absorbs.
 * [commit] is idempotent. Commit batches in the order they were read; committing an older batch
 * after a newer one only rewinds the cursors (harmless re-reads).
 */
class LogBatch<T> internal constructor(
    val events: List<T>,
    private val cursors: List<Cursor>,
    private val store: CursorStore,
    /** Newest HLC in [events] (null if empty): pass it to [Hlc.observe] after storing them. */
    val maxHlc: String?,
) : List<T> by events {
    internal data class Cursor(val device: String, val file: String, val offset: Long)

    @Volatile
    var committed = false
        private set

    /** Files whose cursor this batch advances: `"device/file"` to new byte offset. */
    val pendingCursors: Map<String, Long> get() = cursors.associate { "${it.device}/${it.file}" to it.offset }

    @Synchronized
    fun commit() {
        if (committed) return
        for (c in cursors) store.set(c.device, c.file, c.offset)
        committed = true
    }

    override fun toString(): String = "LogBatch(events=${events.size}, maxHlc=$maxHlc, committed=$committed)"
}

/**
 * Incremental reader of every device's logs under `<valenceDir>/devices/` (the desktop's
 * readNewEvents + PlayLog.ingest + FavoritesLog.ingest). Reads all device folders, this device's
 * own included. Only complete lines (ending in `\n`) are consumed; a trailing partial line (a
 * file mid-sync) is left for the next pass. A file that shrank below its cursor is re-read from 0.
 * Corrupt lines, lines without a string `hlc`, and conflict copies are skipped like the desktop.
 */
class LogReader(val valenceDir: File, private val cursors: CursorStore) {
    /** A parsed log line with its origin. [fields] is the JSON object (JS-modelled values). */
    internal class Raw(val device: String, val file: String, val hlc: String, val fields: Map<*, *>)

    /** New plays from every device. See [LogBatch] for when to [LogBatch.commit]. */
    @Synchronized
    fun newPlays(): LogBatch<PlayEvent> {
        val (raw, curs) = readNew(DeviceLog.PLAYS_PREFIX)
        val out = ArrayList<PlayEvent>()
        for (e in raw) {
            val k = e.fields["k"] as? String ?: continue
            out.add(
                PlayEvent(
                    hlc = e.hlc,
                    device = e.device,
                    trackKey = k,
                    at = Js.toLong(orZero(Js.toNumber(e.fields["at"]))),
                    ms = Js.toLong(orZero(Js.toNumber(e.fields["ms"]))),
                    completed = Js.truthy(e.fields["c"]),
                    skipped = Js.truthy(e.fields["s"]),
                ),
            )
        }
        return LogBatch(out, curs, cursors, out.maxOfOrNull { it.hlc })
    }

    /** New favorite toggles from every device, sorted by HLC (apply last-writer-wins by hlc). */
    @Synchronized
    fun newFavorites(): LogBatch<FavoriteEvent> {
        val (raw, curs) = readNew(DeviceLog.FAVORITES_PREFIX)
        val out = ArrayList<FavoriteEvent>()
        for (e in raw) {
            val kind = e.fields["kind"] as? String ?: continue
            if (kind != "t" && kind != "a" && kind != "r") continue
            val k = e.fields["k"] as? String ?: continue
            if (k.isEmpty()) continue
            val at = (e.fields["at"] as? Double)?.takeIf { !it.isNaN() && !it.isInfinite() }?.let { Js.round(it).toLong() }
            out.add(FavoriteEvent(e.hlc, e.device, kind, k, Js.truthy(e.fields["on"]), at))
        }
        return LogBatch(out, curs, cursors, out.maxOfOrNull { it.hlc })
    }

    private fun orZero(d: Double) = if (d.isNaN() || d == 0.0) 0.0 else d

    internal fun readNew(prefix: String): Pair<List<Raw>, List<LogBatch.Cursor>> {
        val root = File(valenceDir, DeviceLog.DEVICES_DIR)
        val out = ArrayList<Raw>()
        val curs = ArrayList<LogBatch.Cursor>()
        val devices = root.list()?.sorted() ?: return out to curs
        for (device in devices) {
            val dir = File(root, device)
            if (!dir.isDirectory) continue
            val files = dir.list()?.filter { it.startsWith(prefix) && it.endsWith(".jsonl") && !it.contains(".sync-conflict-") }?.sorted() ?: continue
            for (name in files) {
                val f = File(dir, name)
                if (!f.isFile) continue
                try {
                    RandomAccessFile(f, "r").use { raf ->
                        val size = raf.length()
                        val cur = cursors.get(device, name)
                        val offset = if (cur in 0..size) cur else 0L
                        if (offset == size) return@use
                        val n = size - offset
                        if (n > Int.MAX_VALUE - 16) return@use
                        val buf = ByteArray(n.toInt())
                        raf.seek(offset)
                        raf.readFully(buf)
                        var lastNl = buf.size - 1
                        while (lastNl >= 0 && buf[lastNl] != '\n'.code.toByte()) lastNl--
                        if (lastNl < 0) return@use
                        var start = 0
                        for (i in 0..lastNl) {
                            if (buf[i] == '\n'.code.toByte()) {
                                parseLine(String(buf, start, i - start, Charsets.UTF_8), device, name)?.let(out::add)
                                start = i + 1
                            }
                        }
                        val next = offset + lastNl + 1
                        if (next != cur) curs.add(LogBatch.Cursor(device, name, next))
                    }
                } catch (_: java.io.IOException) {
                    // unreadable right now (mid-sync, permissions): try again next pass
                }
            }
        }
        // Stable sort by HLC string, like the desktop's Array.prototype.sort.
        out.sortWith { a, b -> a.hlc.compareTo(b.hlc) }
        return out to curs
    }

    private fun parseLine(line: String, device: String, file: String): Raw? {
        if (Js.trim(line).isEmpty()) return null
        val v = JsJson.parseOrNull(line) as? Map<*, *> ?: return null
        val hlc = v["hlc"] as? String ?: return null
        return Raw(device, file, hlc, v)
    }
}
