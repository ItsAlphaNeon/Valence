package app.valence.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class CastQueueTest {
    private class Load(val id: Long, val item: String, val startMs: Long, val autoplay: Boolean, val speed: Float)

    private class Fake : TvRemote<String> {
        val loads = mutableListOf<Load>()
        val calls = mutableListOf<String>()
        var pendingDone: ((Boolean) -> Unit)? = null
        var answerAtOnce = true

        private fun done(d: (Boolean) -> Unit) { if (answerAtOnce) d(true) else pendingDone = d }

        override fun load(loadId: Long, item: String, startMs: Long, autoplay: Boolean, speed: Float) {
            loads.add(Load(loadId, item, startMs, autoplay, speed))
        }
        override fun play(done: (Boolean) -> Unit) { calls.add("play"); done(done) }
        override fun pause(done: (Boolean) -> Unit) { calls.add("pause"); done(done) }
        override fun seek(positionMs: Long, done: (Boolean) -> Unit) { calls.add("seek $positionMs"); done(done) }
        override fun setSpeed(speed: Float) { calls.add("speed $speed") }
        override fun stop() { calls.add("stop") }
    }

    private var clock = 1000L
    private var flushAsked = 0
    private val tv = Fake()
    private val q = CastQueue(tv, { clock }, { flushAsked++ })

    private fun started(vararg items: String, index: Int = 0, positionMs: Long = 0, play: Boolean = true): Long {
        q.setItems(items.toList(), index, positionMs)
        q.prepare()
        q.setPlayWhenReady(play)
        q.flush()
        return tv.loads.last().id
    }

    private fun CastQueue<String>.playing(id: Long, ms: Long = 0, duration: Long = 100_000) =
        onStatus(TvStatus(TvState.Playing, positionMs = ms, durationMs = duration, loadId = id))

    private fun CastQueue<String>.finishedOn(id: Long) =
        onStatus(TvStatus(TvState.Idle, TvIdleReason.Finished, loadId = id))

    private val current get() = q.entries[q.index].item

    @Test
    fun `nothing goes to the TV until prepared`() {
        q.setItems(listOf("a", "b"), 1, 5000)
        q.flush()
        assertEquals(0, tv.loads.size)
        assertEquals(CastQueue.Status.Idle, q.status)
        assertEquals(5000, q.positionMs())
    }

    @Test
    fun `play(list) sends one load, carrying all of it`() {
        q.setItems(listOf("a", "b", "c"), 1, 2500)
        q.prepare()
        q.setPlayWhenReady(true)
        assertEquals(0, tv.loads.size)
        assertEquals(CastQueue.Status.Buffering, q.status)
        q.flush()
        q.flush()
        val load = tv.loads.single()
        assertEquals("b", load.item)
        assertEquals(2500, load.startMs)
        assertTrue(load.autoplay)
    }

    @Test
    fun `resuming a paused queue loads it paused`() {
        started("a", index = 0, positionMs = 42_000, play = false)
        val load = tv.loads.single()
        assertFalse(load.autoplay)
        assertEquals(42_000, load.startMs)
        q.onStatus(TvStatus(TvState.Paused, positionMs = 42_000, loadId = load.id))
        assertEquals(CastQueue.Status.Ready, q.status)
        assertFalse(q.playWhenReady)
        assertEquals(42_000, q.positionMs())
    }

    @Test
    fun `a run of skips only loads the last song`() {
        val first = started("a", "b", "c", "d")
        q.playing(first)
        q.seek(1, 0)
        q.seek(2, 0)
        q.seek(3, 0)
        q.flush()
        assertEquals(listOf("a", "d"), tv.loads.map { it.item })
    }

    @Test
    fun `position runs between the TV's reports and stops when paused`() {
        val id = started("a")
        q.playing(id, 10_000)
        clock += 2500
        assertEquals(12_500, q.positionMs())
        q.setPlayWhenReady(false)
        clock += 5000
        assertEquals(12_500, q.positionMs())
    }

    @Test
    fun `position follows the speed`() {
        val id = started("a")
        q.setSpeed(2f)
        q.playing(id, 10_000)
        clock += 1000
        assertEquals(12_000, q.positionMs())
    }

    @Test
    fun `position stops at the end of the song`() {
        val id = started("a")
        q.playing(id, 99_000, duration = 100_000)
        clock += 60_000
        assertEquals(100_000, q.positionMs())
    }

    @Test
    fun `position holds still while buffering`() {
        val id = started("a")
        q.playing(id, 1000)
        q.onStatus(TvStatus(TvState.Buffering, positionMs = 1500, loadId = id))
        assertEquals(CastQueue.Status.Buffering, q.status)
        clock += 9000
        assertEquals(1500, q.positionMs())
    }

    @Test
    fun `a finished song moves on, once`() {
        val id = started("a", "b")
        q.playing(id, 99_000)
        q.finishedOn(id)
        q.finishedOn(id)
        q.onStatus(TvStatus(TvState.Idle, TvIdleReason.Finished))
        assertEquals("b", current)
        assertEquals(0, q.positionMs())
        assertTrue(q.takeAutoTransition())
        assertFalse(q.takeAutoTransition())
        q.flush()
        assertEquals(listOf("a", "b"), tv.loads.map { it.item })
        assertTrue(tv.loads.last().autoplay)
    }

    @Test
    fun `a late report about the old song isn't taken for the new one`() {
        val a = started("a", "b", "c")
        q.playing(a, 99_000)
        q.finishedOn(a)
        q.flush()
        val b = tv.loads.last().id
        // The load's in flight: another finished report, and the old song's last reports.
        q.finishedOn(a)
        q.onStatus(TvStatus(TvState.Idle, TvIdleReason.Finished))
        q.onStatus(TvStatus(TvState.Playing, positionMs = 99_500, loadId = a))
        assertEquals("b", current)
        assertEquals(CastQueue.Status.Buffering, q.status)
        q.playing(b, 100)
        assertEquals(CastQueue.Status.Ready, q.status)
        q.onStatus(TvStatus(TvState.Playing, positionMs = 99_500, loadId = a))
        q.finishedOn(a)
        assertEquals("b", current)
        assertEquals(100, q.positionMs())
    }

    @Test
    fun `a song interrupted by our own load isn't a stop`() {
        val a = started("a", "b")
        q.playing(a, 5000)
        q.seek(1, 0)
        q.flush()
        q.onStatus(TvStatus(TvState.Idle, TvIdleReason.Interrupted, loadId = a))
        assertTrue(q.playWhenReady)
        assertEquals(CastQueue.Status.Buffering, q.status)
    }

    @Test
    fun `the queue ends`() {
        val id = started("a")
        q.playing(id, 99_000)
        clock += 1000
        q.finishedOn(id)
        assertEquals(CastQueue.Status.Ended, q.status)
        assertEquals("a", current)
        assertFalse(q.takeAutoTransition())
        assertEquals(100_000, q.positionMs())
        // Seeking back, as the play button does when the queue's over, plays again.
        q.seek(0, 0)
        q.flush()
        assertEquals(2, tv.loads.size)
        assertEquals(CastQueue.Status.Buffering, q.status)
    }

    @Test
    fun `repeat one plays the song again`() {
        val id = started("a", "b")
        q.repeatMode = CastQueue.REPEAT_ONE
        q.playing(id, 99_000)
        q.finishedOn(id)
        assertTrue(q.takeAutoTransition())
        q.flush()
        assertEquals(listOf("a", "a"), tv.loads.map { it.item })
    }

    @Test
    fun `repeat all goes round`() {
        val id = started("a", "b", index = 1)
        q.repeatMode = CastQueue.REPEAT_ALL
        q.playing(id)
        q.finishedOn(id)
        q.flush()
        assertEquals("a", tv.loads.last().item)
    }

    @Test
    fun `pausing while it loads is put right when it arrives`() {
        val id = started("a")
        q.setPlayWhenReady(false)
        assertEquals(emptyList<String>(), tv.calls)
        q.playing(id)
        assertEquals(listOf("pause"), tv.calls)
        assertFalse(q.playWhenReady)
    }

    @Test
    fun `playing while it loads paused is put right too`() {
        val id = started("a", play = false)
        q.setPlayWhenReady(true)
        q.onStatus(TvStatus(TvState.Paused, loadId = id))
        assertEquals(listOf("play"), tv.calls)
        assertTrue(q.playWhenReady)
    }

    @Test
    fun `pause and play go to the TV`() {
        val id = started("a")
        q.playing(id)
        q.setPlayWhenReady(false)
        q.onStatus(TvStatus(TvState.Paused, loadId = id))
        q.setPlayWhenReady(true)
        assertEquals(listOf("pause", "play"), tv.calls)
    }

    @Test
    fun `the TV's own pause button shows on the phone`() {
        val id = started("a")
        q.playing(id)
        q.onStatus(TvStatus(TvState.Paused, positionMs = 3000, loadId = id))
        assertFalse(q.playWhenReady)
        assertTrue(q.changedByTv)
        q.onStatus(TvStatus(TvState.Playing, positionMs = 3000, loadId = id))
        assertTrue(q.playWhenReady)
    }

    @Test
    fun `an old report doesn't undo a pause on its way`() {
        val id = started("a")
        q.playing(id)
        tv.answerAtOnce = false
        q.setPlayWhenReady(false)
        q.playing(id, 500)
        assertFalse(q.playWhenReady)
        tv.pendingDone!!(true)
        q.onStatus(TvStatus(TvState.Paused, positionMs = 500, loadId = id))
        assertFalse(q.playWhenReady)
    }

    @Test
    fun `a pause the TV refuses shows it's still playing`() {
        val id = started("a")
        q.playing(id)
        tv.answerAtOnce = false
        q.setPlayWhenReady(false)
        tv.pendingDone!!(false)
        assertTrue(q.playWhenReady)
    }

    @Test
    fun `seek in the song goes to the TV`() {
        val id = started("a")
        q.playing(id, 1000)
        q.seek(0, 50_000)
        assertEquals(listOf("seek 50000"), tv.calls)
        assertEquals(50_000, q.positionMs())
        assertEquals(1, tv.loads.size)
    }

    @Test
    fun `seek before the load is sent changes the load`() {
        q.setItems(listOf("a"), 0, 0)
        q.prepare()
        q.seek(0, 7000)
        q.flush()
        assertEquals(7000, tv.loads.single().startMs)
        assertEquals(emptyList<String>(), tv.calls)
    }

    @Test
    fun `seek during a load reloads there`() {
        started("a")
        q.seek(0, 9000)
        q.flush()
        assertEquals(2, tv.loads.size)
        assertEquals(9000, tv.loads.last().startMs)
    }

    @Test
    fun `a failed load is an error, and prepare tries again`() {
        val id = started("a", "b")
        q.onLoadResult(id, ok = false, code = 2100)
        assertEquals(2100, q.errorCode)
        assertEquals(CastQueue.Status.Idle, q.status)
        // What the app does on an error: next song, prepare, play.
        q.seek(1, 0)
        assertEquals(CastQueue.Status.Idle, q.status)
        q.prepare()
        assertNull(q.errorCode)
        q.flush()
        assertEquals("b", tv.loads.last().item)
    }

    @Test
    fun `an error during the song is an error`() {
        val id = started("a")
        q.playing(id)
        q.onStatus(TvStatus(TvState.Idle, TvIdleReason.Error, loadId = id))
        assertEquals(0, q.errorCode)
        assertEquals(CastQueue.Status.Idle, q.status)
    }

    @Test
    fun `the results of old loads are ignored`() {
        val first = started("a", "b")
        q.seek(1, 0)
        q.flush()
        q.onLoadResult(first, ok = false, code = 2103)
        assertNull(q.errorCode)
        assertEquals(CastQueue.Status.Buffering, q.status)
        q.onLoadResult(tv.loads.last().id, ok = true)
        q.playing(tv.loads.last().id)
        assertEquals(CastQueue.Status.Ready, q.status)
    }

    @Test
    fun `a load result alone is enough if the TV doesn't echo our id`() {
        val id = started("a")
        q.onLoadResult(id, ok = true)
        q.onStatus(TvStatus(TvState.Playing, positionMs = 4000))
        assertEquals(CastQueue.Status.Ready, q.status)
        assertEquals(4000, q.positionMs())
        q.onStatus(TvStatus(TvState.Idle, TvIdleReason.Finished))
        assertEquals(CastQueue.Status.Ended, q.status)
    }

    @Test
    fun `something else stopping the song leaves the phone paused on it`() {
        val id = started("a", "b")
        q.playing(id, 30_000)
        q.onStatus(TvStatus(TvState.Idle, TvIdleReason.Canceled, loadId = id))
        assertFalse(q.playWhenReady)
        assertEquals(CastQueue.Status.Ready, q.status)
        assertEquals("a", current)
        assertEquals(30_000, q.positionMs())
        q.setPlayWhenReady(true)
        q.flush()
        assertEquals("a", tv.loads.last().item)
        assertEquals(30_000, tv.loads.last().startMs)
    }

    @Test
    fun `someone else's load replacing ours isn't an error`() {
        val id = started("a")
        q.onLoadResult(id, ok = false, canceled = true, code = 2103)
        assertNull(q.errorCode)
        assertFalse(q.playWhenReady)
    }

    @Test
    fun `the same song can be in the queue twice`() {
        started("a", "a", "a")
        assertEquals(3, q.entries.map { it.uid }.toSet().size)
    }

    @Test
    fun `adding songs keeps the playing one`() {
        val id = started("a", "b", index = 1)
        q.playing(id)
        q.add(0, listOf("x", "y"))
        assertEquals("b", current)
        assertEquals(3, q.index)
        q.add(4, listOf("z"))
        assertEquals(3, q.index)
        assertEquals(listOf("x", "y", "a", "b", "z"), q.entries.map { it.item })
        assertEquals(1, tv.loads.size)
    }

    @Test
    fun `moving songs keeps the playing one`() {
        val id = started("a", "b", "c", "d", index = 1)
        q.playing(id)
        q.move(1, 2, 3)
        assertEquals(listOf("a", "c", "d", "b"), q.entries.map { it.item })
        assertEquals("b", current)
        q.move(0, 1, 2)
        assertEquals(listOf("c", "d", "a", "b"), q.entries.map { it.item })
        assertEquals("b", current)
        q.move(2, 4, 0)
        assertEquals(listOf("a", "b", "c", "d"), q.entries.map { it.item })
        assertEquals("b", current)
        assertEquals(1, tv.loads.size)
    }

    @Test
    fun `removing other songs keeps the playing one`() {
        val id = started("a", "b", "c", "d", index = 2)
        q.playing(id)
        q.remove(0, 1)
        assertEquals("c", current)
        q.remove(2, 3)
        assertEquals("c", current)
        assertEquals(listOf("b", "c"), q.entries.map { it.item })
        assertEquals(1, tv.loads.size)
    }

    @Test
    fun `removing the playing song plays the next`() {
        val id = started("a", "b", "c")
        q.playing(id, 5000)
        q.remove(0, 1)
        assertEquals("b", current)
        q.flush()
        assertEquals("b", tv.loads.last().item)
        assertEquals(0, tv.loads.last().startMs)
    }

    @Test
    fun `removing the last playing song ends the queue`() {
        val id = started("a", "b", index = 1)
        q.playing(id, 5000)
        q.remove(1, 2)
        assertEquals(CastQueue.Status.Ended, q.status)
        assertEquals(listOf("stop"), tv.calls)
        assertEquals("a", current)
    }

    @Test
    fun `clearing the queue stops the TV`() {
        val id = started("a", "b")
        q.playing(id)
        q.remove(0, 2)
        assertEquals(CastQueue.Status.Ended, q.status)
        assertEquals(listOf("stop"), tv.calls)
        assertEquals(0, q.index)
    }

    @Test
    fun `replacing the songs around the playing one keeps it`() {
        val id = started("a", "b", "c", index = 1)
        q.playing(id)
        q.replace(2, 3, listOf("z"))
        q.replace(0, 1, listOf("y"))
        assertEquals(listOf("y", "b", "z"), q.entries.map { it.item })
        assertEquals("b", current)
        assertEquals(1, tv.loads.size)
    }

    @Test
    fun `a new queue while one plays loads at once`() {
        val id = started("a")
        q.playing(id)
        q.setItems(listOf("x", "y"), 1, 0)
        q.flush()
        assertEquals("y", tv.loads.last().item)
    }

    @Test
    fun `an empty queue can be filled`() {
        q.setItems(emptyList(), -1, -1)
        q.prepare()
        assertEquals(CastQueue.Status.Ended, q.status)
        q.setPlayWhenReady(true)
        q.setItems(listOf("a"), 0, 0)
        q.flush()
        assertEquals("a", tv.loads.single().item)
        assertTrue(tv.loads.single().autoplay)
    }

    @Test
    fun `stop stops the TV and forgets the song's state`() {
        val id = started("a")
        q.playing(id, 2000)
        q.stop()
        assertEquals(listOf("stop"), tv.calls)
        assertEquals(CastQueue.Status.Idle, q.status)
        q.playing(id, 2000)
        assertEquals(CastQueue.Status.Idle, q.status)
        q.prepare()
        q.flush()
        assertEquals(2000, tv.loads.last().startMs)
    }

    @Test
    fun `speed goes to the TV and on later loads`() {
        val id = started("a", "b")
        q.playing(id)
        q.setSpeed(1.5f)
        assertEquals(listOf("speed 1.5"), tv.calls)
        q.seek(1, 0)
        q.flush()
        assertEquals(1.5f, tv.loads.last().speed)
    }

    @Test
    fun `a load that went out just before the connection dropped is sent again`() {
        val first = started("a", "b", positionMs = 4000)
        q.reconnected()
        q.flush()
        val again = tv.loads.last()
        assertEquals(2, tv.loads.size)
        assertEquals("a", again.item)
        assertEquals(4000, again.startMs)
        // The old load's answer, if it ever comes, no longer counts.
        q.onLoadResult(first, ok = false, code = 7)
        assertNull(q.errorCode)
        assertEquals(CastQueue.Status.Buffering, q.status)
    }

    @Test
    fun `reconnecting leaves a song the TV has alone`() {
        val id = started("a", "b")
        q.playing(id, 10_000)
        q.reconnected()
        q.flush()
        assertEquals(1, tv.loads.size)
        assertEquals(CastQueue.Status.Ready, q.status)
        q.playing(id, 12_000)
        assertEquals(12_000, q.positionMs())
    }

    @Test
    fun `orders lost with the connection don't stop the phone following the TV`() {
        val id = started("a")
        q.playing(id)
        tv.answerAtOnce = false
        q.setPlayWhenReady(false) // never answered
        q.reconnected()
        q.onStatus(TvStatus(TvState.Playing, positionMs = 1000, durationMs = 100_000, loadId = id))
        assertTrue(q.playWhenReady)
    }

    @Test
    fun `a song that ended during the drop moves on to the next`() {
        val id = started("a", "b")
        q.playing(id, 90_000)
        clock += 30_000 // past the end, with the phone hearing nothing
        q.reconnected()
        q.tvEmpty()
        q.flush()
        assertEquals("b", current)
        assertEquals("b", tv.loads.last().item)
        assertTrue(q.takeAutoTransition())
        assertTrue(q.playWhenReady)
    }

    @Test
    fun `a song stopped during the drop stays put, paused, and play picks it up`() {
        val id = started("a", "b")
        q.playing(id, 10_000)
        clock += 5_000
        q.reconnected()
        q.tvEmpty()
        assertEquals("a", current)
        assertFalse(q.playWhenReady)
        assertEquals(15_000, q.positionMs())
        assertEquals(CastQueue.Status.Ready, q.status)
        q.setPlayWhenReady(true)
        q.flush()
        assertEquals("a", tv.loads.last().item)
        assertEquals(15_000, tv.loads.last().startMs)
    }

    @Test
    fun `the TV being empty means nothing while a song is on its way`() {
        started("a", "b")
        q.reconnected() // a new load is waiting now
        q.tvEmpty()
        assertEquals(CastQueue.Status.Buffering, q.status)
        assertTrue(q.playWhenReady)
    }

    @Test
    fun `tells the app about the TV's reports`() {
        var changes = 0
        q.onChange = { changes++ }
        val id = started("a")
        assertEquals(0, changes)
        q.playing(id)
        assertEquals(1, changes)
    }
}
