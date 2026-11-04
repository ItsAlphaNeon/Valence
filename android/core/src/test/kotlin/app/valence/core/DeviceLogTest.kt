package app.valence.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

class DeviceLogTest {
    @get:Rule
    val tmp = TemporaryFolder()

    private val id = "aaaaaaaaaaaa0001"

    @Test
    fun playLinesAreByteIdenticalToDesktop() {
        val valence = tmp.newFolder(".valence")
        // The spec's sample line: {"hlc":"0mw1lds8d-0000-<id>","k":"66f3…","at":1793765024371,"ms":387,"c":0,"s":1}
        val hlc = Hlc(id) { Hlc.decode("0mw1lds8d-0000-x")!!.ms } // logged when the listen ended, after `at`
        val log = DeviceLog(valence, id, hlc, appVersion = "test")
        val ev = log.appendPlay("66f343d2-8370-43c5-b699-b3315a3b995d", 1793765024371, 387, completed = false, skipped = true)
        val file = File(valence, "devices/$id/plays-2026-11.jsonl")
        assertEquals(
            "{\"hlc\":\"0mw1lds8d-0000-$id\",\"k\":\"66f343d2-8370-43c5-b699-b3315a3b995d\",\"at\":1793765024371,\"ms\":387,\"c\":0,\"s\":1}\n",
            file.readText(),
        )
        assertEquals(PlayEvent("0mw1lds8d-0000-$id", id, "66f343d2-8370-43c5-b699-b3315a3b995d", 1793765024371, 387, false, true), ev)
        // Month comes from `at` in UTC.
        log.appendPlay("x", 1793491199999, 1, completed = true, skipped = false) // 2026-10-31T23:59:59.999Z
        assertTrue(File(valence, "devices/$id/plays-2026-10.jsonl").exists())
    }

    @Test
    fun keysAreEscapedLikeJsonStringify() {
        val g = Golden.load("json.json")
        for (c in g.list("events")) {
            val line = linkedMapOf<String, Any?>("hlc" to "0mw1lds8d-0000-aaaaaaaaaaaa0001", "k" to c.str("k"), "at" to 1793765024371L, "ms" to 387L, "c" to 0, "s" to 1)
            assertEquals(c.str("line"), JsJson.stringify(line))
        }
        assertEquals(g.str("deviceJson"), JsJson.stringify(linkedMapOf("id" to id, "platform" to "android", "lastSeen" to "2026-11-04T04:02:16.536Z", "appVersion" to "0.1.0 \"beta\""), 1))
    }

    @Test
    fun favoriteLinesMatchDesktop() {
        val valence = tmp.newFolder(".valence")
        var now = 1793765328000L
        val log = DeviceLog(valence, id, Hlc(id) { now }, appVersion = "test")
        log.appendFavorite("t", "387bc1bd-fd8c-495e-9230-431716b91784", true)
        now += 5
        val moved = log.appendFavorites("t", listOf("path:New/Song.mp3", "v-2"), true, at = 1700000000000)
        val text = File(valence, "devices/$id/favorites.jsonl").readText()
        assertEquals(
            "{\"hlc\":\"${Hlc.encode(1793765328000, 0, id)}\",\"kind\":\"t\",\"k\":\"387bc1bd-fd8c-495e-9230-431716b91784\",\"on\":1}\n" +
                "{\"hlc\":\"${Hlc.encode(1793765328005, 0, id)}\",\"kind\":\"t\",\"k\":\"path:New/Song.mp3\",\"on\":1,\"at\":1700000000000}\n" +
                "{\"hlc\":\"${Hlc.encode(1793765328005, 1, id)}\",\"kind\":\"t\",\"k\":\"v-2\",\"on\":1,\"at\":1700000000000}\n",
            text,
        )
        assertEquals(1700000000000, moved[0].effectiveAt())
        assertEquals(1793765328000, FavoriteEvent(Hlc.encode(1793765328000, 0, id), id, "t", "k", true, null).effectiveAt())
    }

    @Test(expected = IllegalArgumentException::class)
    fun rejectsBadKind() {
        DeviceLog(tmp.newFolder(".valence"), id, Hlc(id), appVersion = "t").appendFavorite("x", "k", true)
    }

    @Test
    fun deviceJsonAndNomedia() {
        val valence = tmp.newFolder(".valence")
        val log = DeviceLog(valence, id, Hlc(id), appVersion = "0.1.0")
        log.touchDeviceJson(now = java.time.Instant.parse("2026-11-04T04:02:16.536Z").toEpochMilli())
        assertEquals(
            "{\n \"id\": \"$id\",\n \"platform\": \"android\",\n \"lastSeen\": \"2026-11-04T04:02:16.536Z\",\n \"appVersion\": \"0.1.0\"\n}",
            File(valence, "devices/$id/device.json").readText(),
        )
        assertTrue(File(valence, ".nomedia").exists())
        assertEquals(0, File(valence, ".nomedia").length())
        assertFalse(File(valence, "devices/$id/device.json.valence-tmp").exists())
    }

    @Test
    fun containsPlayFindsResentListen() {
        val valence = tmp.newFolder(".valence")
        val log = DeviceLog(valence, id, Hlc(id), appVersion = "t")
        assertFalse(log.containsPlay("v-1", 1793765024371))
        log.appendPlay("v-1", 1793765024371, 200000, completed = true, skipped = false)
        assertTrue(log.containsPlay("v-1", 1793765024371))
        assertFalse(log.containsPlay("v-1", 1793765024372))
    }

    @Test
    fun deviceIds() {
        val n = DeviceLog.newDeviceId()
        assertEquals(16, n.length)
        assertTrue(DeviceLog.isValidDeviceId(n))
        assertTrue(DeviceLog.isValidDeviceId("4db16eb62e0fd3e6"))
        assertFalse(DeviceLog.isValidDeviceId("short"))
        assertFalse(DeviceLog.isValidDeviceId("ABCDEF0123456789"))
        assertFalse(DeviceLog.isValidDeviceId("../../etc/passwd0"))
    }
}
