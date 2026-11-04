package app.valence.core

/**
 * Hybrid logical clock, the desktop's HlcClock: wall-clock ms + counter + device id, encoded as
 * `<ms base36, 9>-<counter base36, 4>-<deviceId>` so plain string comparison orders events.
 *
 * Use one instance per process for everything this device logs (plays and favorites). Call
 * [observe] with the newest HLC of every ingested batch (and, at startup, with the newest HLC
 * already stored locally) so a new local event always sorts after everything seen, even when this
 * phone's clock is behind.
 */
class Hlc(val deviceId: String, private val now: () -> Long = System::currentTimeMillis) {
    data class Stamp(val ms: Long, val c: Long, val d: String)

    private var lastMs = 0L
    private var lastC = 0L

    /** The most recent stamp issued or observed (initially `000000000-0000-<deviceId>`). */
    val last: String
        get() = synchronized(this) { encode(lastMs, lastC, deviceId) }

    @Synchronized
    fun tick(): String {
        val ms = maxOf(now(), lastMs)
        lastC = if (ms == lastMs) lastC + 1 else 0
        lastMs = ms
        return encode(lastMs, lastC, deviceId)
    }

    /** Advances past a remote stamp. Malformed input is ignored. */
    @Synchronized
    fun observe(remote: String) {
        val r = decode(remote) ?: return
        val ms = maxOf(now(), lastMs, r.ms)
        val c = when {
            ms == lastMs && ms == r.ms -> maxOf(lastC, r.c) + 1
            ms == lastMs -> lastC + 1
            ms == r.ms -> r.c + 1
            else -> 0
        }
        lastMs = ms
        lastC = c
    }

    companion object {
        fun encode(ms: Long, c: Long, d: String): String =
            java.lang.Long.toString(ms, 36).padStart(9, '0') + "-" + java.lang.Long.toString(c, 36).padStart(4, '0') + "-" + d

        fun encode(s: Stamp): String = encode(s.ms, s.c, s.d)

        private fun isB36(ch: Char) = ch in '0'..'9' || ch in 'a'..'z'

        /** `/^([0-9a-z]+)-([0-9a-z]+)-(.+)$/`; null if malformed (or, unlike JS, past Long range). */
        fun decode(s: String): Stamp? {
            val d1 = s.indexOf('-')
            if (d1 <= 0) return null
            val d2 = s.indexOf('-', d1 + 1)
            if (d2 <= d1 + 1 || d2 == s.length - 1) return null
            for (i in 0 until d1) if (!isB36(s[i])) return null
            for (i in d1 + 1 until d2) if (!isB36(s[i])) return null
            for (i in d2 + 1 until s.length) if (Js.isLineTerminator(s[i])) return null
            val ms = s.substring(0, d1).toLongOrNull(36) ?: return null
            val c = s.substring(d1 + 1, d2).toLongOrNull(36) ?: return null
            return Stamp(ms, c, s.substring(d2 + 1))
        }

        /** Plain string order, which is HLC order. */
        fun compare(a: String, b: String): Int = a.compareTo(b).coerceIn(-1, 1)
    }
}
