package app.valence.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class HlcTest {
    @Test
    fun replaysDesktopClockSequence() {
        val g = Golden.load("hlc.json")
        val ids = g["ids"] as Map<*, *>
        var tA = 0L
        var tB = 0L
        val a = Hlc(ids["A"] as String) { tA }
        val b = Hlc(ids["B"] as String) { tB }
        for (s in g.list("steps")) {
            s.num("tA")?.let { tA = it.toLong() }
            s.num("tB")?.let { tB = it.toLong() }
            val remote = s.str("remote")
            val out = when (s.str("op")) {
                "tickA" -> a.tick()
                "tickB" -> b.tick()
                "observeA" -> { a.observe(remote!!); null }
                "observeB" -> { b.observe(remote!!); null }
                else -> error("op")
            }
            assertEquals(s.toString(), s.str("out"), out)
        }
    }

    @Test
    fun decodeAndEncodeMatchDesktop() {
        val g = Golden.load("hlc.json")
        for (c in g.list("decode")) {
            val exp = c["out"] as? Map<*, *>
            val got = Hlc.decode(c.str("in")!!)
            if (exp == null) {
                assertNull(esc(c.str("in")), got)
            } else {
                assertEquals(esc(c.str("in")), Hlc.Stamp((exp["ms"] as Double).toLong(), (exp["c"] as Double).toLong(), exp["d"] as String), got)
            }
        }
        for (c in g.list("encode")) {
            assertEquals(c.str("out"), Hlc.encode(c.num("ms")!!.toLong(), c.num("c")!!.toLong(), c.str("d")!!))
        }
    }

    // Ported from tests/unit/library.test.ts "HLC is monotonic and observes remote clocks".
    @Test
    fun monotonicAndObservesRemote() {
        var now = 1000L
        val c = Hlc("aaaaaaaaaaaa") { now }
        val a = c.tick()
        val b = c.tick()
        assertTrue(b > a)
        now = 500 // clock went backwards
        assertTrue(c.tick() > b)
        val remote = Hlc("bbbbbbbbbbbb") { 99999 }.tick()
        c.observe(remote)
        assertTrue(c.tick() > remote)
    }

    @Test
    fun ordersAcrossDevicesAndSkew() {
        var phone = 1_793_765_000_000L
        var desk = phone + 3_600_000 // desktop clock an hour ahead
        val p = Hlc("aaaaaaaaaaaa0001") { phone }
        val d = Hlc("bbbbbbbbbbbb0002") { desk }
        val d1 = d.tick()
        // Before seeing d1, the phone's events sort before it (its clock is behind).
        val p0 = p.tick()
        assertTrue(p0 < d1)
        p.observe(d1)
        val p1 = p.tick()
        assertTrue("a toggle after seeing a remote one sorts after it", p1 > d1)
        // Same ms and counter on two devices: the device id breaks the tie, deterministically.
        val x = Hlc("aaaaaaaaaaaa0001") { 5 }.tick()
        val y = Hlc("bbbbbbbbbbbb0002") { 5 }.tick()
        assertTrue(x < y)
        // A phone whose clock jumps far back keeps counting after what it last issued.
        phone = 1
        val p2 = p.tick()
        assertTrue(p2 > p1)
        assertEquals(Hlc.decode(p1)!!.ms, Hlc.decode(p2)!!.ms)
        // The desktop observing the phone's newest stamp continues after it too.
        desk = 0
        d.observe(p2)
        assertTrue(d.tick() > p2)
        // Garbage is ignored.
        val before = p.last
        p.observe("not an hlc")
        p.observe("ABC-0000-x")
        assertEquals(before, p.last)
        assertEquals(-1, Hlc.compare("0-0-a", "0-0-b"))
    }

    @Test
    fun lastStartsAtZero() {
        assertEquals("000000000-0000-aaaaaaaaaaaa", Hlc("aaaaaaaaaaaa") { 0 }.last)
        assertEquals("000000000-0001-aaaaaaaaaaaa", Hlc("aaaaaaaaaaaa") { 0 }.tick())
    }
}
