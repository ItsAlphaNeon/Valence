package app.valence.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ListenTrackerTest {
    /** Plays [ms] of audio in 250 ms position steps starting at [from]. */
    private fun ListenTracker.play(from: Long, ms: Long, playing: Boolean = true): Long {
        var p = from
        while (p < from + ms) {
            p += 250
            position(p, playing)
        }
        return p
    }

    @Test
    fun halfTheTrackCounts() {
        val t = ListenTracker()
        t.begin("v-1", durationMs = 200_000, startPosMs = 0, wallClock = 1793765024371)
        t.play(0, 99_750)
        assertNull("just under half, stopped: nothing", t.snapshot())
        t.play(99_750, 250)
        assertEquals(PendingPlay("v-1", 1793765024371, 100_000, completed = false, skipped = false), t.snapshot())
        assertEquals(PendingPlay("v-1", 1793765024371, 100_000, completed = false, skipped = false), t.end("skipped"))
        assertNull(t.end("stopped")) // already ended
    }

    @Test
    fun fourMinutesCapLongTracks() {
        val t = ListenTracker()
        t.begin("long", durationMs = 3_600_000, startPosMs = 0, wallClock = 1)
        t.play(0, 239_750)
        assertNull(t.snapshot())
        t.play(239_750, 250)
        assertEquals(240_000, t.snapshot()!!.ms)
        assertTrue(t.end("completed")!!.completed)
    }

    @Test
    fun unknownDurationNeedsFourMinutesUnlessEngineKnows() {
        val t = ListenTracker()
        t.begin("x", durationMs = 0, startPosMs = 0, wallClock = 1)
        t.play(0, 60_000)
        assertNull(t.snapshot())
        t.setDuration(100_000) // the decoder found the length: half of it counts
        assertEquals(60_000, t.snapshot()!!.ms)
    }

    @Test
    fun skipsUnderThirtySeconds() {
        val t = ListenTracker()
        t.begin("s", durationMs = 200_000, startPosMs = 0, wallClock = 7)
        t.play(0, 29_750)
        assertEquals(PendingPlay("s", 7, 29_750, completed = false, skipped = true), t.end("skipped"))

        t.begin("s", durationMs = 200_000, startPosMs = 0, wallClock = 8)
        t.play(0, 30_000)
        assertNull("30 s or more and under the threshold: neither", t.end("skipped"))

        t.begin("s", durationMs = 200_000, startPosMs = 0, wallClock = 9)
        t.play(0, 5_000)
        assertNull("a stop is never a skip", t.end("stopped"))
        t.begin("s", durationMs = 200_000, startPosMs = 0, wallClock = 9)
        assertNull("a completed short listen is not a skip either", t.end("completed"))
    }

    @Test
    fun seeksAndPausesDoNotCount() {
        val t = ListenTracker()
        t.begin("k", durationMs = 200_000, startPosMs = 0, wallClock = 1)
        t.position(1_499, true) // under 1500 ms: counts
        t.position(2_999, true) // exactly +1500: a jump, ignored
        t.position(150_000, true) // seek by position report: ignored
        t.position(150_100, false) // paused: ignored
        t.position(150_000, true) // backwards: ignored
        assertEquals(1_499, t.end("skipped")!!.ms)

        t.begin("k", durationMs = 200_000, startPosMs = 10_000, wallClock = 1)
        t.position(10_500, true)
        t.seek(190_000)
        t.position(190_400, true)
        assertEquals(900, t.end("skipped")!!.ms)
    }

    @Test
    fun beginDiscardsPreviousListen() {
        val t = ListenTracker()
        t.begin("a", durationMs = 100_000, startPosMs = 0, wallClock = 1)
        t.play(0, 60_000)
        t.begin("b", durationMs = 100_000, startPosMs = 0, wallClock = 2)
        assertTrue(t.active)
        assertEquals(PendingPlay("b", 2, 0, completed = false, skipped = true), t.end("skipped"))
        assertFalse(t.active)
    }

    @Test(expected = IllegalArgumentException::class)
    fun rejectsUnknownReason() {
        ListenTracker().end("paused")
    }
}
