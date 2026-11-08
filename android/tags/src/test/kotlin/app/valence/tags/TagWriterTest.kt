package app.valence.tags

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File
import java.io.RandomAccessFile

class TagWriterTest {
    @get:Rule val tmp = TemporaryFolder()

    private val editable = listOf(
        "desktop_v23.mp3", "handmade_v24.mp3", "id3v1_only.mp3", "cbr_noxing.mp3", "vbr_xing.mp3",
        "desktop.flac", "desktop.ogg", "desktop.opus", "desktop_aac.m4a", "desktop_alac.m4a",
    )

    private fun copy(name: String): File = TagReaderTest.fixture(name).copyTo(File(tmp.root, name), overwrite = true)

    private val full = TagEdit(
        mapOf(
            TagField.TITLE to "Ünïcødé – 日本語のタイトル",
            TagField.ARTIST to "New Artist",
            TagField.ALBUM to "  Merged Album  ",
            TagField.ALBUM_ARTIST to "Säde & Co",
            TagField.GENRE to "Vaporwave",
            TagField.COMPOSER to null,
            TagField.DATE to "2021-06-15",
            TagField.TRACK_NO to "3",
            TagField.TRACK_TOTAL to "12",
            TagField.DISC_NO to "1",
            TagField.DISC_TOTAL to "2",
        ),
    )

    /** Everything the editor doesn't touch, for before/after comparisons. */
    private fun untouched(t: TrackTags) = t.copy(
        title = null, artist = null, artists = emptyList(), album = null, albumArtist = null, genre = null, composer = null,
        date = null, trackNo = null, trackTotal = null, discNo = null, discTotal = null,
        custom = t.custom.filterKeys { k ->
            k !in setOf("TITLE", "ARTIST", "ALBUM", "ALBUMARTIST", "ALBUM ARTIST", "GENRE", "COMPOSER", "DATE", "TRACKNUMBER", "TRACKTOTAL", "TOTALTRACKS", "DISCNUMBER", "DISCTOTAL", "TOTALDISCS")
        },
    )

    @Test
    fun everyEditableFixtureTakesAFullEdit() {
        for (name in editable) {
            val src = copy(name)
            val srcBytes = src.readBytes()
            val before = TagReader.read(src)
            val dst = File(tmp.root, "$name.out")
            TagWriter.writeVerified(src, dst, full)
            assertArrayEquals("$name: the original must not change", srcBytes, src.readBytes())
            val after = TagReader.read(dst)
            val t = after.tags
            assertEquals(name, "Ünïcødé – 日本語のタイトル", t.title)
            assertEquals(name, "New Artist", t.artist)
            assertEquals(name, "Merged Album", t.album)
            assertEquals(name, "Säde & Co", t.albumArtist)
            assertEquals(name, "Vaporwave", t.genre)
            assertNull(name, t.composer)
            assertEquals(name, "2021-06-15", t.date)
            assertEquals(name, 3, t.trackNo)
            assertEquals(name, 12, t.trackTotal)
            assertEquals(name, 1, t.discNo)
            assertEquals(name, 2, t.discTotal)
            assertEquals(name, untouched(before.tags), untouched(t))
            assertEquals(name, before.info.copy(bitrate = 0), after.info.copy(bitrate = 0))
            assertEquals(name, before.picture != null, after.picture != null)
            if (before.picture != null) {
                assertArrayEquals(name, TagReader.readPicture(src, before.picture!!), TagReader.readPicture(dst, after.picture!!))
            }
            // A second edit on the result works too, and can clear what the first one set.
            val dst2 = File(tmp.root, "$name.out2")
            TagWriter.writeVerified(dst, dst2, TagEdit(mapOf(TagField.GENRE to "", TagField.TRACK_TOTAL to null, TagField.DATE to "1999")))
            val t2 = TagReader.read(dst2).tags
            assertNull(name, t2.genre)
            assertEquals(name, 3, t2.trackNo)
            assertNull(name, t2.trackTotal)
            assertEquals(name, "1999", t2.date)
            assertEquals(name, "Merged Album", t2.album)
        }
    }

    @Test
    fun aSmallEditKeepsTheAudioWhereItWas() {
        // Room in the old tag (padding) means the audio doesn't move.
        for (name in listOf("desktop_v23.mp3", "desktop.flac")) {
            val src = copy(name)
            val dst = File(tmp.root, "$name.out")
            TagWriter.writeVerified(src, dst, TagEdit(mapOf(TagField.ALBUM to "A")))
            assertEquals(name, src.length(), dst.length())
        }
        // These M4As keep moov after the audio, so moov can change size freely.
        for (name in listOf("desktop_aac.m4a", "desktop_alac.m4a")) {
            val src = copy(name)
            val dst = File(tmp.root, "$name.out")
            TagWriter.writeVerified(src, dst, TagEdit(mapOf(TagField.ALBUM to "A much longer album name than before")))
            val before = RandomAccessFile(src, "r").use { Mp4Writer.mdatRanges(it) }
            val after = RandomAccessFile(dst, "r").use { Mp4Writer.mdatRanges(it) }
            assertEquals(name, before, after)
        }
    }

    @Test
    fun aBigEditMovesTheAudioSafely() {
        val big = "Long album name ".repeat(250).trim()
        for (name in editable) {
            val src = copy(name)
            val dst = File(tmp.root, "$name.big")
            TagWriter.writeVerified(src, dst, TagEdit(mapOf(TagField.ALBUM to big, TagField.TITLE to big, TagField.ARTIST to big)))
            val t = TagReader.read(dst).tags
            assertEquals(name, big, t.album)
            assertEquals(name, big, t.title)
            assertNotEquals(name, src.length(), dst.length())
        }
    }

    @Test
    fun oggPagesAreRenumberedWhenTheHeaderGrows() {
        for (name in listOf("desktop.opus", "desktop.ogg")) {
            val src = copy(name)
            val dst = File(tmp.root, "$name.huge")
            val huge = "x".repeat(200_000) // several header pages more than before
            val changes = Changes(mapOf(TagField.ALBUM to huge), null, null)
            val written = RandomAccessFile(src, "r").use { raf -> dst.outputStream().buffered().use { OggWriter.write(raf, it, changes) } }
            TagVerifier.verify(TagWriter.Kind.OGG, src, dst, changes, written)
            assertEquals(name, huge, TagReader.read(dst).tags.album)
            val pagesBefore = RandomAccessFile(src, "r").use { OggWriter.headers(it).pages }
            val pagesAfter = RandomAccessFile(dst, "r").use { OggWriter.headers(it).pages }
            assertTrue("$name: $pagesBefore -> $pagesAfter", pagesAfter > pagesBefore)
        }
    }

    @Test
    fun onlyTheTotalChanges() {
        val src = copy("desktop_v23.mp3")
        val before = TagReader.read(src).tags
        val dst = File(tmp.root, "out.mp3")
        TagWriter.writeVerified(src, dst, TagEdit(mapOf(TagField.TRACK_TOTAL to "20")))
        val t = TagReader.read(dst).tags
        assertEquals(before.trackNo, t.trackNo)
        assertEquals(20, t.trackTotal)
        assertEquals(before.copy(trackTotal = 20), t)
    }

    @Test
    fun anId3v1OnlyFileGetsAnId3v2Tag() {
        val src = copy("id3v1_only.mp3")
        val dst = File(tmp.root, "out.mp3")
        TagWriter.writeVerified(src, dst, TagEdit(mapOf(TagField.ALBUM to "New")))
        val b = dst.readBytes()
        assertEquals("ID3", String(b, 0, 3, Charsets.ISO_8859_1))
        assertEquals(3, b[3].toInt())
        assertEquals("TAG", String(b, b.size - 128, 3, Charsets.ISO_8859_1))
        assertEquals("New", TagReader.read(dst).tags.album)
    }

    @Test
    fun filesTheWriterCantHandleAreRefused() {
        val cases = mapOf(
            "handmade_v22.mp3" to "ID3v2.2",
            "handmade_v23_unsync.mp3" to "unsynchronised",
            "pcm.wav" to "WAV",
            "pcm.aiff" to "WAV",
        )
        for ((name, words) in cases) {
            val src = copy(name)
            val dst = File(tmp.root, "$name.out")
            try {
                TagWriter.writeVerified(src, dst, TagEdit(mapOf(TagField.ALBUM to "x")))
                fail("$name should be refused")
            } catch (e: TagWriteException) {
                assertTrue("$name: ${e.message}", e.message!!.contains(words))
            }
            assertTrue("$name: no output left behind", !dst.exists())
        }
        assertNull(TagWriter.unsupportedReason(TagReaderTest.fixture("desktop.opus")))
        assertTrue(TagWriter.unsupportedReason(TagReaderTest.fixture("pcm.wav"))!!.contains("WAV"))
    }

    @Test
    fun badValuesAreRejectedUpFront() {
        assertEquals("Use a whole number from 1 to 65535", TagEdit.problem(TagField.TRACK_NO, "three"))
        assertEquals("Use a year (2024) or a date (2024-05-31)", TagEdit.problem(TagField.DATE, "May 2024"))
        assertNull(TagEdit.problem(TagField.DATE, "2024-05"))
        assertNull(TagEdit.problem(TagField.ALBUM, ""))
        try {
            TagEdit(mapOf(TagField.DISC_NO to "0"))
            fail("disc 0 should be refused")
        } catch (e: IllegalArgumentException) {
            // expected
        }
    }

    @Test
    fun anId3v23YearMonthKeepsJustTheYear() {
        val src = copy("desktop_v23.mp3")
        val dst = File(tmp.root, "out.mp3")
        TagWriter.writeVerified(src, dst, TagEdit(mapOf(TagField.DATE to "2020-03")))
        assertEquals("2020", TagReader.read(dst).tags.date)
    }

    @Test
    fun anEditTheFileAlreadyHasIsNoticed() {
        for (name in editable) {
            val src = copy(name)
            val t = TagReader.read(src).tags
            val same = TagEdit(mapOf(TagField.ALBUM to t.album, TagField.ARTIST to t.artist, TagField.TRACK_NO to t.trackNo?.toString()))
            assertTrue(name, same.isAppliedIn(t))
            assertTrue(name, TagEdit(mapOf(TagField.ALBUM to "  ${t.album ?: ""} ")).isAppliedIn(t))
            assertFalse(name, TagEdit(mapOf(TagField.ALBUM to "${t.album} (Deluxe)")).isAppliedIn(t))
            // After a write, the same edit is already applied.
            val dst = File(tmp.root, "again-$name")
            TagWriter.writeVerified(src, dst, full)
            assertTrue(name, full.isAppliedIn(TagReader.read(dst).tags))
        }
    }
}
