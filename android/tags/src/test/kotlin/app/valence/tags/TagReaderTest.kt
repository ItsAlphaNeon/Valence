package app.valence.tags

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.File
import java.security.MessageDigest
import kotlin.math.abs

/** Compares every fixture with how the desktop (music-metadata + mapTags) read it: expected.json. */
class TagReaderTest {
    companion object {
        val dir: File = File(TagReaderTest::class.java.getResource("/fixtures/expected.json")!!.toURI()).parentFile

        @Suppress("UNCHECKED_CAST")
        val expected: Map<String, Map<String, Any?>> =
            Json.parse(File(dir, "expected.json").readText()) as Map<String, Map<String, Any?>>

        fun fixture(name: String) = File(dir, name)

        fun sha256(b: ByteArray): String = MessageDigest.getInstance("SHA-256").digest(b).joinToString("") { "%02x".format(it) }

        /** Desktop TrackTags key -> the model's value, for every key the model has a field for. */
        val MODEL_KEYS: Map<String, (TrackTags) -> Any?> = linkedMapOf(
            "title" to { t -> t.title },
            "artist" to { t -> t.artist },
            "artists" to { t -> t.artists },
            "album" to { t -> t.album },
            "albumartist" to { t -> t.albumArtist },
            "artistsort" to { t -> t.sortArtist },
            "albumartistsort" to { t -> t.sortAlbumArtist },
            "titlesort" to { t -> t.sortTitle },
            "albumsort" to { t -> t.sortAlbum },
            "tracknumber" to { t -> t.trackNo },
            "totaltracks" to { t -> t.trackTotal },
            "discnumber" to { t -> t.discNo },
            "totaldiscs" to { t -> t.discTotal },
            "date" to { t -> t.date },
            "originaldate" to { t -> t.originalDate },
            "genre" to { t -> t.genre },
            "compilation" to { t -> t.compilation },
            "isrc" to { t -> t.isrc },
            "label" to { t -> t.label },
            "composer" to { t -> t.composer },
            "bpm" to { t -> t.bpm },
            "comment" to { t -> t.comment },
            "musicbrainz_recordingid" to { t -> t.mbRecordingId },
            "musicbrainz_trackid" to { t -> t.mbTrackId },
            "musicbrainz_albumid" to { t -> t.mbReleaseId },
            "musicbrainz_releasegroupid" to { t -> t.mbReleaseGroupId },
            "musicbrainz_artistid" to { t -> t.mbArtistId },
            "musicbrainz_albumartistid" to { t -> t.mbAlbumArtistId },
            "replaygain_track_gain" to { t -> t.rgTrackGain },
            "replaygain_track_peak" to { t -> t.rgTrackPeak },
            "replaygain_album_gain" to { t -> t.rgAlbumGain },
            "replaygain_album_peak" to { t -> t.rgAlbumPeak },
            "lyrics" to { t -> t.lyrics },
            "rating" to { t -> t.rating },
            "valence_id" to { t -> t.valenceId },
            "valence_owner" to { t -> t.valenceOwner },
            "source" to { t -> t.source },
            "source_quality" to { t -> t.sourceQuality },
        )

        /** Desktop CUSTOM_FIELDS without a model field: [key, ID3 TXXX description, Vorbis name, MP4 freeform name]. */
        val CUSTOM_ONLY = listOf(
            listOf("catalognumber", "CATALOGNUMBER", "CATALOGNUMBER", "CATALOGNUMBER"),
            listOf("barcode", "BARCODE", "BARCODE", "BARCODE"),
            listOf("releasetype", "MusicBrainz Album Type", "RELEASETYPE", "MusicBrainz Album Type"),
            listOf("releasestatus", "MusicBrainz Album Status", "RELEASESTATUS", "MusicBrainz Album Status"),
            listOf("releasecountry", "MusicBrainz Album Release Country", "RELEASECOUNTRY", "MusicBrainz Album Release Country"),
            listOf("acoustid_id", "Acoustid Id", "ACOUSTID_ID", "Acoustid Id"),
            listOf("tidal_track_id", "TIDAL_TRACK_ID", "TIDAL_TRACK_ID", "TIDAL_TRACK_ID"),
            listOf("tidal_album_id", "TIDAL_ALBUM_ID", "TIDAL_ALBUM_ID", "TIDAL_ALBUM_ID"),
            listOf("bandcamp_item_id", "BANDCAMP_ITEM_ID", "BANDCAMP_ITEM_ID", "BANDCAMP_ITEM_ID"),
            listOf("bandcamp_track_id", "BANDCAMP_TRACK_ID", "BANDCAMP_TRACK_ID", "BANDCAMP_TRACK_ID"),
            listOf("bandcamp_url", "BANDCAMP_URL", "BANDCAMP_URL", "BANDCAMP_URL"),
        )

        /** Normalises desktop JSON and model values so they compare the same way. */
        fun norm(key: String, v: Any?): Any? = when {
            key == "compilation" -> v == true
            key == "rating" -> (v as? Number)?.toDouble() ?: 0.0
            key == "artists" -> (v as? List<*>)?.map { it.toString() } ?: emptyList<String>()
            v is List<*> -> v.joinToString("; ")
            v is Number -> v.toDouble()
            else -> v
        }
    }

    @Test
    fun fixturesMatchDesktop() {
        val problems = ArrayList<String>()
        for ((name, exp) in expected) {
            val r = try {
                TagReader.read(fixture(name))
            } catch (e: Exception) {
                problems.add("$name: read failed: $e")
                continue
            }
            @Suppress("UNCHECKED_CAST")
            val tags = exp["tags"] as Map<String, Any?>
            for ((key, get) in MODEL_KEYS) {
                val want = norm(key, tags[key])
                val got = norm(key, get(r.tags))
                val same = if (want is Double && got is Double) abs(want - got) < 1e-9 else want == got
                if (!same) problems.add("$name: $key: desktop=${show(want)} phone=${show(got)}")
            }
            @Suppress("UNCHECKED_CAST")
            val f = exp["format"] as Map<String, Any?>
            val i = r.info
            fun check(what: String, ok: Boolean, want: Any?, got: Any?) {
                if (!ok) problems.add("$name: format.$what: desktop=$want phone=$got")
            }
            val wantMs = (f["durationMs"] as Double).toLong()
            check("durationMs", abs(wantMs - i.durationMs) <= 50, wantMs, i.durationMs)
            val wantBr = f["bitrate"] as Double
            check("bitrate", abs(wantBr - i.bitrate) <= wantBr * 0.03 + 1, wantBr.toLong(), i.bitrate)
            check("codec", f["codec"] == i.codec, f["codec"], i.codec)
            check("lossless", f["lossless"] == i.lossless, f["lossless"], i.lossless)
            check("sampleRate", (f["sampleRate"] as Double).toInt() == i.sampleRate, f["sampleRate"], i.sampleRate)
            check("channels", (f["channels"] as Double).toInt() == i.channels, f["channels"], i.channels)
            if (i.lossless) check("bitDepth", (f["bitDepth"] as Double).toInt() == i.bitDepth, f["bitDepth"], i.bitDepth)
            else check("bitDepth", i.bitDepth == null, null, i.bitDepth)
        }
        if (problems.isNotEmpty()) fail("Mismatches with the desktop:\n" + problems.joinToString("\n"))
    }

    private fun show(v: Any?) = if (v is String) "\"" + v.replace("\n", "\\n") + "\"" else v.toString()

    @Test
    fun customFieldsMatchDesktopNames() {
        val problems = ArrayList<String>()
        for ((name, exp) in expected) {
            @Suppress("UNCHECKED_CAST")
            val tags = exp["tags"] as Map<String, Any?>
            val types = exp["tagTypes"] as List<*>
            val column = when {
                "vorbis" in types -> 2
                "iTunes" in types -> 3
                types.any { it.toString().startsWith("ID3v2") } -> 1
                else -> continue
            }
            val custom = TagReader.read(fixture(name)).tags.custom
            for (row in CUSTOM_ONLY) {
                val want = tags[row[0]] ?: continue
                val got = custom[row[column].uppercase()]
                if (got != norm(row[0], want)) problems.add("$name: custom[${row[column].uppercase()}]: desktop=$want phone=$got")
            }
        }
        if (problems.isNotEmpty()) fail(problems.joinToString("\n"))

        val v24 = TagReader.read(fixture("handmade_v24.mp3")).tags.custom
        assertEquals("one; two", v24["CUSTOM MULTI"])
        assertEquals("bandcamp", v24["VALENCE_SOURCE"])
        val flac = TagReader.read(fixture("desktop.flac")).tags.custom
        assertEquals("0123456789012", flac["BARCODE"])
        assertNull("pictures stay out of custom", flac["METADATA_BLOCK_PICTURE"])
        val opus = TagReader.read(fixture("desktop.opus")).tags.custom
        assertNull("pictures stay out of custom", opus["METADATA_BLOCK_PICTURE"])
        assertEquals("123456789", opus["TIDAL_TRACK_ID"])
    }

    @Test
    fun picturesRoundTrip() {
        for ((name, exp) in expected) {
            val file = fixture(name)
            val r = TagReader.read(file)
            @Suppress("UNCHECKED_CAST")
            val pic = exp["picture"] as Map<String, Any?>?
            if (pic == null) {
                assertNull("$name: no picture expected", r.picture)
                assertNull("$name: no picture expected", TagReader.readPicture(file))
                continue
            }
            val ref = r.picture
            assertNotNull("$name: picture missing", ref)
            ref!!
            assertEquals("$name: mime", pic["mime"], ref.mime)
            assertEquals("$name: length", (pic["length"] as Double).toInt(), ref.length)
            val viaRef = TagReader.readPicture(file, ref)
            assertEquals("$name: sha256 via ref", pic["sha256"], sha256(viaRef))
            val direct = TagReader.readPicture(file)
            assertNotNull("$name: readPicture(file)", direct)
            assertArrayEquals("$name: both readPicture overloads agree", viaRef, direct)
        }
    }

    @Test
    fun readStaysSmall() {
        // read() must not touch picture bytes or the audio payload.
        for (name in expected.keys) {
            val file = fixture(name)
            Source(file).use { src ->
                val col = Collector()
                TagReader.parse(src, col, file.name) // the path TagReader.read takes, on a Source we can inspect
                toTrackTags(col)
                assertTrue("$name: read ${src.bytesRead} of ${src.length} bytes", src.bytesRead <= 64 * 1024 || src.bytesRead < src.length / 2)
            }
        }
    }

    @Test
    fun timing() {
        val files = expected.keys.map { fixture(it) }
        repeat(30) { for (f in files) TagReader.read(f) } // warm up the JIT
        val n = 200
        println("TagReader.read timing (average of $n reads):")
        for (f in files) {
            val t0 = System.nanoTime()
            repeat(n) { TagReader.read(f) }
            val us = (System.nanoTime() - t0) / n / 1000.0
            println("  %-26s %8.1f us".format(f.name, us))
        }
    }

    @Test
    fun unsupportedFormats() {
        val tmp = File.createTempFile("valence-tags", ".bin")
        try {
            for (content in listOf(
                ByteArray(0),
                "hello world, not audio at all".toByteArray(),
                byteArrayOf(0x89.toByte(), 'P'.code.toByte(), 'N'.code.toByte(), 'G'.code.toByte(), 13, 10, 26, 10, 0, 0, 0, 0),
                byteArrayOf('P'.code.toByte(), 'K'.code.toByte(), 3, 4) + ByteArray(200),
                ByteArray(5000),
            )) {
                tmp.writeBytes(content)
                try {
                    TagReader.read(tmp)
                    fail("expected UnsupportedFormatException for ${content.size} bytes")
                } catch (e: UnsupportedFormatException) {
                    // expected
                }
            }
        } finally {
            tmp.delete()
        }
        try {
            TagReader.read(File(dir, "does-not-exist.mp3"))
            fail("expected an IOException")
        } catch (e: java.io.IOException) {
            // expected
        }
    }
}
