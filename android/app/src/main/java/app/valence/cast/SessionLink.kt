package app.valence.cast

import android.net.Uri
import android.util.Log
import androidx.media3.common.MediaItem
import app.valence.ValenceApp
import app.valence.art.ArtStore
import app.valence.core.CastContent
import app.valence.core.CastQueue
import app.valence.core.CastServer
import app.valence.core.TvIdleReason
import app.valence.core.TvRemote
import app.valence.core.TvState
import app.valence.core.TvStatus
import app.valence.ui.components.line2
import com.google.android.gms.cast.CastStatusCodes
import com.google.android.gms.cast.MediaError
import com.google.android.gms.cast.MediaInfo
import com.google.android.gms.cast.MediaLoadRequestData
import com.google.android.gms.cast.MediaMetadata
import com.google.android.gms.cast.MediaSeekOptions
import com.google.android.gms.cast.MediaStatus
import com.google.android.gms.cast.framework.media.RemoteMediaClient
import com.google.android.gms.common.images.WebImage
import org.json.JSONObject

/** A connected TV: orders go to it, and what it reports goes to the queue. */
interface TvLink : TvRemote<MediaItem> {
    fun connect(queue: CastQueue<MediaItem>)
    fun disconnect()
    /** The song's ReplayGain, 0 to 1. */
    fun setGain(gain: Float) {}
    /** The connection dropped, and may come back. */
    fun connectionLost() {}
}

/** What the TV is told about a song. */
class TvSong(
    val trackId: Long,
    val url: String,
    val mime: String,
    val title: String,
    val artist: String,
    val album: String,
    val artUrl: String?,
    val durationMs: Long,
    val gain: Float,
)

/** Turns queue items into [TvSong]s, with URLs on the phone's [CastServer]. Main thread. */
class TvSongs(private val app: ValenceApp, private val server: CastServer) {
    fun of(item: MediaItem): TvSong? {
        val id = item.mediaId.toLongOrNull() ?: return null
        val t = app.playback.trackFor(id) ?: return null
        val file = app.library.fileOf(t)
        return TvSong(
            trackId = t.id,
            url = server.audioUrl(t.id, file.extension.lowercase()),
            mime = CastServer.audioMime(file.name),
            title = t.title,
            artist = t.line2(),
            album = t.album,
            artUrl = if (t.hasArt) server.artUrl(t.id) else null,
            durationMs = t.durationMs,
            gain = app.playback.gainFor(t.id),
        )
    }

    companion object {
        private const val ART_KEPT = 4
        private val artCache = object : LinkedHashMap<Long, ByteArray>(ART_KEPT, 0.75f, true) {
            override fun removeEldestEntry(eldest: MutableMap.MutableEntry<Long, ByteArray>?) = size > ART_KEPT
        }

        /** For the server, on its own threads. A TV may ask for a cover more than once: it's kept a while. */
        fun art(id: Long): CastContent? {
            val cached = synchronized(artCache) { artCache[id] }
            val bytes = cached ?: ArtStore.tvJpeg(id)?.also { synchronized(artCache) { artCache[id] = it } } ?: return null
            return CastContent.OfBytes(bytes, "image/jpeg")
        }

        fun audio(app: ValenceApp, id: Long): CastContent? {
            val t = app.library.track(id) ?: return null
            val file = app.library.fileOf(t)
            return CastContent.OfFile(file, CastServer.audioMime(file.name))
        }
    }
}

/** A Google Cast session as a [TvLink]. */
class SessionLink(private var client: RemoteMediaClient, private val songs: TvSongs) : RemoteMediaClient.Callback(), TvLink {
    private var queue: CastQueue<MediaItem>? = null
    private var gain = 1f
    /** The load whose ReplayGain is still to go: the TV can't take it until it has started the song. */
    private var gainFor = NO_LOAD
    private var lost = false

    override fun connect(queue: CastQueue<MediaItem>) {
        this.queue = queue
        client.registerCallback(this)
    }

    override fun disconnect() {
        queue = null
        runCatching { client.unregisterCallback(this) }
    }

    override fun connectionLost() {
        lost = true
    }

    /**
     * The connection came back. The session makes a new client each time and the old one never hears
     * from the TV again, so this moves to [newClient] and asks where things stand.
     */
    fun reconnected(newClient: RemoteMediaClient) {
        lost = false
        if (newClient !== client) {
            runCatching { client.unregisterCallback(this) }
            client = newClient
            if (queue != null) client.registerCallback(this)
        }
        queue?.reconnected()
        runCatching {
            newClient.requestStatus().setResultCallback { result ->
                // A song's end is only reported once, and an empty report says nothing about why.
                // It's only believed here, because the TV can send one in the middle of a load.
                if (result.status.isSuccess && client === newClient && newClient.mediaStatus == null) queue?.tvEmpty()
            }
        }
    }

    override fun load(loadId: Long, item: MediaItem, startMs: Long, autoplay: Boolean, speed: Float) {
        if (lost) return // reconnecting sends it again
        val song = songs.of(item)
        if (song == null) {
            Log.w(TAG, "No such song: ${item.mediaId}")
            queue?.onLoadResult(loadId, ok = false)
            return
        }
        gain = song.gain
        gainFor = loadId
        val metadata = MediaMetadata(MediaMetadata.MEDIA_TYPE_MUSIC_TRACK).apply {
            putString(MediaMetadata.KEY_TITLE, song.title)
            putString(MediaMetadata.KEY_ARTIST, song.artist)
            if (song.album.isNotEmpty()) putString(MediaMetadata.KEY_ALBUM_TITLE, song.album)
            song.artUrl?.let { addImage(WebImage(Uri.parse(it))) }
        }
        val info = MediaInfo.Builder(song.url)
            .setStreamType(MediaInfo.STREAM_TYPE_BUFFERED)
            .setContentType(song.mime)
            .setMetadata(metadata)
            .apply { if (song.durationMs > 0) setStreamDuration(song.durationMs) }
            // Comes back in the TV's reports, which is how a report is matched to its load.
            .setCustomData(JSONObject().put("loadId", loadId).put("trackId", song.trackId).put("gain", song.gain.toDouble()))
            .build()
        val request = MediaLoadRequestData.Builder()
            .setMediaInfo(info)
            .setAutoplay(autoplay)
            .setCurrentTime(startMs)
            .setPlaybackRate(speed.toDouble())
            .build()
        try {
            client.load(request).setResultCallback { result ->
                val code = result.status.statusCode
                if (result.status.isSuccess) pushGain() else Log.w(TAG, "Load failed: ${CastStatusCodes.getStatusCodeString(code)}")
                queue?.onLoadResult(
                    loadId,
                    result.status.isSuccess,
                    canceled = code == CastStatusCodes.CANCELED || code == CastStatusCodes.REPLACED || code == LOAD_CANCELLED,
                    code = code,
                )
            }
        } catch (e: RuntimeException) {
            Log.w(TAG, "Couldn't send the load", e)
            queue?.onLoadResult(loadId, ok = false)
        }
    }

    override fun play(done: (Boolean) -> Unit) = order(done) { client.play() }

    override fun pause(done: (Boolean) -> Unit) = order(done) { client.pause() }

    override fun seek(positionMs: Long, done: (Boolean) -> Unit) = order(done) {
        client.seek(MediaSeekOptions.Builder().setPosition(positionMs).build())
    }

    private inline fun order(noinline done: (Boolean) -> Unit, send: () -> com.google.android.gms.common.api.PendingResult<RemoteMediaClient.MediaChannelResult>) {
        if (lost) return done(false)
        try {
            send().setResultCallback { done(it.status.isSuccess) }
        } catch (e: RuntimeException) {
            Log.w(TAG, "Couldn't reach the TV", e)
            done(false)
        }
    }

    override fun setSpeed(speed: Float) {
        runCatching { client.setPlaybackRate(speed.toDouble()) }
    }

    override fun stop() {
        runCatching { client.stop() }
    }

    override fun setGain(gain: Float) {
        if (gain == this.gain) return
        this.gain = gain
        pushGain()
    }

    /** ReplayGain is the song's own volume on the TV, separate from the TV's volume. */
    private fun pushGain() {
        runCatching { if (client.hasMediaSession()) client.setStreamVolume(gain.toDouble().coerceIn(0.0, 1.0)) }
    }

    override fun onStatusUpdated() {
        val q = queue ?: return
        val status = client.mediaStatus ?: return // see reconnected
        val state = when (status.playerState) {
            MediaStatus.PLAYER_STATE_PLAYING -> TvState.Playing
            MediaStatus.PLAYER_STATE_PAUSED -> TvState.Paused
            MediaStatus.PLAYER_STATE_BUFFERING -> TvState.Buffering
            MediaStatus.PLAYER_STATE_LOADING -> TvState.Loading
            MediaStatus.PLAYER_STATE_IDLE -> TvState.Idle
            else -> return
        }
        val reason = when (status.idleReason) {
            MediaStatus.IDLE_REASON_FINISHED -> TvIdleReason.Finished
            MediaStatus.IDLE_REASON_CANCELED -> TvIdleReason.Canceled
            MediaStatus.IDLE_REASON_INTERRUPTED -> TvIdleReason.Interrupted
            MediaStatus.IDLE_REASON_ERROR -> TvIdleReason.Error
            else -> TvIdleReason.None
        }
        val data = status.mediaInfo?.customData
        val reportedLoad = if (data != null && data.has("loadId")) data.optLong("loadId") else null
        if (reportedLoad == gainFor && state != TvState.Idle) {
            gainFor = NO_LOAD
            pushGain()
        }
        q.onStatus(
            TvStatus(
                state = state,
                idleReason = reason,
                positionMs = client.approximateStreamPosition,
                durationMs = client.streamDuration.takeIf { it > 0 } ?: -1,
                loadId = reportedLoad,
            ),
        )
    }

    override fun onMediaError(error: MediaError) {
        Log.w(TAG, "TV media error: ${error.reason} ${error.detailedErrorCode}")
    }

    companion object {
        private const val TAG = "ValenceCast"
        private const val NO_LOAD = -1L
        /** How the library reports the TV dropping a load for another one. It has no public name. */
        private const val LOAD_CANCELLED = 2101
    }
}
