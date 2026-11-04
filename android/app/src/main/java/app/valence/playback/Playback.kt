package app.valence.playback

import android.content.ComponentName
import android.media.AudioDeviceCallback
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.media.audiofx.BassBoost
import android.media.audiofx.Equalizer
import android.net.Uri
import android.util.Log
import android.widget.Toast
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.PlaybackException
import androidx.media3.common.PlaybackParameters
import androidx.media3.common.Player
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.session.MediaController
import androidx.media3.session.SessionToken
import app.valence.ValenceApp
import app.valence.art.ArtStore
import app.valence.data.Track
import com.google.common.util.concurrent.ListenableFuture
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONArray
import java.io.File
import kotlin.math.max
import kotlin.math.min

/**
 * What a list tap does with the list (Musicolet's "on song click" setting). Named is Musicolet's
 * default: the list becomes a queue named after where it came from, replacing a queue of that name.
 */
enum class TapMode { Named, Replace, NewQueue, PlayNext, AddToQueue }

data class QueueSummary(val id: Long, val name: String, val count: Int, val index: Int, val currentTrackId: Long?, val active: Boolean)

/**
 * The one player in the app. The UI calls it directly (same process); [PlaybackService] wraps the
 * same ExoPlayer in a media session for the notification, lock screen, headset buttons and Auto.
 */
class Playback(private val app: ValenceApp) {
    private val prefs = app.prefs
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val store = QueueStore(app.filesDir)

    val player: ExoPlayer = ExoPlayer.Builder(app)
        .setAudioAttributes(AudioAttributes.Builder().setUsage(C.USAGE_MEDIA).setContentType(C.AUDIO_CONTENT_TYPE_MUSIC).build(), true)
        .setHandleAudioBecomingNoisy(prefs.pauseOnDisconnect.value)
        .setWakeMode(C.WAKE_MODE_LOCAL)
        .setSeekBackIncrementMs(10_000)
        .setSeekForwardIncrementMs(10_000)
        .build()

    // ---- Observable state ----------------------------------------------------------------------

    private val _current = MutableStateFlow<Track?>(null)
    val current: StateFlow<Track?> = _current.asStateFlow()
    private val _isPlaying = MutableStateFlow(false)
    val isPlaying: StateFlow<Boolean> = _isPlaying.asStateFlow()
    private val _queue = MutableStateFlow<List<Track>>(emptyList())
    val queue: StateFlow<List<Track>> = _queue.asStateFlow()
    private val _index = MutableStateFlow(-1)
    val index: StateFlow<Int> = _index.asStateFlow()
    private val _repeat = MutableStateFlow(Player.REPEAT_MODE_OFF)
    val repeat: StateFlow<Int> = _repeat.asStateFlow()
    private val _speed = MutableStateFlow(1f)
    val speed: StateFlow<Float> = _speed.asStateFlow()
    private val _queues = MutableStateFlow<List<QueueSummary>>(emptyList())
    val queues: StateFlow<List<QueueSummary>> = _queues.asStateFlow()
    private val _sleepAt = MutableStateFlow<Long?>(null)
    /** Wall-clock time the sleep timer stops playback, or null. */
    val sleepAt: StateFlow<Long?> = _sleepAt.asStateFlow()
    private val _sleepSongs = MutableStateFlow(0)
    /** Songs left before the sleep timer pauses (0 = not counting songs). */
    val sleepSongs: StateFlow<Int> = _sleepSongs.asStateFlow()
    private val _stopAfterId = MutableStateFlow<Long?>(null)
    /** Pause when this song finishes ("Stop after this song" in a song's menu). */
    val stopAfterId: StateFlow<Long?> = _stopAfterId.asStateFlow()
    private var previousId: Long? = null
    private val _error = MutableStateFlow<String?>(null)
    val error: StateFlow<String?> = _error.asStateFlow()

    val positionMs get() = player.currentPosition
    val durationMs get() = player.duration.takeIf { it != C.TIME_UNSET } ?: (_current.value?.durationMs ?: 0L)

    // ---- Queues --------------------------------------------------------------------------------

    /** Inactive queues (the active one lives in the player). */
    private val saved = mutableListOf<SavedQueue>()
    private var activeId = -1L
    private var activeName = ""
    private val known = HashMap<Long, Track>()
    private var restored = false

    private val listens = Listens(app)

    init {
        player.addListener(object : Player.Listener {
            override fun onIsPlayingChanged(isPlaying: Boolean) {
                _isPlaying.value = isPlaying
                listens.onPlaying(isPlaying, player.currentPosition)
                if (!isPlaying) persist()
            }

            override fun onMediaItemTransition(mediaItem: MediaItem?, reason: Int) {
                val endReason = when (reason) {
                    Player.MEDIA_ITEM_TRANSITION_REASON_AUTO, Player.MEDIA_ITEM_TRANSITION_REASON_REPEAT -> Listens.End.Completed
                    Player.MEDIA_ITEM_TRANSITION_REASON_SEEK -> Listens.End.Skipped
                    else -> Listens.End.Stopped
                }
                // A new queue reports its timeline before this, and refreshCurrent may already be counting
                // the new song; only end a listen that belongs to another song (or to this one, repeating).
                val newId = mediaItem?.mediaId?.toLongOrNull()
                if (reason == Player.MEDIA_ITEM_TRANSITION_REASON_REPEAT || listens.activeTrackId != newId) listens.end(endReason)
                val finished = previousId
                refreshCurrent()
                previousId = _current.value?.id
                if (reason == Player.MEDIA_ITEM_TRANSITION_REASON_AUTO) {
                    var stop = false
                    if (_sleepSongs.value > 0) {
                        _sleepSongs.value -= 1
                        stop = _sleepSongs.value == 0
                    }
                    if (finished != null && _stopAfterId.value == finished) {
                        _stopAfterId.value = null
                        stop = true
                    }
                    if (stop) player.pause()
                }
                persist()
            }

            override fun onTimelineChanged(timeline: androidx.media3.common.Timeline, reason: Int) {
                if (reason == Player.TIMELINE_CHANGE_REASON_PLAYLIST_CHANGED) refreshQueue()
            }

            override fun onPlaybackStateChanged(state: Int) {
                if (state == Player.STATE_ENDED) {
                    listens.end(Listens.End.Completed)
                    persist()
                }
            }

            override fun onRepeatModeChanged(repeatMode: Int) {
                _repeat.value = repeatMode
            }

            override fun onShuffleModeEnabledChanged(shuffleModeEnabled: Boolean) {
                // Shuffle reorders the queue itself (as Musicolet does), so the queue always shows play order.
                if (shuffleModeEnabled) {
                    player.shuffleModeEnabled = false
                    shuffleQueue()
                }
            }

            override fun onPlaybackParametersChanged(playbackParameters: PlaybackParameters) {
                _speed.value = playbackParameters.speed
            }

            override fun onPositionDiscontinuity(oldPosition: Player.PositionInfo, newPosition: Player.PositionInfo, reason: Int) {
                if (reason == Player.DISCONTINUITY_REASON_SEEK && oldPosition.mediaItemIndex == newPosition.mediaItemIndex) {
                    // Replaying a finished song (seek back after the queue ended) starts a new listen.
                    val t = _current.value
                    if (t != null && listens.activeTrackId == null) listens.begin(t, newPosition.positionMs)
                    else listens.onSeek(newPosition.positionMs)
                }
            }

            override fun onPlayerError(error: PlaybackException) {
                val t = _current.value
                Log.w(TAG, "Playback error on ${t?.relPath}: ${error.errorCodeName}", error)
                _error.value = "Can't play ${t?.title ?: "this song"} (${error.errorCodeName.removePrefix("ERROR_CODE_").lowercase().replace('_', ' ')})"
                // Skip what can't be played (unsupported codec, missing file) instead of stopping the queue.
                if (player.hasNextMediaItem()) {
                    player.seekToNextMediaItem()
                    player.prepare()
                    player.play()
                }
            }

            override fun onAudioSessionIdChanged(audioSessionId: Int) {
                attachEffects(audioSessionId)
            }
        })
        player.skipSilenceEnabled = prefs.skipSilence.value
        scope.launch { prefs.pauseOnDisconnect.flow.collect { player.setHandleAudioBecomingNoisy(it) } }
        scope.launch { prefs.skipSilence.flow.collect { player.skipSilenceEnabled = it } }
        scope.launch { prefs.replayGain.flow.collect { applyGain() } }
        scope.launch { prefs.preampDb.flow.collect { applyGain() } }
        scope.launch { ticker() }
        attachEffects(player.audioSessionId) // the first id is generated up front, without a callback
        registerReconnect()
    }

    private suspend fun ticker() {
        var n = 0
        while (scope.isActive) {
            // Fine-grained so listened time is counted the desktop way (deltas over 1.5 s are ignored), even at 3x speed.
            delay(250)
            if (player.isPlaying) {
                listens.tick(player.currentPosition)
                if (++n % 60 == 0) persist()
            }
            _sleepAt.value?.let { if (System.currentTimeMillis() >= it) sleepNow() }
        }
    }

    /** Loads the saved queues into the player (paused) once the library index is available. */
    fun restore() {
        if (restored) return
        restored = true
        scope.launch {
            listens.restorePending()
            val snap = withContext(Dispatchers.IO) { store.load() }
            saved.clear()
            saved.addAll(snap.queues)
            val active = saved.firstOrNull { it.id == snap.activeId } ?: saved.maxByOrNull { it.updatedAt }
            if (active == null) {
                publishQueues()
                return@launch
            }
            saved.remove(active)
            loadQueue(active, play = false)
        }
    }

    private suspend fun resolve(paths: List<String>): List<Track> = withContext(Dispatchers.IO) {
        val byPath = app.library.tracksByPaths(paths)
        paths.mapNotNull { byPath[it] }
    }

    private suspend fun loadQueue(q: SavedQueue, play: Boolean) {
        val tracks = resolve(q.paths)
        val wanted = q.paths.getOrNull(q.index)
        val index = tracks.indexOfFirst { it.relPath == wanted }.takeIf { it >= 0 } ?: min(q.index, max(tracks.size - 1, 0))
        activeId = q.id
        activeName = q.name
        setItems(tracks, index, if (tracks.getOrNull(index)?.relPath == wanted) q.positionMs else 0L)
        if (play) player.play()
        publishQueues()
    }

    private fun setItems(tracks: List<Track>, index: Int, positionMs: Long) {
        tracks.forEach { known[it.id] = it }
        player.setMediaItems(tracks.map { it.toMediaItem() }, index.coerceIn(0, max(tracks.size - 1, 0)), positionMs)
        player.prepare()
    }

    fun Track.toMediaItem(): MediaItem = mediaItemFor(this, app.library.fileOf(this))

    private fun refreshQueue() {
        val ids = (0 until player.mediaItemCount).mapNotNull { player.getMediaItemAt(it).mediaId.toLongOrNull() }
        val missing = ids.filter { it !in known }
        if (missing.isEmpty()) {
            _queue.value = ids.mapNotNull { known[it] }
            refreshCurrent()
            publishQueues()
        } else {
            scope.launch {
                withContext(Dispatchers.IO) { app.library.tracksByIds(missing) }.forEach { known[it.id] = it }
                _queue.value = ids.mapNotNull { known[it] }
                refreshCurrent()
                publishQueues()
            }
        }
    }

    private fun refreshCurrent() {
        val id = player.currentMediaItem?.mediaId?.toLongOrNull()
        val t = id?.let { known[it] }
        _index.value = player.currentMediaItemIndex
        if (t?.id != _current.value?.id) _current.value = t
        if (t != null) listens.ensure(t, player.currentPosition)
        applyGain()
    }

    /** Re-reads the queue's tracks after a rescan (titles, art, likes may have changed). */
    fun refreshTracks() {
        scope.launch {
            val ids = (0 until player.mediaItemCount).mapNotNull { player.getMediaItemAt(it).mediaId.toLongOrNull() }
            val fresh = withContext(Dispatchers.IO) { app.library.tracksByIds(ids) }
            fresh.forEach { known[it.id] = it }
            _queue.value = ids.mapNotNull { known[it] }
            _current.value = _current.value?.let { known[it.id] }
        }
    }

    private fun summary(): List<QueueSummary> {
        val active = if (activeId >= 0) listOf(
            QueueSummary(activeId, activeName, player.mediaItemCount, player.currentMediaItemIndex, _current.value?.id, true),
        ) else emptyList()
        val others = saved.map { q ->
            QueueSummary(q.id, q.name, q.paths.size, q.index, null, false)
        }
        return (active + others).sortedBy { it.id }
    }

    private fun publishQueues() {
        _queues.value = summary()
    }

    private fun activeSnapshot(): SavedQueue? = if (activeId < 0) null else SavedQueue(
        id = activeId,
        name = activeName,
        paths = _queue.value.map { it.relPath },
        index = player.currentMediaItemIndex,
        positionMs = player.currentPosition,
    )

    private var saveJob: Job? = null
    fun persist() {
        if (!restored) return
        val snap = QueueStore.Snapshot(listOfNotNull(activeSnapshot()) + saved, activeId)
        saveJob?.cancel()
        saveJob = scope.launch(Dispatchers.IO) { store.save(snap) }
        listens.persistPending()
    }

    private fun newQueueId() = max((saved.maxOfOrNull { it.id } ?: 0), activeId) + 1

    private fun enforceLimit() {
        val limit = prefs.maxQueues.value.coerceAtLeast(1)
        while (saved.size + 1 > limit) saved.remove(saved.minByOrNull { it.updatedAt } ?: break)
    }

    // ---- Commands ------------------------------------------------------------------------------

    /**
     * Plays [tracks] starting at [start]. [label] names the queue ("Album name", "Liked songs").
     * [mode] defaults to the user's tap setting.
     */
    fun play(tracks: List<Track>, start: Int = 0, label: String = "", mode: TapMode = tapMode(), shuffle: Boolean = false) {
        if (tracks.isEmpty()) return
        ensureService()
        var list = tracks
        var startAt = start.coerceIn(0, tracks.size - 1)
        if (shuffle) {
            list = tracks.shuffled()
            startAt = 0
        }
        val empty = player.mediaItemCount == 0 || activeId < 0
        when (if (empty && mode != TapMode.Named) TapMode.Replace else mode) {
            TapMode.Replace -> {
                if (activeId < 0) activeId = newQueueId()
                activeName = label
                listens.end(Listens.End.Skipped) // like the desktop's setQueue: skipped if playing, else stopped
                setItems(list, startAt, 0)
                player.play()
            }
            TapMode.Named, TapMode.NewQueue -> {
                listens.end(Listens.End.Skipped)
                if (!empty && !(mode == TapMode.Named && activeName == label)) {
                    activeSnapshot()?.let { saved.add(it.copy(updatedAt = System.currentTimeMillis())) }
                    activeId = -1
                }
                if (mode == TapMode.Named && label.isNotEmpty()) saved.removeAll { it.name == label }
                enforceLimit()
                if (activeId < 0) activeId = newQueueId()
                activeName = label
                setItems(list, startAt, 0)
                player.play()
            }
            TapMode.PlayNext -> playNext(listOf(list[startAt]))
            TapMode.AddToQueue -> addToQueue(listOf(list[startAt]))
        }
        publishQueues()
        persist()
    }

    fun tapMode(): TapMode = when (prefs.tapBehavior.value) {
        "replace" -> TapMode.Replace
        "next" -> TapMode.PlayNext
        "add" -> TapMode.AddToQueue
        else -> TapMode.Named
    }

    fun playNext(tracks: List<Track>) {
        if (tracks.isEmpty()) return
        if (player.mediaItemCount == 0) return play(tracks, 0, mode = TapMode.Named)
        tracks.forEach { known[it.id] = it }
        player.addMediaItems(player.currentMediaItemIndex + 1, tracks.map { it.toMediaItem() })
        toast(if (tracks.size == 1) "Playing next" else "${tracks.size} songs playing next")
    }

    fun addToQueue(tracks: List<Track>) {
        if (tracks.isEmpty()) return
        if (player.mediaItemCount == 0) return play(tracks, 0, mode = TapMode.Named)
        tracks.forEach { known[it.id] = it }
        player.addMediaItems(tracks.map { it.toMediaItem() })
        toast(if (tracks.size == 1) "Added to queue" else "${tracks.size} songs added to queue")
    }

    fun toggle() {
        ensureService()
        if (player.playbackState == Player.STATE_ENDED) player.seekTo(0, 0)
        if (player.playbackState == Player.STATE_IDLE) player.prepare()
        if (player.isPlaying) fadeThen(0f) { player.pause() } else { player.play(); fadeIn() }
    }

    fun next() = player.seekToNextMediaItem()

    /** Back to the start if more than 3 s in, else the previous song (like every player). */
    fun previous() = player.seekToPrevious()

    fun seekTo(ms: Long) = player.seekTo(ms)

    fun playAt(index: Int) {
        if (index !in 0 until player.mediaItemCount) return
        ensureService()
        player.seekTo(index, 0)
        player.play()
    }

    fun move(from: Int, to: Int) {
        if (from == to || from !in 0 until player.mediaItemCount || to !in 0 until player.mediaItemCount) return
        player.moveMediaItem(from, to)
    }

    fun removeAt(index: Int) {
        if (index in 0 until player.mediaItemCount) player.removeMediaItem(index)
    }

    /** Musicolet's shuffle: the current song stays, everything after it is reordered at random. */
    fun shuffleQueue() {
        val n = player.mediaItemCount
        if (n < 2) return
        val cur = player.currentMediaItemIndex
        val rest = (0 until n).filter { it != cur }.shuffled()
        val items = listOf(cur).plus(rest).map { player.getMediaItemAt(it) }
        val pos = player.currentPosition
        val wasPlaying = player.playWhenReady
        // Keep the current item playing without a glitch: move it to the top, replace the rest.
        player.moveMediaItem(cur, 0)
        player.replaceMediaItems(1, n, items.drop(1))
        if (player.currentMediaItemIndex != 0) player.seekTo(0, pos)
        player.playWhenReady = wasPlaying
        toast("Queue shuffled")
    }

    fun clearUpcoming() {
        val cur = player.currentMediaItemIndex
        if (cur + 1 < player.mediaItemCount) player.removeMediaItems(cur + 1, player.mediaItemCount)
    }

    fun cycleRepeat() {
        player.repeatMode = when (player.repeatMode) {
            Player.REPEAT_MODE_OFF -> Player.REPEAT_MODE_ALL
            Player.REPEAT_MODE_ALL -> Player.REPEAT_MODE_ONE
            else -> Player.REPEAT_MODE_OFF
        }
    }

    fun setSpeed(speed: Float, pitch: Float = 1f) {
        player.playbackParameters = PlaybackParameters(speed.coerceIn(0.25f, 3f), pitch.coerceIn(0.5f, 2f))
    }

    /**
     * Makes saved queue [id] the playing one, where it left off, or from song [at] (and playing)
     * when given (a tap on a song in a queue that isn't playing).
     */
    fun switchQueue(id: Long, at: Int? = null) {
        if (id == activeId) { if (at != null) playAt(at); return }
        val target = saved.firstOrNull { it.id == id } ?: return
        listens.end(Listens.End.Skipped)
        val wasPlaying = player.playWhenReady
        activeSnapshot()?.let { saved.add(it.copy(updatedAt = System.currentTimeMillis())) }
        saved.remove(target)
        ensureService()
        scope.launch {
            loadQueue(if (at != null) target.copy(index = at, positionMs = 0) else target, play = wasPlaying || at != null)
            persist()
        }
    }

    /** Reorders the queue: [order] lists the old positions in their new order. The playing song keeps playing. */
    fun reorderQueue(order: List<Int>) {
        val n = player.mediaItemCount
        if (n < 2 || order.size != n || order.toSet().size != n) return
        val cur = player.currentMediaItemIndex
        val items = order.map { player.getMediaItemAt(it) }
        val newCur = order.indexOf(cur)
        player.moveMediaItem(cur, newCur)
        if (newCur > 0) player.replaceMediaItems(0, newCur, items.subList(0, newCur))
        if (newCur + 1 < n) player.replaceMediaItems(newCur + 1, n, items.subList(newCur + 1, n))
    }

    fun deleteQueue(id: Long) {
        if (id == activeId) {
            listens.end(Listens.End.Stopped)
            val next = saved.maxByOrNull { it.updatedAt }
            if (next == null) {
                player.clearMediaItems()
                activeId = -1
                activeName = ""
                _current.value = null
                publishQueues()
                persist()
            } else {
                saved.remove(next)
                scope.launch { loadQueue(next, play = false); persist() }
            }
        } else {
            saved.removeAll { it.id == id }
            publishQueues()
            persist()
        }
    }

    fun renameQueue(id: Long, name: String) {
        if (id == activeId) activeName = name else saved.replaceAll { if (it.id == id) it.copy(name = name) else it }
        publishQueues()
        persist()
    }

    fun queueTracks(id: Long, onResult: (List<Track>) -> Unit) {
        if (id == activeId) return onResult(_queue.value)
        val q = saved.firstOrNull { it.id == id } ?: return onResult(emptyList())
        scope.launch { onResult(resolve(q.paths)) }
    }

    fun clearError() { _error.value = null }

    // ---- Sleep timer ---------------------------------------------------------------------------

    fun sleepIn(minutes: Int, finishSong: Boolean = false) {
        _sleepAt.value = System.currentTimeMillis() + minutes * 60_000L
        _sleepSongs.value = 0
        finishSongAfterTimer = finishSong
    }

    /** Pause after [n] more songs finish (1 = at the end of this song). */
    fun sleepAfterSongs(n: Int) {
        _sleepAt.value = null
        _sleepSongs.value = n.coerceAtLeast(1)
    }

    fun sleepAfterCurrent() = sleepAfterSongs(1)

    fun stopAfter(trackId: Long?) {
        _stopAfterId.value = trackId
        if (trackId != null) toast("Stops after this song")
    }

    fun cancelSleep() {
        _sleepAt.value = null
        _sleepSongs.value = 0
        finishSongAfterTimer = false
    }

    private var finishSongAfterTimer = false
    private fun sleepNow() {
        _sleepAt.value = null
        if (finishSongAfterTimer) {
            finishSongAfterTimer = false
            _sleepSongs.value = 1
            return
        }
        if (player.isPlaying) fadeThen(0f, 3000) { player.pause() }
    }

    // ---- Volume: ReplayGain x fade -------------------------------------------------------------

    private var rgVolume = 1f
    private var fadeVolume = 1f
    private var fadeJob: Job? = null

    private fun applyVolume() {
        player.volume = (rgVolume * fadeVolume).coerceIn(0f, 1f)
    }

    private fun applyGain() {
        val t = _current.value
        rgVolume = if (t == null) 1f else {
            val nextIndex = player.nextMediaItemIndex
            val prevIndex = player.previousMediaItemIndex
            val neighbours = listOf(nextIndex, prevIndex).filter { it != C.INDEX_UNSET }.mapNotNull { player.getMediaItemAt(it).mediaId.toLongOrNull()?.let(known::get) }
            val albumContext = t.albumId != null && neighbours.any { it.albumId == t.albumId }
            Listens.gainFor(t, prefs.replayGain.value, prefs.preampDb.value.toDouble(), albumContext).toFloat()
        }
        applyVolume()
    }

    private fun fadeIn() {
        val ms = prefs.fadeMs.value
        if (ms <= 0) { fadeVolume = 1f; applyVolume(); return }
        fadeJob?.cancel()
        fadeVolume = 0f
        applyVolume()
        fadeJob = scope.launch { animateFade(1f, ms) }
    }

    private fun fadeThen(target: Float, ms: Int = prefs.fadeMs.value, then: () -> Unit) {
        fadeJob?.cancel()
        if (ms <= 0) { then(); fadeVolume = 1f; applyVolume(); return }
        fadeJob = scope.launch {
            animateFade(target, ms)
            then()
            fadeVolume = 1f
            applyVolume()
        }
    }

    private suspend fun animateFade(target: Float, ms: Int) {
        val start = fadeVolume
        val steps = max(1, ms / 16)
        for (i in 1..steps) {
            fadeVolume = start + (target - start) * i / steps
            applyVolume()
            delay((ms / steps).toLong())
        }
    }

    // ---- Equalizer -----------------------------------------------------------------------------

    var equalizer: Equalizer? = null
        private set
    var bassBoost: BassBoost? = null
        private set
    private val _effectsVersion = MutableStateFlow(0)
    val effectsVersion: StateFlow<Int> = _effectsVersion.asStateFlow()

    private fun attachEffects(sessionId: Int) {
        runCatching { equalizer?.release() }
        runCatching { bassBoost?.release() }
        equalizer = null
        bassBoost = null
        if (sessionId == C.AUDIO_SESSION_ID_UNSET) return
        equalizer = runCatching { Equalizer(0, sessionId) }.onFailure { Log.w(TAG, "No equalizer: ${it.message}") }.getOrNull()
        bassBoost = runCatching { BassBoost(0, sessionId) }.getOrNull()
        applyEffects()
    }

    fun applyEffects() {
        val eq = equalizer
        val p = app.prefs
        if (eq != null) runCatching {
            eq.enabled = p.eqEnabled.value
            val preset = p.eqPreset.value
            if (preset >= 0 && preset < eq.numberOfPresets) eq.usePreset(preset.toShort())
            else {
                val levels = runCatching { JSONArray(p.eqBands.value) }.getOrNull()
                // Every band: one with nothing saved is flat, not the effect's own default (often +3 dB at the ends).
                for (b in 0 until eq.numberOfBands.toInt()) eq.setBandLevel(b.toShort(), (levels?.optInt(b, 0) ?: 0).toShort())
            }
        }
        bassBoost?.let { bb -> runCatching { bb.enabled = p.eqEnabled.value && p.bassBoost.value > 0; if (bb.strengthSupported) bb.setStrength(p.bassBoost.value.toShort()) } }
        _effectsVersion.value++
    }

    // ---- Service, reconnect, misc --------------------------------------------------------------

    private var controller: ListenableFuture<MediaController>? = null

    /** Binds the playback service so it runs (and shows the notification) while music plays. */
    fun ensureService() {
        if (controller != null) return
        controller = MediaController.Builder(app, SessionToken(app, ComponentName(app, PlaybackService::class.java))).buildAsync()
    }

    private var pausedByDisconnect = false

    private fun registerReconnect() {
        val am = app.getSystemService(AudioManager::class.java) ?: return
        player.addListener(object : Player.Listener {
            override fun onPlayWhenReadyChanged(playWhenReady: Boolean, reason: Int) {
                pausedByDisconnect = !playWhenReady && reason == Player.PLAY_WHEN_READY_CHANGE_REASON_AUDIO_BECOMING_NOISY
            }
        })
        am.registerAudioDeviceCallback(object : AudioDeviceCallback() {
            override fun onAudioDevicesAdded(addedDevices: Array<out AudioDeviceInfo>) {
                val headset = addedDevices.any {
                    it.isSink && it.type in setOf(
                        AudioDeviceInfo.TYPE_WIRED_HEADPHONES, AudioDeviceInfo.TYPE_WIRED_HEADSET, AudioDeviceInfo.TYPE_BLUETOOTH_A2DP,
                        AudioDeviceInfo.TYPE_USB_HEADSET, AudioDeviceInfo.TYPE_BLE_HEADSET,
                    )
                }
                if (headset && pausedByDisconnect && prefs.resumeOnConnect.value && player.mediaItemCount > 0) {
                    pausedByDisconnect = false
                    player.play()
                }
            }
        }, null)
    }

    private fun toast(msg: String) {
        Toast.makeText(app, msg, Toast.LENGTH_SHORT).show()
    }

    companion object {
        private const val TAG = "ValencePlayback"

        fun mediaItemFor(t: Track, file: File): MediaItem = MediaItem.Builder()
            .setMediaId(t.id.toString())
            .setUri(Uri.fromFile(file))
            .setMediaMetadata(
                MediaMetadata.Builder()
                    .setTitle(t.title)
                    .setArtist(t.artist)
                    .setAlbumTitle(t.album.ifEmpty { null })
                    .setAlbumArtist(t.albumArtist)
                    .setTrackNumber(t.trackNo)
                    .setDiscNumber(t.discNo)
                    .setReleaseYear(t.year)
                    .setGenre(t.genre)
                    .setComposer(t.composer)
                    .setDurationMs(t.durationMs.takeIf { it > 0 })
                    .setArtworkUri(if (t.hasArt) ArtStore.uri(t.id) else null)
                    .setIsBrowsable(false)
                    .setIsPlayable(true)
                    .setMediaType(MediaMetadata.MEDIA_TYPE_MUSIC)
                    .build(),
            )
            .build()
    }
}
