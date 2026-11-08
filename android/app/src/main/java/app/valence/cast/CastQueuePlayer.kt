package app.valence.cast

import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import androidx.annotation.OptIn
import androidx.media3.common.C
import androidx.media3.common.DeviceInfo
import androidx.media3.common.MediaItem
import androidx.media3.common.PlaybackException
import androidx.media3.common.PlaybackParameters
import androidx.media3.common.Player
import androidx.media3.common.SimpleBasePlayer
import androidx.media3.common.util.UnstableApi
import app.valence.core.CastQueue
import app.valence.core.TvRemote
import com.google.common.util.concurrent.Futures
import com.google.common.util.concurrent.ListenableFuture
import kotlin.math.roundToInt

/** The TV's own volume, 0 to 1 (the speakers, not the song's ReplayGain). */
interface TvVolume {
    val level: Float
    val muted: Boolean
    fun setLevel(level: Float)
    fun setMuted(muted: Boolean)
}

/**
 * [CastQueue] as a Media3 player, so the rest of the app (the UI, the notification, the lock screen,
 * Android Auto) drives the TV exactly as it drives the phone's own player. Its hardware volume keys
 * reach the TV too, through [DeviceInfo.PLAYBACK_TYPE_REMOTE].
 */
@OptIn(UnstableApi::class)
class CastQueuePlayer(
    looper: Looper,
    remote: TvRemote<MediaItem>,
    private val volume: TvVolume,
) : SimpleBasePlayer(looper) {
    private val handler = Handler(looper)
    private val flushNow = Runnable { queue.flush() }

    val queue: CastQueue<MediaItem> = CastQueue(remote, SystemClock::elapsedRealtime) {
        // Waiting a moment means a run of skips only loads the song they end on.
        handler.removeCallbacks(flushNow)
        handler.postDelayed(flushNow, FLUSH_DELAY_MS)
    }

    private var shuffle = false
    private var parameters = PlaybackParameters.DEFAULT

    /** One error object per failure: a new one each time would report the failure again. */
    private var error: PlaybackException? = null

    /** The part of the state that only changes with the queue. Keeping it keeps huge queues cheap. */
    private var base: State? = null
    private var baseRevision = -1

    init {
        queue.onChange = { invalidateState() }
    }

    /** The TV's volume changed. */
    fun volumeChanged() = invalidateState()

    override fun getState(): State {
        val q = queue
        val status = q.status
        val position = q.position()
        val code = q.errorCode
        error = when {
            code == null -> null
            else -> error ?: PlaybackException("The TV couldn't play this song ($code)", null, PlaybackException.ERROR_CODE_REMOTE_ERROR)
        }
        val builder = baseState().buildUpon()
            .setPlaybackState(
                when (status) {
                    CastQueue.Status.Idle -> Player.STATE_IDLE
                    CastQueue.Status.Buffering -> Player.STATE_BUFFERING
                    CastQueue.Status.Ready -> Player.STATE_READY
                    CastQueue.Status.Ended -> Player.STATE_ENDED
                },
            )
            .setPlayWhenReady(
                q.playWhenReady,
                if (q.changedByTv) Player.PLAY_WHEN_READY_CHANGE_REASON_REMOTE else Player.PLAY_WHEN_READY_CHANGE_REASON_USER_REQUEST,
            )
            .setIsLoading(status == CastQueue.Status.Buffering)
            .setPlayerError(if (status == CastQueue.Status.Idle) error else null)
            .setRepeatMode(q.repeatMode)
            .setShuffleModeEnabled(shuffle)
            .setPlaybackParameters(parameters)
            .setCurrentMediaItemIndex(q.index)
            .setContentPositionMs(PositionSupplier { position.at(SystemClock.elapsedRealtime()) })
            .setDeviceVolume((volume.level * VOLUME_STEPS).roundToInt().coerceIn(0, VOLUME_STEPS))
            .setIsDeviceMuted(volume.muted)
        if (q.takeAutoTransition()) builder.setPositionDiscontinuity(Player.DISCONTINUITY_REASON_AUTO_TRANSITION, 0)
        return builder.build()
    }

    private fun baseState(): State {
        base?.let { if (baseRevision == queue.revision) return it }
        val state = State.Builder()
            .setAvailableCommands(COMMANDS)
            .setSeekBackIncrementMs(SEEK_STEP_MS)
            .setSeekForwardIncrementMs(SEEK_STEP_MS)
            .setDeviceInfo(DEVICE_INFO)
            .setPlaylist(
                queue.entries.map { entry ->
                    MediaItemData.Builder(entry.uid)
                        .setMediaItem(entry.item)
                        .setDurationUs(entry.item.mediaMetadata.durationMs?.let { it * 1000 } ?: C.TIME_UNSET)
                        .setIsSeekable(true)
                        .build()
                },
            )
            .build()
        base = state
        baseRevision = queue.revision
        return state
    }

    private fun done(): ListenableFuture<*> = Futures.immediateVoidFuture()

    override fun handleSetPlayWhenReady(playWhenReady: Boolean): ListenableFuture<*> {
        queue.setPlayWhenReady(playWhenReady)
        return done()
    }

    override fun handlePrepare(): ListenableFuture<*> {
        error = null
        queue.prepare()
        return done()
    }

    override fun handleStop(): ListenableFuture<*> {
        queue.stop()
        return done()
    }

    override fun handleRelease(): ListenableFuture<*> {
        handler.removeCallbacks(flushNow)
        queue.onChange = {}
        return done()
    }

    override fun handleSeek(mediaItemIndex: Int, positionMs: Long, seekCommand: Int): ListenableFuture<*> {
        val failed = queue.errorCode != null
        queue.seek(mediaItemIndex, positionMs)
        // Moving on from a song the TV couldn't play tries the new one, wherever the skip came from.
        if (failed) queue.prepare()
        return done()
    }

    override fun handleSetRepeatMode(repeatMode: Int): ListenableFuture<*> {
        queue.repeatMode = repeatMode
        return done()
    }

    override fun handleSetShuffleModeEnabled(shuffleModeEnabled: Boolean): ListenableFuture<*> {
        // Only a flag, as on the phone: Playback reorders the queue itself.
        shuffle = shuffleModeEnabled
        return done()
    }

    override fun handleSetPlaybackParameters(playbackParameters: PlaybackParameters): ListenableFuture<*> {
        val speed = playbackParameters.speed.coerceIn(MIN_SPEED, MAX_SPEED)
        parameters = PlaybackParameters(speed, playbackParameters.pitch)
        queue.setSpeed(speed)
        return done()
    }

    override fun handleSetMediaItems(mediaItems: List<MediaItem>, startIndex: Int, startPositionMs: Long): ListenableFuture<*> {
        queue.setItems(mediaItems, startIndex, startPositionMs)
        return done()
    }

    override fun handleAddMediaItems(index: Int, mediaItems: List<MediaItem>): ListenableFuture<*> {
        queue.add(index, mediaItems)
        return done()
    }

    override fun handleMoveMediaItems(fromIndex: Int, toIndex: Int, newIndex: Int): ListenableFuture<*> {
        queue.move(fromIndex, toIndex, newIndex)
        return done()
    }

    override fun handleReplaceMediaItems(fromIndex: Int, toIndex: Int, mediaItems: List<MediaItem>): ListenableFuture<*> {
        queue.replace(fromIndex, toIndex, mediaItems)
        return done()
    }

    override fun handleRemoveMediaItems(fromIndex: Int, toIndex: Int): ListenableFuture<*> {
        queue.remove(fromIndex, toIndex)
        return done()
    }

    override fun handleSetDeviceVolume(deviceVolume: Int, flags: Int): ListenableFuture<*> {
        volume.setLevel(deviceVolume.toFloat() / VOLUME_STEPS)
        return done()
    }

    override fun handleIncreaseDeviceVolume(flags: Int): ListenableFuture<*> {
        volume.setLevel(volume.level + 1f / VOLUME_STEPS)
        return done()
    }

    override fun handleDecreaseDeviceVolume(flags: Int): ListenableFuture<*> {
        volume.setLevel(volume.level - 1f / VOLUME_STEPS)
        return done()
    }

    override fun handleSetDeviceMuted(muted: Boolean, flags: Int): ListenableFuture<*> {
        volume.setMuted(muted)
        return done()
    }

    companion object {
        private const val FLUSH_DELAY_MS = 100L
        private const val SEEK_STEP_MS = 10_000L
        const val VOLUME_STEPS = 20

        /** What Cast accepts; the phone's own player goes wider. */
        const val MIN_SPEED = 0.5f
        const val MAX_SPEED = 2f

        private val DEVICE_INFO = DeviceInfo.Builder(DeviceInfo.PLAYBACK_TYPE_REMOTE).setMinVolume(0).setMaxVolume(VOLUME_STEPS).build()

        private val COMMANDS = Player.Commands.Builder().addAll(
            Player.COMMAND_PLAY_PAUSE,
            Player.COMMAND_PREPARE,
            Player.COMMAND_STOP,
            Player.COMMAND_SEEK_TO_DEFAULT_POSITION,
            Player.COMMAND_SEEK_IN_CURRENT_MEDIA_ITEM,
            Player.COMMAND_SEEK_TO_PREVIOUS_MEDIA_ITEM,
            Player.COMMAND_SEEK_TO_PREVIOUS,
            Player.COMMAND_SEEK_TO_NEXT_MEDIA_ITEM,
            Player.COMMAND_SEEK_TO_NEXT,
            Player.COMMAND_SEEK_TO_MEDIA_ITEM,
            Player.COMMAND_SEEK_BACK,
            Player.COMMAND_SEEK_FORWARD,
            Player.COMMAND_SET_SPEED_AND_PITCH,
            Player.COMMAND_SET_SHUFFLE_MODE,
            Player.COMMAND_SET_REPEAT_MODE,
            Player.COMMAND_GET_CURRENT_MEDIA_ITEM,
            Player.COMMAND_GET_TIMELINE,
            Player.COMMAND_GET_METADATA,
            Player.COMMAND_SET_MEDIA_ITEM,
            Player.COMMAND_CHANGE_MEDIA_ITEMS,
            Player.COMMAND_GET_DEVICE_VOLUME,
            Player.COMMAND_SET_DEVICE_VOLUME_WITH_FLAGS,
            Player.COMMAND_ADJUST_DEVICE_VOLUME_WITH_FLAGS,
            Player.COMMAND_RELEASE,
        ).build()
    }
}
