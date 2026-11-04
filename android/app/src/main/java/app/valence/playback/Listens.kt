package app.valence.playback

import android.util.AtomicFile
import android.util.Log
import app.valence.ValenceApp
import app.valence.core.ListenTracker
import app.valence.core.Loudness
import app.valence.core.PendingPlay
import app.valence.data.Track
import org.json.JSONObject
import java.io.File

/**
 * Listen accounting, exactly as the desktop player does it (core's ListenTracker): counts the time
 * actually listened, and on each track change decides whether that was a play, a skip, or nothing.
 * Plays go to this phone's plays log through [app.valence.sync.Sync.recordPlay].
 *
 * The in-progress listen is saved now and then, so a listen cut short by process death is still
 * logged (as "stopped") on the next start, and never twice.
 */
class Listens(private val app: ValenceApp) {
    enum class End { Completed, Skipped, Stopped }

    private val tracker = ListenTracker()
    private var active: Track? = null
    private var playing = false
    private val pending = AtomicFile(File(app.filesDir, "pending-listen.json"))

    /** What the previous process left unlogged; read once, before anything can overwrite the file. */
    private var leftover: Pair<PendingPlay, Long>? = runCatching { readPending() }.getOrNull()

    /** The song being counted, if any. */
    val activeTrackId: Long? get() = active?.id

    /** Starts counting [t] unless it's already the song being counted. */
    fun ensure(t: Track, posMs: Long) {
        if (active?.id != t.id) begin(t, posMs)
    }

    fun begin(t: Track, posMs: Long) {
        if (active != null) end(End.Stopped)
        active = t
        tracker.begin(t.trackKey, t.durationMs, posMs, System.currentTimeMillis())
        tracker.position(posMs, playing)
    }

    fun onPlaying(isPlaying: Boolean, posMs: Long) {
        if (active != null) tracker.position(posMs, playing)
        playing = isPlaying
        if (active != null) tracker.position(posMs, playing)
    }

    fun tick(posMs: Long) {
        if (active != null) tracker.position(posMs, playing)
    }

    /** A seek inside the same track: the jump itself isn't listening time (the tracker ignores big deltas). */
    fun onSeek(posMs: Long) {
        if (active != null) tracker.seek(posMs)
    }

    fun end(reason: End) {
        active ?: return
        // A track that was paused and then replaced counts as stopped, not skipped (desktop rule).
        val r = if (reason == End.Skipped && !playing) End.Stopped else reason
        val p = tracker.end(r.name.lowercase())
        active = null
        clearPending()
        if (p != null) app.sync.recordPlay(p)
    }

    /** Saves the listen in progress (called with the queue's periodic save). */
    fun persistPending() {
        val t = active
        val snap = if (t != null) tracker.snapshot() else null
        if (snap == null || snap.ms <= 0) {
            clearPending()
            return
        }
        runCatching {
            val json = JSONObject()
                .put("k", snap.trackKey).put("at", snap.at).put("ms", snap.ms).put("dur", t!!.durationMs)
            val out = pending.startWrite()
            try {
                out.write(json.toString().toByteArray())
                pending.finishWrite(out)
            } catch (e: Exception) {
                pending.failWrite(out)
                throw e
            }
        }.onFailure { Log.w(TAG, "Couldn't save the listen in progress", it) }
    }

    /** Logs what the previous process didn't get to, if it counts as a play. */
    fun restorePending() {
        val (p, dur) = leftover ?: return
        leftover = null
        val threshold = if (dur > 0) minOf(dur / 2, 240_000L) else 240_000L
        if (p.ms >= threshold) app.sync.recordPlay(p.copy(completed = false, skipped = false))
        if (active == null) clearPending()
    }

    private fun readPending(): Pair<PendingPlay, Long>? {
        if (!pending.baseFile.exists()) return null
        val o = JSONObject(String(pending.readFully()))
        val p = PendingPlay(o.getString("k"), o.getLong("at"), o.getLong("ms"), completed = false, skipped = false)
        return p to o.optLong("dur", 0L)
    }

    private fun clearPending() {
        if (pending.baseFile.exists()) pending.delete()
    }

    companion object {
        private const val TAG = "Listens"

        /** Linear ReplayGain for [t] (attenuation is applied through the player's volume). */
        fun gainFor(t: Track, mode: String, preampDb: Double, albumContext: Boolean): Double =
            Loudness.gain(t.rgTrackGain, t.rgTrackPeak, t.rgAlbumGain, t.rgAlbumPeak, mode, albumContext, preampDb)
    }
}
