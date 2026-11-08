package app.valence.core

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class CastMessagesTest {
    private fun assemble(messages: List<String>): JSONObject {
        val parts = messages.map { JSONObject(it) }
        parts.forEachIndexed { i, p ->
            assertEquals("lyrics", p.getString("t"))
            assertEquals(i, p.getInt("part"))
            assertEquals(messages.size, p.getInt("parts"))
        }
        return JSONObject(parts.joinToString("") { it.getString("data") })
    }

    @Test
    fun `no lyrics is still one message`() {
        for (none in listOf(null, "", "  \n ")) {
            val m = CastMessages.lyrics(5, none)
            assertEquals(1, m.size)
            assertEquals(5, JSONObject(m[0]).getLong("track"))
            assertEquals(0, assemble(m).length())
        }
    }

    @Test
    fun `plain lyrics stay text`() {
        val o = assemble(CastMessages.lyrics(5, "first line\nsecond \"line\"\n"))
        assertEquals("first line\nsecond \"line\"", o.getString("text"))
        assertFalse(o.has("lines"))
    }

    @Test
    fun `synced lyrics become timed lines`() {
        val lines = assemble(CastMessages.lyrics(5, "[00:01.50]one\n[00:03.00]two\n")).getJSONArray("lines")
        assertEquals(2, lines.length())
        assertEquals(1500, lines.getJSONObject(0).getLong("t"))
        assertEquals("one", lines.getJSONObject(0).getString("x"))
        assertEquals(3000, lines.getJSONObject(1).getLong("t"))
    }

    @Test
    fun `long lyrics come back whole, and every message fits`() {
        // Each of these is worst-case in its own way: 3-byte CJK, quotes doubled twice by nesting, newlines, emoji.
        val samples = listOf(
            "歌詞".repeat(60_000),
            "\"".repeat(100_000),
            "line\n".repeat(30_000),
            "🎵".repeat(50_000),
        )
        for (text in samples) {
            val messages = CastMessages.lyrics(9, text)
            assertTrue(messages.size > 1)
            messages.forEach { assertTrue("${it.toByteArray().size} bytes", it.toByteArray().size < 60_000) }
            assertEquals(text.trim(), assemble(messages).getString("text"))
        }
    }

    @Test
    fun `lyrics too long to send are dropped`() {
        val m = CastMessages.lyrics(9, "x".repeat(CastMessages.CHUNK_CHARS * (CastMessages.MAX_PARTS + 1)))
        assertEquals(1, m.size)
        assertEquals(0, assemble(m).length())
    }

    @Test
    fun `chunks never split an emoji`() {
        val s = "a" + "🎵".repeat(50)
        val parts = CastMessages.chunks(s, 10)
        assertEquals(s, parts.joinToString(""))
        parts.forEach {
            assertFalse(it.last().isHighSurrogate())
            assertFalse(it.first().isLowSurrogate())
        }
    }

    @Test
    fun `settings and hello`() {
        val o = JSONObject(CastMessages.settings(true))
        assertEquals("settings", o.getString("t"))
        assertTrue(o.getBoolean("lyrics"))
        assertTrue(CastMessages.isHello("""{"t":"hello"}"""))
        assertFalse(CastMessages.isHello("""{"t":"other"}"""))
        assertFalse(CastMessages.isHello("not json"))
    }

    @Test
    fun `lrc parsing`() {
        assertNull(parseLrc("just words"))
        assertEquals(listOf(LyricLine(1000, "a"), LyricLine(2000, "b")), parseLrc("[00:02]b\n[00:01]a"))
        // Repeated stamps, offset tag, word stamps.
        assertEquals(
            listOf(LyricLine(900, "hi there"), LyricLine(1900, "hi there")),
            parseLrc("[offset:+100]\n[00:01][00:02]<00:01.00>hi <00:01.50>there"),
        )
    }
}
