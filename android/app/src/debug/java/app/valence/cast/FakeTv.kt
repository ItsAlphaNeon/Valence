package app.valence.cast

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import androidx.media3.common.MediaItem
import androidx.media3.common.Player
import app.valence.ValenceApp
import app.valence.core.CastQueue
import app.valence.core.TvIdleReason
import app.valence.core.TvState
import app.valence.core.TvStatus
import java.net.HttpURLConnection
import java.net.URL
import kotlin.concurrent.thread

private const val TAG = "FakeTv"

/**
 * A pretend TV, for trying casting without one: it really fetches each song and cover from the
 * phone's server, over the network, and reports back as a TV would, with songs cut short so the
 * queue moves along quickly. Debug builds only. Drive it with adb:
 *
 *     adb shell am broadcast -n app.valence/.cast.FakeTvReceiver --es cmd start [--el songMs 8000]
 *
 * Commands: start, stop, tvpause, tvplay, tvstop, failnext, dump
 */
class FakeTv(private val songs: TvSongs, private val songMs: Long) : TvLink {
    private val handler = Handler(Looper.getMainLooper())
    private var queue: CastQueue<MediaItem>? = null
    private var loadId = -1L
    private var state = TvState.Idle
    private var baseMs = 0L
    private var baseAt = 0L
    private var rate = 1f
    var failNext = false
    var loads = 0
        private set
    var gain = 1f
        private set

    private val end = Runnable {
        Log.i(TAG, "song finished (load $loadId)")
        setState(TvState.Idle)
        report(TvIdleReason.Finished)
    }

    private fun positionMs(): Long = if (state == TvState.Playing) baseMs + ((SystemClock.elapsedRealtime() - baseAt) * rate).toLong() else baseMs

    private fun report(reason: TvIdleReason = TvIdleReason.None) {
        queue?.onStatus(TvStatus(state, reason, positionMs(), songMs, loadId))
    }

    private fun setState(s: TvState, atMs: Long = positionMs()) {
        baseMs = atMs
        baseAt = SystemClock.elapsedRealtime()
        state = s
        handler.removeCallbacks(end)
        if (s == TvState.Playing) handler.postDelayed(end, ((songMs - atMs).coerceAtLeast(0) / rate).toLong())
    }

    override fun connect(queue: CastQueue<MediaItem>) {
        this.queue = queue
        Log.i(TAG, "connected")
    }

    override fun disconnect() {
        queue = null
        handler.removeCallbacksAndMessages(null)
        Log.i(TAG, "disconnected")
    }

    override fun load(loadId: Long, item: MediaItem, startMs: Long, autoplay: Boolean, speed: Float) {
        handler.removeCallbacks(end)
        this.loadId = loadId
        rate = speed
        state = TvState.Loading
        loads++
        val song = songs.of(item)
        if (song == null) {
            queue?.onLoadResult(loadId, ok = false)
            return
        }
        gain = song.gain
        Log.i(TAG, "load $loadId: '${song.title}' by '${song.artist}' ${song.mime} from ${startMs}ms autoplay=$autoplay gain=${song.gain} url=${song.url}")
        val fail = failNext
        failNext = false
        thread {
            val audio = fetch(song.url, "bytes=0-65535")
            val art = song.artUrl?.let { fetch(it, null) }
            Log.i(TAG, "fetched: audio $audio, art $art")
            handler.post {
                if (this.loadId != loadId) return@post
                if (fail || audio.first !in 200..299) {
                    queue?.onLoadResult(loadId, ok = false, code = audio.first)
                } else {
                    queue?.onLoadResult(loadId, ok = true)
                    setState(if (autoplay) TvState.Playing else TvState.Paused, startMs)
                    report()
                }
            }
        }
    }

    /** The response code and how many bytes came. */
    private fun fetch(url: String, range: String?): Pair<Int, Long> = try {
        val c = URL(url).openConnection() as HttpURLConnection
        if (range != null) c.setRequestProperty("Range", range)
        val code = c.responseCode
        val n = c.inputStream.use { it.readBytes().size.toLong() }
        c.disconnect()
        code to n
    } catch (e: Exception) {
        Log.w(TAG, "fetch failed: $e")
        -1 to 0L
    }

    override fun play(done: (Boolean) -> Unit) {
        Log.i(TAG, "play")
        setState(TvState.Playing)
        done(true)
        report()
    }

    override fun pause(done: (Boolean) -> Unit) {
        Log.i(TAG, "pause")
        setState(TvState.Paused)
        done(true)
        report()
    }

    override fun seek(positionMs: Long, done: (Boolean) -> Unit) {
        Log.i(TAG, "seek $positionMs")
        setState(state, positionMs)
        done(true)
        report()
    }

    override fun setSpeed(speed: Float) {
        Log.i(TAG, "speed $speed")
        val at = positionMs()
        rate = speed
        setState(state, at)
        report()
    }

    override fun stop() {
        Log.i(TAG, "stop")
        setState(TvState.Idle)
    }

    override fun setGain(gain: Float) {
        Log.i(TAG, "gain $gain")
        this.gain = gain
    }

    /** As if the TV's own remote was used. */
    fun tvPause() {
        setState(TvState.Paused)
        report()
    }

    fun tvPlay() {
        setState(TvState.Playing)
        report()
    }

    /** As if something else on the TV took over. */
    fun tvStop() {
        setState(TvState.Idle)
        report(TvIdleReason.Canceled)
    }
}

class FakeTvReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val app = context.applicationContext as ValenceApp
        when (val cmd = intent.getStringExtra("cmd")) {
            "start" -> app.cast.begin("Fake TV", null, null) { songs ->
                FakeTv(songs, intent.getLongExtra("songMs", 8_000)).also { fake = it }
            }
            "stop" -> app.cast.stop()
            "tvpause" -> fake?.tvPause()
            "tvplay" -> fake?.tvPlay()
            "tvstop" -> fake?.tvStop()
            "failnext" -> fake?.failNext = true
            "lose" -> app.cast.tvLost()
            "back" -> app.cast.tvBack()
            "dump" -> dump(app)
            else -> Log.w(TAG, "unknown command $cmd")
        }
    }

    private fun dump(app: ValenceApp) {
        val pb = app.playback
        val p: Player = pb.player
        Log.i(
            TAG,
            "DUMP player=${p.javaClass.simpleName} state=${p.playbackState} pwr=${p.playWhenReady} isPlaying=${p.isPlaying} ui=${pb.isPlaying.value} " +
                "index=${p.currentMediaItemIndex}/${p.mediaItemCount} uiIndex=${pb.index.value} pos=${p.currentPosition} dur=${p.duration} " +
                "current='${pb.current.value?.title}' repeat=${p.repeatMode} shuffle=${p.shuffleModeEnabled} speed=${p.playbackParameters.speed} " +
                "tv=${app.cast.tvName.value} deviceInfo=${p.deviceInfo.playbackType} loads=${fake?.loads} gain=${fake?.gain} err=${pb.error.value}",
        )
    }

    private companion object {
        var fake: FakeTv? = null
    }
}
