package app.valence.core

import java.io.File
import java.io.FileOutputStream
import java.security.SecureRandom
import java.time.Instant
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter

/** One play-log line (`plays-YYYY-MM.jsonl`). [device] is the folder the line came from. */
data class PlayEvent(
    val hlc: String,
    val device: String,
    val trackKey: String,
    val at: Long,
    val ms: Long,
    val completed: Boolean,
    val skipped: Boolean,
)

/** One favorites-log line. [kind] is `t` (track), `a` (album) or `r` (artist); [at] is set only when a like moved keys. */
data class FavoriteEvent(
    val hlc: String,
    val device: String,
    val kind: String,
    val key: String,
    val on: Boolean,
    val at: Long?,
) {
    /** The liked time the desktop stores: `at`, else the HLC's wall-clock ms, else [now]. */
    fun effectiveAt(now: Long = System.currentTimeMillis()): Long = at ?: Hlc.decode(hlc)?.ms ?: now
}

/**
 * This device's append-only logs in `<valenceDir>/devices/<deviceId>/` (the desktop's DeviceLog,
 * PlayLog.record and FavoritesLog.set). Lines are byte-identical to the desktop's. Only ever
 * writes this device's own folder.
 *
 * Appending does not update any local tables: store the returned event yourself (the same
 * idempotent insert the ingest uses), or let the next [LogReader] pass pick it up, since the
 * reader reads this device's own folder too.
 */
class DeviceLog(
    val valenceDir: File,
    val deviceId: String,
    val hlc: Hlc,
    val platform: String = "android",
    val appVersion: String,
) {
    init {
        require(isValidDeviceId(deviceId)) { "bad device id" }
    }

    val dir: File get() = File(File(valenceDir, DEVICES_DIR), deviceId)

    private val lock = Any()

    /** Appends a listen. The file is `plays-<UTC year-month of [at]>.jsonl`. */
    fun appendPlay(trackKey: String, at: Long, ms: Long, completed: Boolean, skipped: Boolean): PlayEvent = synchronized(lock) {
        val h = hlc.tick()
        val line = linkedMapOf<String, Any?>("hlc" to h, "k" to trackKey, "at" to at, "ms" to ms, "c" to if (completed) 1 else 0, "s" to if (skipped) 1 else 0)
        append("$PLAYS_PREFIX-${monthOf(at)}.jsonl", JsJson.stringify(line) + "\n")
        PlayEvent(h, deviceId, trackKey, at, ms, completed, skipped)
    }

    /**
     * Appends a like/unlike toggle. Pass [at] only when a like follows an item to a new key (the
     * desktop's moveKey); otherwise the HLC's time is the liked time, exactly as on the desktop.
     * Like the desktop, callers should only log a toggle that changes the current state.
     */
    fun appendFavorite(kind: String, key: String, on: Boolean, at: Long? = null): FavoriteEvent =
        appendFavorites(kind, listOf(key), on, at).single()

    /** Several toggles in one write, each with its own increasing HLC (the desktop's appendMany). */
    fun appendFavorites(kind: String, keys: List<String>, on: Boolean, at: Long? = null): List<FavoriteEvent> = synchronized(lock) {
        require(kind == "t" || kind == "a" || kind == "r") { "kind must be t, a or r" }
        require(keys.all { it.isNotEmpty() }) { "empty favorite key" }
        if (keys.isEmpty()) return emptyList()
        val events = keys.map { FavoriteEvent(hlc.tick(), deviceId, kind, it, on, at) }
        val text = StringBuilder()
        for (e in events) {
            val line = linkedMapOf<String, Any?>("hlc" to e.hlc, "kind" to kind, "k" to e.key, "on" to if (on) 1 else 0)
            if (at != null) line["at"] = at
            text.append(JsJson.stringify(line)).append('\n')
        }
        append("$FAVORITES_PREFIX.jsonl", text.toString())
        events
    }

    /**
     * Writes `device.json` (`{id, platform, lastSeen, appVersion}`, indent 1, atomically) and creates
     * the empty `.nomedia` marker in `.valence` if it is missing. Informational: nothing reads it.
     */
    fun touchDeviceJson(now: Long = System.currentTimeMillis()) {
        dir.mkdirs()
        val nomedia = File(valenceDir, ".nomedia")
        if (!nomedia.exists()) runCatching { nomedia.createNewFile() }
        val doc = linkedMapOf<String, Any?>("id" to deviceId, "platform" to platform, "lastSeen" to isoMillis(now), "appVersion" to appVersion)
        AtomicFiles.writeText(File(dir, "device.json"), JsJson.stringify(doc, 1))
    }

    /** True if this device's log for [at]'s month already has a play of [trackKey] at [at] (dedup for a re-sent pending listen). */
    fun containsPlay(trackKey: String, at: Long): Boolean {
        val f = File(dir, "$PLAYS_PREFIX-${monthOf(at)}.jsonl")
        if (!f.exists()) return false
        return f.useLines { lines ->
            lines.any { line ->
                val o = JsJson.parseOrNull(line) as? Map<*, *> ?: return@any false
                o["k"] == trackKey && Js.toNumber(o["at"]) == at.toDouble()
            }
        }
    }

    private fun append(name: String, text: String) {
        val d = dir
        d.mkdirs()
        FileOutputStream(File(d, name), true).use {
            it.write(text.toByteArray(Charsets.UTF_8))
            it.fd.sync()
        }
    }

    companion object {
        const val DEVICES_DIR = "devices"
        const val PLAYS_PREFIX = "plays"
        const val FAVORITES_PREFIX = "favorites"

        private val ISO: DateTimeFormatter = DateTimeFormatter.ofPattern("uuuu-MM-dd'T'HH:mm:ss.SSS'Z'").withZone(ZoneOffset.UTC)
        private val MONTH: DateTimeFormatter = DateTimeFormatter.ofPattern("uuuu-MM").withZone(ZoneOffset.UTC)

        /** `new Date(ms).toISOString()` for years 0000-9999. */
        fun isoMillis(ms: Long): String = ISO.format(Instant.ofEpochMilli(ms))

        /** UTC `YYYY-MM` of a time, the monthly play file suffix. */
        fun monthOf(ms: Long): String = MONTH.format(Instant.ofEpochMilli(ms))

        /** A new random device id: 16 lowercase hex characters, like the desktop's. */
        fun newDeviceId(random: SecureRandom = SecureRandom()): String {
            val b = ByteArray(8)
            random.nextBytes(b)
            return b.joinToString("") { "%02x".format(it.toInt() and 0xff) }
        }

        /** Device folder names the phone accepts as its own id (safe as a path component). */
        fun isValidDeviceId(id: String): Boolean = id.length >= 12 && id.all { it in 'a'..'z' || it in '0'..'9' }
    }
}
