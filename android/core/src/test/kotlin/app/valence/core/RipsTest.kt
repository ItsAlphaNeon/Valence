package app.valence.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

class RipsTest {
    @get:Rule
    val tmp = TemporaryFolder()

    private val g = Golden.load("rips.json")

    private fun season(m: Map<*, *>) = Rips.Season(m.str("key")!!, m.str("name")!!, m.str("start")!!)

    @Test
    fun seasonNumberMatchesDesktopSeasonOrder() {
        for (c in g.list("seasonOrder")) assertEquals(esc(c.str("in")), c.num("out")!!, Rips.seasonNumber(c.str("in")!!), 0.0)
    }

    @Test
    fun gameFromTitleMatchesDesktop() {
        for (c in g.list("gameFromTitle")) assertEquals(c.toString(), c.str("out"), Rips.gameFromTitle(c.str("title")!!, c.str("music")))
        // Ported from tests/unit/youtube.test.ts.
        assertEquals(
            "Phoenix Wright: Ace Attorney - Dual Destinies",
            Rips.gameFromTitle("Swashbuckler Spectacular - A Truth-Plundering Author - Phoenix Wright: Ace Attorney - Dual Destinies", "Swashbuckler Spectacular - A Truth-Plundering Author"),
        )
        assertEquals("Kirby Super Star", Rips.gameFromTitle("Gourmet Race (Beta Mix) - Kirby Super Star"))
        assertNull(Rips.gameFromTitle("Just a title"))
    }

    @Test
    fun seasonsFileMatchesDesktop() {
        for (c in g.list("seasons")) {
            val name = c.str("name")!!
            val valence = File(tmp.root, "$name/.valence")
            File(valence, "rips").mkdirs()
            c.str("content")?.let { File(valence, "rips/seasons.json").writeText(it) }
            val exp = (c["out"] as List<*>).map { season(it as Map<*, *>) }
            assertEquals(name, exp, Rips.seasons(valence))
        }
        assertEquals(Rips.DEFAULT_SEASONS, g.list("defaults").map(::season))
    }

    @Test
    fun seasonAlbumAndSeasonForMatchDesktop() {
        for (c in g.list("seasonAlbum")) assertEquals(c.str("out"), Rips.seasonAlbum(c.str("name")!!))
        assertEquals("SiIvaGunner: Season 7 – The Year of Grand Dad", Rips.DEFAULT_SEASONS[7].album)
        for (c in g.list("seasonFor")) assertEquals(c.str("in"), c.str("out"), Rips.seasonFor(c.str("in")!!, Rips.DEFAULT_SEASONS).key)
    }

    @Test
    fun seasonOrderUsesTheTableThenSeasonNumbers() {
        val table = Rips.DEFAULT_SEASONS
        assertEquals(0.0, Rips.seasonOrder("SiIvaGunner: Season 1", table), 0.0)
        assertEquals(4.0, Rips.seasonOrder("SiIvaGunner: Season 4 Episode 2", table), 0.0)
        assertEquals(10.0, Rips.seasonOrder("SiIvaGunner: Season X"), 0.0)
        assertEquals(103.0, Rips.seasonOrder("Some Season 3 compilation", table), 0.0)
        assertEquals(1100.0, Rips.seasonOrder("Rip Album", table), 0.0)
        val custom = listOf(Rips.Season("b", "Second", "2017-01-01"), Rips.Season("a", "First", "2016-01-01"))
        assertEquals(0.0, Rips.seasonOrder("SiIvaGunner: Second", custom), 0.0)
        assertEquals(101.0, Rips.seasonOrder("SiIvaGunner: Season 1", custom), 0.0)
        val titles = listOf("SiIvaGunner: Season X", "Rip Album", "SiIvaGunner: Season 2", "SiIvaGunner: Season 4 Episode 2", "SiIvaGunner: Season 4")
        assertEquals(
            listOf("SiIvaGunner: Season 2", "SiIvaGunner: Season 4", "SiIvaGunner: Season 4 Episode 2", "SiIvaGunner: Season X", "Rip Album"),
            titles.sortedBy { Rips.seasonOrder(it, table) },
        )
    }

    @Test
    fun ripFlag() {
        assertTrue(Rips.isRip("YouTube"))
        assertFalse(Rips.isRip(""))
        assertFalse(Rips.isRip(null))
        assertEquals("HIGH QUALITY RIP", Rips.TAG)
    }
}
