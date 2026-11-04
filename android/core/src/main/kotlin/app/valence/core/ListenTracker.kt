package app.valence.core

/** A listen worth logging: hand it to [DeviceLog.appendPlay] (at = when the listen started). */
data class PendingPlay(
    val trackKey: String,
    val at: Long,
    val ms: Long,
    val completed: Boolean,
    val skipped: Boolean,
)

/**
 * Counts listening time the desktop player's way (beginListen / trackPlayed / endListen):
 * - only forward position steps under 1500 ms while playing count (seeks and stalls do not);
 * - a listen is a play once it reaches half the track or 4 minutes, whichever is less
 *   (4 minutes if the duration is unknown); `completed` is true only when it ended by finishing;
 * - a listen ended by a skip before that threshold and under 30 s is logged as a skip
 *   (completed = false, skipped = true); anything else is not logged.
 * Thread-safe.
 */
class ListenTracker {
    private class Listen(val trackKey: String, val durationMs: Long, val startedAt: Long, var playedMs: Double, var lastPos: Long)

    private var listen: Listen? = null
    private var engineDurationMs: Long = 0

    /** Starts a listen; any listen in progress is discarded unlogged (end it first to log it). */
    @Synchronized
    fun begin(trackKey: String, durationMs: Long, startPosMs: Long, wallClock: Long) {
        listen = Listen(trackKey, durationMs, wallClock, 0.0, startPosMs)
        engineDurationMs = 0
    }

    /** A position report from the player. */
    @Synchronized
    fun position(posMs: Long, playing: Boolean) {
        val l = listen ?: return
        val d = posMs - l.lastPos
        if (playing && d > 0 && d < 1500) l.playedMs += d
        l.lastPos = posMs
    }

    /** A user seek: moves the position without counting the jump. */
    @Synchronized
    fun seek(posMs: Long) {
        listen?.lastPos = posMs
    }

    /** The decoder's duration, used when the track's own duration is unknown (<= 0). */
    @Synchronized
    fun setDuration(durationMs: Long) {
        engineDurationMs = durationMs
    }

    @get:Synchronized
    val active: Boolean get() = listen != null

    /** Ends the listen. [reason] is "completed", "skipped" or "stopped". */
    @Synchronized
    fun end(reason: String): PendingPlay? {
        require(reason == COMPLETED || reason == SKIPPED || reason == STOPPED) { "reason must be completed, skipped or stopped" }
        val l = listen ?: return null
        listen = null
        return outcome(l, reason)
    }

    /** What [end] ("stopped") would log right now, without ending: persist it to survive process death. */
    @Synchronized
    fun snapshot(): PendingPlay? = listen?.let { outcome(it, STOPPED) }

    private fun outcome(l: Listen, reason: String): PendingPlay? {
        val dur = if (l.durationMs > 0) l.durationMs else engineDurationMs
        val threshold = if (dur > 0) minOf(dur * 0.5, 240_000.0) else 240_000.0
        val played = Js.round(l.playedMs).toLong()
        return when {
            played >= threshold -> PendingPlay(l.trackKey, l.startedAt, played, reason == COMPLETED, false)
            reason == SKIPPED && played < 30_000 -> PendingPlay(l.trackKey, l.startedAt, played, false, true)
            else -> null
        }
    }

    companion object {
        const val COMPLETED = "completed"
        const val SKIPPED = "skipped"
        const val STOPPED = "stopped"

        /** Below this a skip is logged as a skip. */
        const val SKIP_MAX_MS = 30_000L

        /** A listen counts after min(half the track, this). */
        const val PLAY_CAP_MS = 240_000L

        /** Position steps at or above this are seeks, not listening. */
        const val MAX_STEP_MS = 1_500L
    }
}
