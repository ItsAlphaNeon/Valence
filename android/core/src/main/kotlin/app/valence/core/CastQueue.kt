package app.valence.core

/** The TV's player, as Google Cast reports it. */
enum class TvState { Idle, Loading, Buffering, Paused, Playing }

/** Why the TV's player went idle. */
enum class TvIdleReason { None, Finished, Canceled, Interrupted, Error }

/**
 * @param loadId which of our loads this is about, if the status says (a status can arrive late, about the song before)
 * @param durationMs the song's length as the TV sees it, or -1
 */
data class TvStatus(
    val state: TvState,
    val idleReason: TvIdleReason = TvIdleReason.None,
    val positionMs: Long = 0,
    val durationMs: Long = -1,
    val loadId: Long? = null,
)

/** Orders for the TV. [CastQueue] is the only caller; the phone's Cast session (or a fake, in tests) carries them out. */
interface TvRemote<T> {
    /** Plays [item]; answer with [CastQueue.onLoadResult] for this [loadId]. */
    fun load(loadId: Long, item: T, startMs: Long, autoplay: Boolean, speed: Float)
    /** [done] gets whether the TV took the order. */
    fun play(done: (Boolean) -> Unit)
    fun pause(done: (Boolean) -> Unit)
    fun seek(positionMs: Long, done: (Boolean) -> Unit)
    fun setSpeed(speed: Float)
    fun stop()
}

/**
 * The play queue while casting. The queue stays on the phone and the TV gets one song at a time,
 * because Cast messages are limited to about 64 KB and queues here run to thousands of songs. This
 * decides what to tell the TV and what the TV's reports mean; it has no Android in it, so it can be
 * tested without a TV. The app's cast player shows it to the rest of the app as a Media3 player.
 *
 * Call everything from one thread. Changes made by calling in (setItems, seek...) are the caller's
 * to report; [onChange] fires for what comes from the TV.
 *
 * @param now a clock in milliseconds, for working out the position between the TV's reports
 * @param scheduleFlush asks for [flush] to be called soon, after what the caller is doing. Loads wait
 *   for it, so play(list) sends one load instead of three and a run of skips only loads the last song.
 */
class CastQueue<T>(
    private val remote: TvRemote<T>,
    private val now: () -> Long,
    private val scheduleFlush: () -> Unit,
) {
    class Entry<T>(val uid: Long, val item: T)

    /** The same four states a Media3 player has. */
    enum class Status { Idle, Buffering, Ready, Ended }

    private enum class Phase {
        /** Not prepared yet, or stopped. */
        Stopped,
        /** A load is waiting for [flush]. */
        Pending,
        /** The TV was told to load the song and hasn't said it has. */
        Loading,
        /** The TV has the song. */
        Active,
        /** Something on the TV's side stopped the song; the next play loads it again. */
        Unloaded,
        /** The queue played to its end. */
        Ended,
        /** The song failed on the TV. */
        Failed,
    }

    /** A position that's [baseMs] at time [atMs] and moving at [rate], up to [capMs] (-1: no cap). */
    class Position(val baseMs: Long, val atMs: Long, val rate: Float, val capMs: Long) {
        fun at(timeMs: Long): Long {
            val p = baseMs + ((timeMs - atMs).coerceAtLeast(0) * rate).toLong()
            return if (capMs >= 0) p.coerceAtMost(capMs.coerceAtLeast(baseMs)) else p
        }
    }

    var onChange: () -> Unit = {}

    var entries: List<Entry<T>> = emptyList()
        private set

    /** Goes up whenever [entries] changes. */
    var revision = 0
        private set
    var index = 0
        private set
    var playWhenReady = false
        private set

    /** The last play/pause change came from the TV (its remote), not from this phone. */
    var changedByTv = false
        private set
    var repeatMode = REPEAT_OFF
    var speed = 1f
        private set

    /** The error code of a failed song, until the next prepare. */
    var errorCode: Int? = null
        private set

    private var phase = Phase.Stopped
    private var nextUid = 1L
    private var loadId = 0L
    private var position = Position(0, now(), 0f, -1)
    private var tvDurationMs = -1L
    private var last: TvStatus? = null
    private var commandsInFlight = 0
    /** The TV's first report after a load may not be what the phone now wants (paused while it loaded). */
    private var reconcile = false
    private var autoTransition = false

    val status: Status
        get() = when {
            entries.isEmpty() -> if (phase == Phase.Stopped || phase == Phase.Failed) Status.Idle else Status.Ended
            else -> when (phase) {
                Phase.Stopped, Phase.Failed -> Status.Idle
                Phase.Ended -> Status.Ended
                Phase.Pending, Phase.Loading -> Status.Buffering
                Phase.Unloaded -> Status.Ready
                Phase.Active -> when (last?.state) {
                    TvState.Playing, TvState.Paused -> Status.Ready
                    else -> Status.Buffering
                }
            }
        }

    /** A snapshot: unlike the queue, it can be read later and still say where the song was going. */
    fun position(): Position = position

    fun positionMs(): Long = position.at(now())

    /** True once after the queue moved on by itself: the position jump is a song ending, not a seek. */
    fun takeAutoTransition(): Boolean = autoTransition.also { autoTransition = false }

    // ---- From the phone ------------------------------------------------------------------------

    /** Replaces the queue. [startIndex] is clamped to it; -1 means the first song, and [startMs] -1 its start. */
    fun setItems(items: List<T>, startIndex: Int, startMs: Long) {
        entries = items.map(::entryOf)
        revision++
        index = if (items.isEmpty()) 0 else startIndex.coerceIn(0, items.size - 1)
        anchor(startMs.coerceAtLeast(0))
        currentChanged()
    }

    fun add(at: Int, items: List<T>) {
        val wasEmpty = entries.isEmpty()
        val i = at.coerceIn(0, entries.size)
        entries = entries.toMutableList().apply { addAll(i, items.map(::entryOf)) }
        revision++
        if (wasEmpty) {
            index = 0
            anchor(0)
            if (phase == Phase.Ended) scheduleLoad()
        } else if (i <= index) {
            index += items.size
        }
    }

    /** Moves songs [from] until [to] so the first of them lands at [newIndex]. The playing song plays on. */
    fun move(from: Int, to: Int, newIndex: Int) {
        val uid = entries.getOrNull(index)?.uid
        val list = entries.toMutableList()
        val moved = list.subList(from, to).toList()
        list.subList(from, to).clear()
        list.addAll(newIndex, moved)
        entries = list
        revision++
        index = list.indexOfFirst { it.uid == uid }.coerceAtLeast(0)
    }

    fun remove(from: Int, to: Int) {
        val hadCurrent = index in from until to
        entries = entries.toMutableList().apply { subList(from, to).clear() }
        revision++
        when {
            !hadCurrent -> if (index >= to) index -= to - from
            entries.isEmpty() -> {
                index = 0
                anchor(0)
                stopOnTv()
            }
            from >= entries.size -> {
                // The last song went: the queue is over, as it would be if the song had ended.
                index = entries.size - 1
                anchor(0)
                stopOnTv()
            }
            else -> {
                index = from
                anchor(0)
                currentChanged()
            }
        }
    }

    fun replace(from: Int, to: Int, items: List<T>) {
        add(to, items)
        if (from != to) remove(from, to)
    }

    fun prepare() {
        errorCode = null
        if (phase != Phase.Stopped && phase != Phase.Failed) return
        if (entries.isEmpty()) phase = Phase.Ended else scheduleLoad()
    }

    fun stop() {
        position = Position(positionMs(), now(), 0f, -1)
        loadId++
        if (phase != Phase.Stopped) remote.stop()
        phase = Phase.Stopped
        errorCode = null
    }

    fun setPlayWhenReady(play: Boolean) {
        if (play == playWhenReady) return
        playWhenReady = play
        changedByTv = false
        when (phase) {
            Phase.Active -> {
                if (!play) position = Position(positionMs(), now(), 0f, tvDurationMs)
                command(play)
            }
            Phase.Unloaded -> if (play) scheduleLoad()
            else -> Unit // a waiting load picks it up; one on its way is put right when the TV reports
        }
    }

    /** Seeks to [ms] in song [i]; [i] -1 means the current song and [ms] -1 its start. */
    fun seek(i: Int, ms: Long) {
        val target = if (i < 0) index else i
        val to = ms.coerceAtLeast(0)
        if (entries.isEmpty()) return anchor(to)
        if (target != index) {
            index = target.coerceIn(0, entries.size - 1)
            anchor(to)
            currentChanged()
            return
        }
        when (phase) {
            Phase.Active -> {
                position = Position(to, now(), position.rate, tvDurationMs)
                commandsInFlight++
                remote.seek(to) { commandDone(it) }
            }
            Phase.Pending -> anchor(to)
            Phase.Loading, Phase.Unloaded, Phase.Ended -> {
                anchor(to)
                scheduleLoad()
            }
            Phase.Stopped, Phase.Failed -> anchor(to)
        }
    }

    fun setSpeed(value: Float) {
        if (value == speed) return
        val at = positionMs()
        speed = value
        if (position.rate != 0f) position = Position(at, now(), value, position.capMs)
        if (phase == Phase.Active) remote.setSpeed(value)
    }

    /** Sends a load that's waiting. See scheduleFlush. */
    fun flush() {
        if (phase != Phase.Pending) return
        val entry = entries.getOrNull(index) ?: return
        phase = Phase.Loading
        reconcile = true
        remote.load(loadId, entry.item, position.baseMs, playWhenReady, speed)
    }

    // ---- From the TV ---------------------------------------------------------------------------

    fun onLoadResult(id: Long, ok: Boolean, canceled: Boolean = false, code: Int = 0) {
        if (id != loadId || phase != Phase.Loading) return
        when {
            ok -> phase = Phase.Active
            // Someone else's load replaced ours. The song isn't on the TV any more, and that isn't an error.
            canceled -> leftTv()
            else -> fail(code)
        }
        onChange()
    }

    fun onStatus(s: TvStatus) {
        when (phase) {
            Phase.Loading -> {
                // Only a report about this very load shows it arrived; others are the last song going away.
                if (s.loadId != loadId || s.state == TvState.Idle) return
                phase = Phase.Active
            }
            Phase.Active -> if (s.loadId != null && s.loadId != loadId) return
            else -> return // nothing of ours is on the TV
        }
        last = s
        if (s.durationMs > 0) tvDurationMs = s.durationMs
        when (s.state) {
            TvState.Idle -> when (s.idleReason) {
                TvIdleReason.Finished -> finished()
                TvIdleReason.Error -> fail(0)
                TvIdleReason.Canceled, TvIdleReason.Interrupted -> leftTv()
                TvIdleReason.None -> Unit
            }
            TvState.Loading, TvState.Buffering -> position = Position(s.positionMs, now(), 0f, tvDurationMs)
            TvState.Paused, TvState.Playing -> {
                val playing = s.state == TvState.Playing
                position = Position(s.positionMs, now(), if (playing) speed else 0f, tvDurationMs)
                if (reconcile) {
                    reconcile = false
                    if (playing != playWhenReady) command(playWhenReady)
                } else if (commandsInFlight == 0) {
                    adopt(playing)
                }
            }
        }
        onChange()
    }

    /** The connection to the TV dropped and came back. Whatever was sent before may never be answered. */
    fun reconnected() {
        commandsInFlight = 0
        if (phase == Phase.Loading) scheduleLoad()
    }

    /** After [reconnected], the TV says it has no song at all. */
    fun tvEmpty() {
        if (phase != Phase.Active) return
        // Either the song played out while the phone couldn't hear about it, or someone stopped it.
        val playedOut = tvDurationMs > 0 && position.rate != 0f && positionMs() >= tvDurationMs - END_SLACK_MS
        if (playedOut) finished() else leftTv()
        onChange()
    }

    // ---- Inside --------------------------------------------------------------------------------

    private fun entryOf(item: T) = Entry(nextUid++, item)

    private fun anchor(ms: Long) {
        position = Position(ms, now(), 0f, -1)
        tvDurationMs = -1
    }

    private fun currentChanged() {
        when (phase) {
            Phase.Stopped, Phase.Failed -> Unit // waiting for prepare
            else -> if (entries.isEmpty()) stopOnTv() else scheduleLoad()
        }
    }

    private fun scheduleLoad() {
        loadId++
        phase = Phase.Pending
        last = null
        commandsInFlight = 0
        scheduleFlush()
    }

    private fun stopOnTv() {
        loadId++
        val wasOnTv = phase == Phase.Active || phase == Phase.Loading
        phase = Phase.Ended
        if (wasOnTv) remote.stop()
    }

    private fun finished() {
        val next = when (repeatMode) {
            REPEAT_ONE -> index
            REPEAT_ALL -> (index + 1) % entries.size
            else -> index + 1
        }
        if (next >= entries.size) {
            phase = Phase.Ended
            loadId++
            position = Position(positionMs(), now(), 0f, -1)
            return
        }
        autoTransition = true
        index = next
        anchor(0)
        scheduleLoad()
    }

    private fun fail(code: Int) {
        phase = Phase.Failed
        errorCode = code
        loadId++
        position = Position(positionMs(), now(), 0f, -1)
    }

    /** The song is gone from the TV. Stay on it, paused, so play picks it back up. */
    private fun leftTv() {
        phase = Phase.Unloaded
        loadId++
        playWhenReady = false
        changedByTv = true
        position = Position(positionMs(), now(), 0f, -1)
    }

    private fun command(play: Boolean) {
        commandsInFlight++
        val done = { ok: Boolean -> commandDone(ok) }
        if (play) remote.play(done) else remote.pause(done)
    }

    private fun commandDone(ok: Boolean) {
        if (commandsInFlight > 0) commandsInFlight--
        if (ok || commandsInFlight > 0 || phase != Phase.Active) return
        // The TV turned it down: show what it's really doing.
        when (last?.state) {
            TvState.Playing -> adopt(true)
            TvState.Paused -> adopt(false)
            else -> Unit
        }
        onChange()
    }

    /** The TV changed by itself (its remote's pause button): the phone follows. */
    private fun adopt(playing: Boolean) {
        if (playing == playWhenReady) return
        playWhenReady = playing
        changedByTv = true
    }

    companion object {
        // Media3's values; this module doesn't depend on it.
        const val REPEAT_OFF = 0
        const val REPEAT_ONE = 1
        const val REPEAT_ALL = 2

        private const val END_SLACK_MS = 2000L
    }
}
