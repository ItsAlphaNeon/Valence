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
import androidx.media3.exoplayer.source.ShuffleOrder
import androidx.media3.session.MediaController
import androidx.media3.session.SessionToken
import app.valence.ValenceApp
import app.valence.art.ArtStore
import app.valence.core.Shuffle
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
 * same player in a media session for the notification, lock screen, headset buttons and Auto.
 * While casting, [player] is the TV's (see [startRemote]) and all of this drives that instead.
 */
class Playback(private val app: ValenceApp) {
    private val prefs = app.prefs
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val store = QueueStore(app.filesDir)

    /** The phone's own player. Everything else goes through [player], which is this unless casting. */
    private val exo: ExoPlayer = ExoPlayer.Builder(app)
        .setAudioAttributes(AudioAttributes.Builder().setUsage(C.USAGE_MEDIA).setContentType(C.AUDIO_CONTENT_TYPE_MUSIC).build(), true)
        .setHandleAudioBecomingNoisy(prefs.pauseOnDisconnect.value)
        .setWakeMode(C.WAKE_MODE_LOCAL)
        .setSeekBackIncrementMs(10_000)
        .setSeekForwardIncrementMs(10_000)
        .build()

    private val _active = MutableStateFlow<Player>(exo)
    /** The player in use: the phone's, or the TV's while casting. */
    val active: StateFlow<Player> = _active.asStateFlow()
    val player: Player get() = _active.value
    private val casting: Boolean get() = _active.value !== exo

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
    private val _shuffle = MutableStateFlow(prefs.shuffle.value)
    /** Shuffle mode, the desktop's toggle: on, the queue is in a random order; off, back in its own. */
    val shuffle: StateFlow<Boolean> = _shuffle.asStateFlow()
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
    /** The playing queue's id (-1 when there's none). */
    val activeQueueId: Long get() = activeId
    private var activeName = ""
    private val known = HashMap<Long, Track>()
    private var restored = false
    /** The active queue's song ids before it was shuffled; null when it isn't shuffled. */
    private var unshuffled: List<Long>? = null

    private val listens = Listens(app)

    /** Songs in a row the TV couldn't play. */
    private var castFailures = 0

    /** Moved along with the playing: it listens to whichever player is in use. */
    private val listener = object : Player.Listener {
            override fun onIsPlayingChanged(isPlaying: Boolean) {
                publishPlaying()
                if (isPlaying) castFailures = 0
                listens.onPlaying(isPlaying, player.currentPosition)
                if (!isPlaying) persist()
            }

            override fun onPlayWhenReadyChanged(playWhenReady: Boolean, reason: Int) {
                publishPlaying()
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
                publishPlaying()
                if (state == Player.STATE_ENDED) {
                    listens.end(Listens.End.Completed)
                    persist()
                }
            }

            override fun onRepeatModeChanged(repeatMode: Int) {
                _repeat.value = repeatMode
            }

            override fun onShuffleModeEnabledChanged(shuffleModeEnabled: Boolean) {
                // Toggled from the notification, lock screen or a car: same as the Now playing button.
                if (shuffleModeEnabled != _shuffle.value) setShuffle(shuffleModeEnabled)
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
                if (casting && ++castFailures >= MAX_CAST_FAILURES) {
                    // Every song failing means the TV can't reach the phone: going on would only run through the queue.
                    _error.value = "The TV can't play these songs. It may not be able to reach this phone on the network."
                    return
                }
                // Skip what can't be played (unsupported codec, missing file) instead of stopping the queue.
                if (player.hasNextMediaItem()) {
                    player.seekToNextMediaItem()
                    player.prepare()
                    player.play()
                }
            }
    }

    init {
        exo.addListener(listener)
        exo.addListener(object : Player.Listener {
            override fun onAudioSessionIdChanged(audioSessionId: Int) {
                attachEffects(audioSessionId)
            }
        })
        // Shuffle reorders the queue itself, so the queue always shows play order. The player's own
        // shuffle flag only mirrors the mode for the notification and Auto; its order stays the list's.
        exo.setShuffleOrder(ShuffleOrder.UnshuffledShuffleOrder(0))
        exo.shuffleModeEnabled = _shuffle.value
        exo.skipSilenceEnabled = prefs.skipSilence.value
        scope.launch { prefs.pauseOnDisconnect.flow.collect { exo.setHandleAudioBecomingNoisy(it) } }
        scope.launch { prefs.skipSilence.flow.collect { exo.skipSilenceEnabled = it } }
        scope.launch { prefs.replayGain.flow.collect { applyGain() } }
        scope.launch { prefs.preampDb.flow.collect { applyGain() } }
        scope.launch { ticker() }
        attachEffects(exo.audioSessionId) // the first id is generated up front, without a callback
        registerReconnect()
    }

    /**
     * The play button's state. On a TV it stays on through the moment between songs, when the
     * player is loading and isn't strictly playing, so the button doesn't flicker.
     */
    private fun publishPlaying() {
        val p = player
        _isPlaying.value = if (casting) p.playWhenReady && (p.playbackState == Player.STATE_READY || p.playbackState == Player.STATE_BUFFERING) else p.isPlaying
    }

    // ---- Casting -------------------------------------------------------------------------------

    /** Moves playback onto [tv]: same queue, same song, same place, playing if it was playing. */
    fun startRemote(tv: Player) {
        if (player === tv) return
        ensureService()
        pausedByDisconnect = false
        val wasPlaying = player.playWhenReady && (player.playbackState == Player.STATE_READY || player.playbackState == Player.STATE_BUFFERING)
        handOver(tv, wasPlaying)
    }

    /** Back to the phone: the same song in the same place, paused, so it doesn't start playing out loud. */
    fun stopRemote() {
        if (casting) handOver(exo, false)
    }

    private fun handOver(to: Player, play: Boolean) {
        val from = player
        val items = List(from.mediaItemCount) { from.getMediaItemAt(it) }
        val index = from.currentMediaItemIndex.coerceAtLeast(0)
        val at = from.currentPosition
        val repeat = from.repeatMode
        val parameters = from.playbackParameters
        fadeJob?.cancel()
        fadeVolume = 1f
        castFailures = 0
        listens.onPlaying(false, at)
        from.removeListener(listener)
        if (from === exo) {
            exo.pause()
            exo.stop()
            exo.clearMediaItems()
        }
        _active.value = to
        _isPlaying.value = false
        to.addListener(listener)
        to.repeatMode = repeat
        to.shuffleModeEnabled = _shuffle.value
        to.playbackParameters = parameters
        if (items.isNotEmpty()) {
            to.setMediaItems(items, index, at)
            if (to === exo) exo.setShuffleOrder(ShuffleOrder.UnshuffledShuffleOrder(items.size))
            to.playWhenReady = play
            to.prepare()
        }
        applyGain()
        persist()
    }

    /** A song from the queue, for what the TV needs to know about it. */
    fun trackFor(id: Long): Track? = known[id] ?: app.library.track(id)?.also { known[it.id] = it }

    /** The ReplayGain for song [id] if it's the current one (a TV is only ever told about the current one). */
    fun gainFor(id: Long): Float = if (_current.value?.id == id) rgVolume.coerceIn(0f, 1f) else 1f

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
        // A queue keeps its own shuffle: switching to one shows whether it's shuffled.
        val original = q.original?.let { resolve(it) }
        original?.forEach { known[it.id] = it }
        unshuffled = original?.map { it.id }
        setShuffleFlag(original != null)
        setItems(tracks, index, if (tracks.getOrNull(index)?.relPath == wanted) q.positionMs else 0L)
        if (play) player.play()
        publishQueues()
    }

    private fun setItems(tracks: List<Track>, index: Int, positionMs: Long) {
        tracks.forEach { known[it.id] = it }
        player.setMediaItems(tracks.map { it.toMediaItem() }, index.coerceIn(0, max(tracks.size - 1, 0)), positionMs)
        if (!casting) exo.setShuffleOrder(ShuffleOrder.UnshuffledShuffleOrder(tracks.size))
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

    /**
     * After the tag editor rewrote these songs' files: fresh details everywhere, and the phone's
     * player reopens them (its seek positions point into the old file). The playing song carries on
     * from where it was. (A TV fetches songs anew by id; the phone's player is redone even while
     * casting, so it's right when playback comes back.)
     */
    fun reloadEdited(ids: Set<Long>) {
        scope.launch {
            val fresh = withContext(Dispatchers.IO) { app.library.tracksByIds(ids.toList()) }.associateBy { it.id }
            fresh.values.forEach { known[it.id] = it }
            val version = System.currentTimeMillis()
            val cur = exo.currentMediaItemIndex
            for (i in 0 until exo.mediaItemCount) {
                val t = exo.getMediaItemAt(i).mediaId.toLongOrNull()?.let { fresh[it] } ?: continue
                val pos = if (i == cur) exo.currentPosition else 0L
                exo.replaceMediaItem(i, mediaItemFor(t, app.library.fileOf(t), version))
                if (i == cur) exo.seekTo(i, pos)
            }
            refreshTracks()
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
        original = unshuffled?.let { ids -> ids.mapNotNull { known[it]?.relPath } },
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
     * [mode] defaults to the user's tap setting. [shuffle] (a list's Shuffle button) turns shuffle
     * on and starts from a random song, as on the desktop; while shuffle is on, a new queue starts
     * with the tapped song and the rest in a random order.
     */
    fun play(tracks: List<Track>, start: Int = 0, label: String = "", mode: TapMode = tapMode(), shuffle: Boolean = false) {
        if (tracks.isEmpty()) return
        ensureService()
        if (shuffle) setShuffleFlag(true)
        var list = tracks
        var startAt = if (shuffle) kotlin.random.Random.nextInt(tracks.size) else start.coerceIn(0, tracks.size - 1)
        var original: List<Long>? = null
        if (_shuffle.value) {
            list = Shuffle.order(tracks.map { artistKey(it) }, startAt).map { tracks[it] }
            startAt = 0
            original = tracks.map { it.id }
        }
        val empty = player.mediaItemCount == 0 || activeId < 0
        when (if (empty && mode != TapMode.Named) TapMode.Replace else mode) {
            TapMode.Replace -> {
                if (activeId < 0) activeId = newQueueId()
                activeName = label
                listens.end(Listens.End.Skipped) // like the desktop's setQueue: skipped if playing, else stopped
                unshuffled = original
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
                unshuffled = original
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
        val state = player.playbackState
        val onTheWay = player.playWhenReady && (state == Player.STATE_READY || state == Player.STATE_BUFFERING)
        if (state == Player.STATE_ENDED) player.seekTo(0, 0)
        if (state == Player.STATE_IDLE) player.prepare()
        when {
            // Fades are the phone's: on a TV they'd lag behind and could be heard in steps.
            casting -> if (onTheWay) player.pause() else player.play()
            player.isPlaying -> fadeThen(0f) { player.pause() }
            else -> { player.play(); fadeIn() }
        }
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

    /**
     * Takes song [index] of [shown] (queue [id] as the Queues page lists it) out of that queue, the
     * playing song included (the next one starts). Returns what undoes it, or null if nothing changed.
     */
    fun removeFromQueue(id: Long, index: Int, shown: List<Track>): (() -> Unit)? {
        val t = shown.getOrNull(index) ?: return null
        if (id == activeId) {
            if (index !in 0 until player.mediaItemCount || player.getMediaItemAt(index).mediaId != t.id.toString()) return null
            player.removeMediaItem(index)
            return {
                known[t.id] = t
                if (id == activeId) player.addMediaItem(index.coerceAtMost(player.mediaItemCount), t.toMediaItem())
            }
        }
        val i = saved.indexOfFirst { it.id == id }
        if (i < 0) return null
        val q = saved[i]
        // The list skips files that are gone, so find the same copy of this song in the saved paths.
        val nth = shown.subList(0, index).count { it.relPath == t.relPath }
        var seen = 0
        val at = q.paths.indexOfFirst { it == t.relPath && seen++ == nth }
        if (at < 0) return null
        saved[i] = q.copy(
            paths = q.paths.toMutableList().apply { removeAt(at) },
            index = if (at < q.index) q.index - 1 else q.index,
            positionMs = if (at == q.index) 0L else q.positionMs,
        )
        publishQueues()
        persist()
        return {
            val j = saved.indexOfFirst { it.id == id }
            if (j >= 0) { saved[j] = q; publishQueues(); persist() }
        }
    }

    fun toggleShuffle() = setShuffle(!_shuffle.value)

    /**
     * The desktop's shuffle toggle. On: the playing song moves to the top and every other song
     * follows in a random order that keeps an artist's songs apart. Off: the queue goes back to its
     * order from before, and carries on from the playing song.
     */
    fun setShuffle(on: Boolean) {
        if (on == _shuffle.value) return
        setShuffleFlag(on)
        val ids = queueIds()
        if (on) {
            unshuffled = ids
            if (ids.size > 1) reorderQueue(Shuffle.order(ids.map { artistKey(known[it]) }, player.currentMediaItemIndex))
        } else {
            val before = unshuffled
            unshuffled = null
            if (before != null && ids.size > 1) reorderQueue(Shuffle.restore(ids, before, player.currentMediaItemIndex))
        }
        persist()
    }

    private fun setShuffleFlag(on: Boolean) {
        _shuffle.value = on
        prefs.shuffle.value = on
        if (player.shuffleModeEnabled != on) player.shuffleModeEnabled = on
    }

    private fun queueIds(): List<Long> = (0 until player.mediaItemCount).map { player.getMediaItemAt(it).mediaId.toLongOrNull() ?: -1L }

    /** The desktop's artistKey: shuffle keeps songs with the same one apart. */
    private fun artistKey(t: Track?): String = t?.artist?.trim()?.lowercase() ?: ""

    /** A sort from the queue's menu: the queue takes that order and is no longer shuffled. */
    fun sortQueue(order: List<Int>) {
        reorderQueue(order)
        if (_shuffle.value) {
            unshuffled = null
            setShuffleFlag(false)
            persist()
        }
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
                unshuffled = null
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

    fun castProblem(message: String) { _error.value = message }

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
        if (casting) player.pause() else if (player.isPlaying) fadeThen(0f, 3000) { player.pause() }
    }

    // ---- Volume: ReplayGain x fade -------------------------------------------------------------

    private var rgVolume = 1f
    private var fadeVolume = 1f
    private var fadeJob: Job? = null

    private fun applyVolume() {
        if (casting) app.cast.setGain(rgVolume) else exo.volume = (rgVolume * fadeVolume).coerceIn(0f, 1f)
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
        exo.addListener(object : Player.Listener {
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
                if (headset && pausedByDisconnect && prefs.resumeOnConnect.value && !casting && exo.mediaItemCount > 0) {
                    pausedByDisconnect = false
                    exo.play()
                }
            }
        }, null)
    }

    private fun toast(msg: String) {
        Toast.makeText(app, msg, Toast.LENGTH_SHORT).show()
    }

    companion object {
        private const val TAG = "ValencePlayback"
        private const val MAX_CAST_FAILURES = 3

        /** [version] > 0 makes the item differ from one made before the file was rewritten, so the player reopens it. */
        fun mediaItemFor(t: Track, file: File, version: Long = 0): MediaItem = MediaItem.Builder()
            .setMediaId(t.id.toString())
            .setUri(Uri.fromFile(file).let { if (version > 0) it.buildUpon().appendQueryParameter("v", version.toString()).build() else it })
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
