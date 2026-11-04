package app.valence.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.math.abs
import kotlin.math.pow

class LoudnessTest {
    private fun d(v: Any?): Double? = when (v) {
        null, JsonNull -> null
        "NaN" -> Double.NaN
        "Infinity" -> Double.POSITIVE_INFINITY
        else -> v as Double
    }

    @Test
    fun rgGainMatchesDesktopGrid() {
        val cases = Golden.load("loudness.json")["cases"] as List<*>
        assertTrue(cases.size > 1000)
        for (c in cases) {
            val a = c as List<*>
            val exp = a[6] as Double
            val got = Loudness.rgGain(d(a[0]), d(a[1]), d(a[2]), d(a[3]), a[4] as String, a[5] as Boolean)
            assertTrue("$a -> $got", abs(got - exp) <= 1e-12 * maxOf(1.0, abs(exp)))
            // gain() with a 0 dB preamp is rgGain.
            assertEquals(got, Loudness.gain(d(a[0]), d(a[1]), d(a[2]), d(a[3]), a[4] as String, a[5] as Boolean, 0.0), 0.0)
        }
    }

    @Test
    fun preampIsClampedAndAppliedEvenWhenOff() {
        assertEquals(10.0.pow(6.0 / 20), Loudness.gain(null, null, null, null, "off", false, 6.0), 1e-12)
        assertEquals(10.0.pow(12.0 / 20), Loudness.gain(null, null, null, null, "off", false, 40.0), 1e-12)
        assertEquals(10.0.pow(-12.0 / 20), Loudness.gain(null, null, null, null, "track", false, -40.0), 1e-12)
        assertEquals(1.0, Loudness.gain(null, null, null, null, "track", false, Double.NaN), 0.0)
        // -6 dB track gain with +3 dB preamp: -3 dB overall.
        assertEquals(10.0.pow(-3.0 / 20), Loudness.gain(-6.0, 0.5, null, null, "track", false, 3.0), 1e-12)
        // Album mode prefers album values; auto uses them only in album context.
        assertEquals(10.0.pow(-8.0 / 20), Loudness.gain(-2.0, null, -8.0, null, "auto", true, 0.0), 1e-12)
        assertEquals(10.0.pow(-2.0 / 20), Loudness.gain(-2.0, null, -8.0, null, "auto", false, 0.0), 1e-12)
        // Peak limiting: +6 dB on a 0.9 peak is capped at 1/0.9.
        assertEquals(1 / 0.9, Loudness.rgGain(6.0, 0.9, null, null, "track", false), 1e-12)
    }

    @Test
    fun albumContextRule() {
        assertTrue(Loudness.albumContext(true, null, true, null, null))
        assertTrue(Loudness.albumContext(false, "k", false, "k", null))
        assertTrue(Loudness.albumContext(false, "k", false, null, "k"))
        assertFalse(Loudness.albumContext(false, "k", true, "k", "k"))
        assertFalse(Loudness.albumContext(false, null, false, null, null))
    }
}
