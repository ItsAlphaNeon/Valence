package app.valence.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

class M3u8Test {
    @get:Rule
    val tmp = TemporaryFolder()

    private val g = Golden.load("m3u.json")

    private fun expectedEntries(out: Any?): List<M3u8.Entry> = (out as List<*>).map {
        val m = it as Map<*, *>
        val dur = m.num("durationSec")?.let { d -> Js.round(d).coerceAtMost(Int.MAX_VALUE.toDouble()).toInt() }
        M3u8.Entry(m.str("relPath")!!, m.str("title"), dur)
    }

    @Test
    fun parseMatchesDesktop() {
        for (c in g.list("parse")) {
            val got = M3u8.parse(c.str("text")!!, c.str("playlist")!!, c.str("root"))
            assertEquals("${esc(c.str("text"))} root=${c.str("root")}", expectedEntries(c["out"]), got)
        }
    }

    @Test
    fun renderMatchesDesktop() {
        for (c in g.list("write")) {
            val entries = c.list("tracks").map { t ->
                if (t.containsKey("title")) M3u8.entry(t.str("relPath")!!, t.str("artist")!!, t.str("title")!!, t.num("durationMs")!!.toLong())
                else M3u8.Entry(t.str("relPath")!!)
            }
            assertEquals(c.str("playlist"), c.str("out"), M3u8.render(c.str("playlist")!!, entries))
        }
    }

    @Test
    fun posixMatchesNode() {
        for (c in g.list("relative")) {
            val to = c.str("to")!!
            if (to.startsWith("../")) continue // Node resolves those against the real cwd; library paths never climb
            assertEquals("relative(${c.str("from")}, $to)", c.str("out"), Posix.relative(c.str("from")!!, to))
        }
        for (c in g.list("normalize")) assertEquals("normalize(${c.str("in")})", c.str("out"), Posix.normalize(c.str("in")!!))
        for (c in g.list("dirname")) assertEquals("dirname(${c.str("in")})", c.str("out"), Posix.dirname(c.str("in")!!))
        for (c in g.list("join")) assertEquals("join(${c.str("a")}, ${c.str("b")})", c.str("out"), Posix.join(c.str("a")!!, c.str("b")!!))
    }

    @Test
    fun unionMatchesDesktop() {
        val u = g["union"] as Map<*, *>
        fun entries(k: String) = (u[k] as List<*>).map { M3u8.Entry((it as Map<*, *>).str("relPath")!!) }
        assertEquals(entries("out"), M3u8.unionMerge(entries("a"), entries("b")))
    }

    // Ported from tests/unit/library.test.ts "m3u round-trips relative paths".
    @Test
    fun roundTripsRelativePaths() {
        val text = M3u8.render("Playlists/Mix.m3u8", listOf(M3u8.Entry("A/B (2020)/C.mp3", "A - C", 200)))
        assertEquals("#EXTM3U\n#EXTINF:200,A - C\n../A/B (2020)/C.mp3\n", text)
        assertEquals(listOf(M3u8.Entry("A/B (2020)/C.mp3", "A - C", 200)), M3u8.parse(text, "Playlists/Mix.m3u8"))
        assertEquals(listOf(M3u8.Entry("A/b.mp3")), M3u8.parse("C:\\Users\\x\\Music\\A\\b.mp3\r\n", "Playlists/x.m3u", "C:\\Users\\x\\Music"))
    }

    @Test
    fun fileRoundTripIsAtomicAndExact() {
        val root = tmp.newFolder("Music")
        val file = File(root, "Playlists/Raveee.m3u8")
        val entries = listOf(
            M3u8.entry("ElyOtto/SugarCrash! (2020)/SugarCrash!.mp3", "ElyOtto", "SugarCrash!", 80_400),
            M3u8.entry("S3RL/The Bass & the Melody (2020)/The Bass & the Melody.mp3", "S3RL", "The Bass & the Melody", 186_000),
            M3u8.Entry("Unknown/Not here.mp3"),
            M3u8.entry("Ünï/😀 (2021)/Ωmega.flac", "Ünï", "Ωmega", 1_500),
        )
        M3u8.write(file, root, entries)
        assertEquals(
            "#EXTM3U\n" +
                "#EXTINF:80,ElyOtto - SugarCrash!\n../ElyOtto/SugarCrash! (2020)/SugarCrash!.mp3\n" +
                "#EXTINF:186,S3RL - The Bass & the Melody\n../S3RL/The Bass & the Melody (2020)/The Bass & the Melody.mp3\n" +
                "../Unknown/Not here.mp3\n" +
                "#EXTINF:2,Ünï - Ωmega\n../Ünï/😀 (2021)/Ωmega.flac\n",
            file.readText(),
        )
        assertFalse(File(file.path + ".valence-tmp").exists())
        assertEquals(entries, M3u8.read(file, root))
        // A phone player's absolute path under the same root maps back into the library.
        File(root, "Playlists/Abs.m3u8").writeText("${root.absolutePath}${File.separator}A${File.separator}b.mp3\n/elsewhere/c.mp3\n")
        assertEquals(listOf(M3u8.Entry("A/b.mp3")), M3u8.read(File(root, "Playlists/Abs.m3u8"), root))
        assertEquals("Playlists/Raveee.m3u8", M3u8.relPathOf(file, root))
    }

    @Test
    fun helpers() {
        assertEquals("Mix.m3u8", M3u8.conflictBaseName("Mix.sync-conflict-20250101-120000-ABCDEFG.m3u8"))
        assertTrue(M3u8.isPlaylistFile("Mix.M3U8"))
        assertTrue(M3u8.isPlaylistFile("old.m3u"))
        assertFalse(M3u8.isPlaylistFile("Mix.m3u8.valence-tmp"))
        assertTrue(M3u8.staticId("Playlists/Hyperpop.m3u8").matches(Regex("m3u-[0-9a-f]{16}")))
        assertEquals(M3u8.staticId("playlists/hyperpop.m3u8"), M3u8.staticId("Playlists/Hyperpop.m3u8"))
        assertEquals("m3u-1b270ed25bb6cd84", M3u8.staticId("Playlists/Mix.m3u8")) // node: sha1 of foldKey
        assertEquals("m3u-284bc73b4c4bef71", M3u8.staticId("Playlists/Ünï 😀.m3u8"))
        assertNull(M3u8.decodeURIComponent("%E0%A4%A"))
        assertNull(M3u8.decodeURIComponent("%C0%AF")) // overlong
        assertEquals("ü b+c", M3u8.decodeURIComponent("%C3%BC%20b+c"))
        assertEquals(emptyList<M3u8.Entry>(), M3u8.parse("file:///C:/Music/%ZZ.mp3\n", "Playlists/x.m3u8", "C:/Music"))
    }
}
