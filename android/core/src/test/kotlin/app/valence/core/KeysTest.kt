package app.valence.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class KeysTest {
    private val g = Golden.load("keys.json")

    @Test
    fun stringKeysMatchDesktop() {
        val failures = ArrayList<String>()
        for (c in g.list("strings")) {
            val input = c.str("in")!!
            fun check(what: String, expected: Any?, actual: Any?) {
                if (expected != actual) failures.add("$what(${esc(input)}): expected ${expected.let { if (it is String) esc(it) else it }} got ${actual.let { if (it is String) esc(it) else it }}")
            }
            check("cleanText", c.str("cleanText"), Keys.cleanText(input))
            check("foldKey", c.str("foldKey"), Keys.foldKey(input))
            check("matchKey", c.str("matchKey"), Keys.matchKey(input))
            check("artistFavoriteKey", c.str("artistFavoriteKey"), Keys.artistFavoriteKey(input))
            check("isVariousArtists", c.bool("isVariousArtists"), Keys.isVariousArtists(input))
            check("sanitize80", c.str("sanitize80"), Keys.sanitizeComponent(input))
            check("sanitize60", c.str("sanitize60"), Keys.sanitizeComponent(input, 60))
        }
        assertTrue(failures.joinToString("\n"), failures.isEmpty())
        assertTrue(g.list("strings").size > 150)
    }

    @Test
    fun albumKeysMatchDesktop() {
        for (c in g.list("albumKeys")) {
            val rel = c.str("relPath")!!
            assertEquals(rel, c.str("relDir"), Keys.relDirOf(rel))
            assertEquals("albumKeyFor(${esc(rel)}, ${esc(c.str("album"))}, ${esc(c.str("title"))})", c.str("key"), Keys.albumKeyFor(rel, c.str("album"), c.str("title")))
        }
    }

    @Test
    fun albumArtistsMatchDesktop() {
        for (c in g.list("albumArtists")) {
            assertEquals(c.toString(), c.str("out"), Keys.effectiveAlbumArtist(c.str("albumArtist"), c.str("artist"), c.bool("compilation")))
        }
    }

    @Test
    fun namesMatchDesktop() {
        for (c in g.list("names")) {
            val n = c.str("name")!!
            assertEquals("ignored $n", c.bool("ignored"), Keys.isIgnoredName(n))
            assertEquals("skipDir0 $n", c.bool("skipDir0"), Keys.shouldSkipDir(n, 0))
            assertEquals("skipDir1 $n", c.bool("skipDir1"), Keys.shouldSkipDir(n, 1))
            assertEquals("audio $n", c.bool("audio"), Keys.isAudioPath(n))
        }
    }

    // Ported from tests/unit/library.test.ts and favorites.test.ts.
    @Test
    fun desktopUnitCases() {
        for (n in listOf("a.sync-conflict-20250101-120000-ABCDEFG.mp3", "x.valence-tmp", "~syncthing~a.mp3.tmp", ".stfolder", "desktop.ini")) assertTrue(n, Keys.isIgnoredName(n))
        assertFalse(Keys.isIgnoredName("Song.mp3"))
        assertEquals("ABC", Keys.sanitizeComponent("A⁦B⁩C᠎"))
        assertEquals(Keys.artistFavoriteKey("  Beyoncé "), Keys.artistFavoriteKey("BEYONCÉ"))
    }

    @Test
    fun trackKeys() {
        assertEquals("v-1", Keys.trackKey("v-1", "A/b.mp3"))
        assertEquals("path:A/b.mp3", Keys.trackKey(null, "A/b.mp3"))
        assertEquals("path:A/b.mp3", Keys.trackKey("", "A/b.mp3"))
        assertTrue(Keys.isConflictCopy("Mix.SYNC-CONFLICT-20250101-120000-ABC.m3u8"))
        assertFalse(Keys.isConflictCopy("Mix.m3u8"))
        assertEquals(24, Keys.AUDIO_EXTENSIONS.size)
    }

    @Test
    fun articleQuirksNextToNonAscii() {
        // JS \b is ASCII-only: an "a" after a Cyrillic letter counts as a separate word.
        assertEquals("к", Keys.matchKey("Кa"))
        assertEquals("beatles", Keys.matchKey("The Beatles"))
        assertEquals("kaos and ethos", Keys.matchKey("Kaos & Ethos"))
    }
}
