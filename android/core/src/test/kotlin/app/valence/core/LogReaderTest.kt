package app.valence.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

class LogReaderTest {
    @get:Rule
    val tmp = TemporaryFolder()

    private val fixture: File get() = Golden.resourceDir("/fixtures/logs/.valence")

    /** The desktop's favorites table, in memory: last-writer-wins by HLC string. */
    private class FavTable {
        data class Row(val liked: Boolean, val hlc: String, val at: Long)

        val rows = sortedMapOf<String, Row>()

        fun apply(batch: List<FavoriteEvent>, now: Long = 0): Int {
            var n = 0
            for (e in batch) {
                val key = "${e.kind}|${e.key}"
                val cur = rows[key]
                if (cur == null || e.hlc > cur.hlc) {
                    rows[key] = Row(e.on, e.hlc, e.effectiveAt(now))
                    n++
                }
            }
            return n
        }
    }

    @Test
    fun ingestMatchesDesktopOnFixture() {
        val g = Golden.load("logs.json")
        val store = InMemoryCursorStore()
        val reader = LogReader(fixture, store)

        val plays = reader.newPlays()
        val expected = g.list("plays")
        assertEquals((g["nPlays"] as Double).toInt(), plays.size)
        assertEquals(expected.map { it.str("hlc") + "|" + it.str("device_id") }, plays.map { it.hlc + "|" + it.device })
        for ((e, p) in expected.zip(plays)) {
            assertEquals(e.str("track_key"), p.trackKey)
            assertEquals(e.str("hlc"), e.num("played_at")!!.toLong(), p.at)
            // Desktop stores Infinity for "ms":"Infinity" (JSON null here); the port stores 0.
            assertEquals(e.str("hlc"), e.num("ms")?.toLong() ?: 0L, p.ms)
            assertEquals(e.str("hlc"), e.num("completed") == 1.0, p.completed)
            assertEquals(e.str("hlc"), e.num("skipped") == 1.0, p.skipped)
        }

        val favs = reader.newFavorites()
        val table = FavTable()
        val changed = table.apply(favs)
        val expFavs = g.list("favorites").associate { "${it.str("kind")}|${it.str("item_key")}" to FavTable.Row(it.num("liked") == 1.0, it.str("hlc")!!, it.num("at")!!.toLong()) }
        assertEquals(expFavs.toSortedMap(), table.rows)
        assertEquals((g["nFavs"] as Double).toInt(), changed)

        // Cursors: nothing moves until commit; then exactly the desktop's offsets.
        assertTrue(store.snapshot().isEmpty())
        plays.commit()
        favs.commit()
        val expCursors = g.list("cursors").associate { it.str("file")!! to it.num("offset")!!.toLong() }
        assertEquals(expCursors, store.snapshot())

        // The desktop's favorites clock observed the newest applied HLC; same with Hlc.observe(maxHlc).
        val clock = Hlc("ffffffffffff0009") { 1 }
        clock.observe(favs.maxHlc!!)
        assertEquals(g.str("clockAfterIngest"), clock.tick())

        // Second pass: nothing new.
        assertTrue(reader.newPlays().isEmpty())
        assertTrue(reader.newFavorites().isEmpty())
    }

    @Test
    fun uncommittedBatchIsReadAgain() {
        val reader = LogReader(fixture, InMemoryCursorStore())
        val first = reader.newPlays()
        val again = reader.newPlays()
        assertEquals(first.events, again.events)
        again.commit()
        again.commit() // idempotent
        assertTrue(again.committed)
        assertTrue(reader.newPlays().isEmpty())
    }

    // Ported from tests/unit/library.test.ts "reads device logs incrementally, ignoring partial trailing lines".
    @Test
    fun partialTrailingLineWaitsForItsNewline() {
        val valence = tmp.newFolder(".valence")
        val a = DeviceLog(valence, "deva00000000", Hlc("deva00000000"), appVersion = "t")
        val b = DeviceLog(valence, "devb00000000", Hlc("devb00000000"), appVersion = "t")
        a.appendPlay("x", System.currentTimeMillis(), 1, false, false)
        b.appendPlay("y", System.currentTimeMillis(), 1, false, false)
        val reader = LogReader(valence, InMemoryCursorStore())
        reader.newPlays().also { assertEquals(2, it.size) }.commit()
        assertEquals(0, reader.newPlays().size)
        val file = b.dir.listFiles()!!.first { it.name.startsWith("plays") }
        file.appendText("{\"hlc\":\"zzz\",\"k\":\"partial\"")
        reader.newPlays().also { assertEquals(0, it.size) }.commit()
        file.appendText("}\n")
        val evs = reader.newPlays()
        assertEquals(listOf("partial"), evs.map { it.trackKey })
        assertEquals("devb00000000", evs.single().device)
    }

    @Test
    fun partialMultibyteLineAndCursorInBytes() {
        val valence = tmp.newFolder(".valence")
        val dir = File(valence, "devices/aaaaaaaaaaaa0001").apply { mkdirs() }
        val f = File(dir, "plays-2026-11.jsonl")
        val line1 = "{\"hlc\":\"0mw1lds8d-0000-aaaaaaaaaaaa0001\",\"k\":\"ünï 😀\",\"at\":1,\"ms\":2,\"c\":1,\"s\":0}\n"
        val line2 = "{\"hlc\":\"0mw1lds8e-0000-aaaaaaaaaaaa0001\",\"k\":\"二\",\"at\":1,\"ms\":2,\"c\":1,\"s\":0}\n"
        val bytes2 = line2.toByteArray()
        f.writeBytes(line1.toByteArray() + bytes2.copyOfRange(0, 47)) // cut inside the multibyte key
        val store = InMemoryCursorStore()
        val reader = LogReader(valence, store)
        reader.newPlays().also { assertEquals(listOf("ünï 😀"), it.map { e -> e.trackKey }) }.commit()
        assertEquals(line1.toByteArray().size.toLong(), store.get("aaaaaaaaaaaa0001", "plays-2026-11.jsonl"))
        f.appendBytes(bytes2.copyOfRange(47, bytes2.size))
        assertEquals(listOf("二"), reader.newPlays().map { it.trackKey })
    }

    @Test
    fun shrunkFileIsReadFromStart() {
        val valence = tmp.newFolder(".valence")
        val log = DeviceLog(valence, "aaaaaaaaaaaa0001", Hlc("aaaaaaaaaaaa0001"), appVersion = "t")
        for (i in 0 until 5) log.appendPlay("k$i", 1793765024371, 1000, true, false)
        val store = InMemoryCursorStore()
        val reader = LogReader(valence, store)
        reader.newPlays().also { assertEquals(5, it.size) }.commit()
        // Syncthing replaced the file with a shorter version (e.g. restored from another copy).
        val f = File(log.dir, "plays-2026-11.jsonl")
        val keep = f.readLines().take(2).joinToString("\n", postfix = "\n")
        f.writeText(keep)
        val again = reader.newPlays()
        assertEquals(listOf("k0", "k1"), again.map { it.trackKey }) // re-read; idempotent inserts absorb it
        again.commit()
        assertEquals(keep.toByteArray().size.toLong(), store.get("aaaaaaaaaaaa0001", "plays-2026-11.jsonl"))
    }

    @Test
    fun twoDevicesMergeInHlcOrderAndConverge() {
        val valence = tmp.newFolder(".valence")
        var tA = 1_000_000L
        var tB = 1_000_000L
        val clockA = Hlc("deva0000000000") { tA }
        val clockB = Hlc("devb0000000000") { tB }
        val logA = DeviceLog(valence, "deva0000000000", clockA, appVersion = "t")
        val logB = DeviceLog(valence, "devb0000000000", clockB, appVersion = "t")
        val readerA = LogReader(valence, InMemoryCursorStore())
        val readerB = LogReader(valence, InMemoryCursorStore())
        val tableA = FavTable()
        val tableB = FavTable()
        fun ingest(r: LogReader, t: FavTable, c: Hlc): Int {
            val batch = r.newFavorites()
            val n = t.apply(batch)
            batch.commit()
            batch.maxHlc?.let(c::observe)
            return n
        }
        // Ported from tests/unit/favorites.test.ts.
        tableA.apply(listOf(logA.appendFavorite("t", "v-1", true)))
        assertEquals(1, ingest(readerB, tableB, clockB))
        assertEquals(true, tableB.rows["t|v-1"]!!.liked)
        assertEquals(0, ingest(readerB, tableB, clockB))
        assertEquals(0, ingest(readerA, tableA, clockA)) // own events read back change nothing
        tB += 10_000
        tableB.apply(listOf(logB.appendFavorite("t", "v-1", false)))
        assertEquals(1, ingest(readerA, tableA, clockA))
        assertEquals(false, tableA.rows["t|v-1"]!!.liked)
        // Concurrent toggles: the later HLC wins on both devices.
        tA += 50_000
        tB += 20_000
        tableA.apply(listOf(logA.appendFavorite("a", "album-x", true)))
        tableB.apply(listOf(logB.appendFavorite("a", "album-x", true)))
        tableB.apply(listOf(logB.appendFavorite("a", "album-x", false))) // B's clock is behind A's
        ingest(readerA, tableA, clockA)
        ingest(readerB, tableB, clockB)
        assertEquals(true, tableA.rows["a|album-x"]!!.liked)
        assertEquals(true, tableB.rows["a|album-x"]!!.liked)
        // A toggle after seeing everything sorts last, even with B's clock far behind.
        tB = 5
        tableB.apply(listOf(logB.appendFavorite("a", "album-x", false)))
        ingest(readerA, tableA, clockA)
        assertEquals(false, tableA.rows["a|album-x"]!!.liked)
        assertEquals(false, tableB.rows["a|album-x"]!!.liked)
        assertEquals(tableA.rows, tableB.rows)

        // Plays from both devices arrive merged in HLC order.
        logA.appendPlay("pa", 1793765024371, 1, true, false)
        logB.appendPlay("pb", 1793765024371, 1, true, false)
        val plays = LogReader(valence, InMemoryCursorStore()).newPlays()
        assertEquals(plays.map { it.hlc }.sorted(), plays.map { it.hlc })
        assertEquals(setOf("deva0000000000", "devb0000000000"), plays.map { it.device }.toSet())
    }

    @Test
    fun emptyOrMissingFolders() {
        val reader = LogReader(File(tmp.root, "nope"), InMemoryCursorStore())
        assertTrue(reader.newPlays().isEmpty())
        assertNull(reader.newFavorites().maxHlc)
        assertFalse(reader.newPlays().committed)
    }
}
