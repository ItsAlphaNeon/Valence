package app.valence.tags

import org.junit.Assert.fail
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File
import java.io.IOException
import kotlin.random.Random

/**
 * Damaged input must throw IOException / UnsupportedFormatException or return partial data: never
 * hang, never throw anything else, never allocate absurd amounts.
 */
class RobustnessTest {
    @get:Rule
    val tmp = TemporaryFolder()

    private val fixtures: List<File> = TagReaderTest.expected.keys.map { TagReaderTest.fixture(it) }

    private var cases = 0

    /** Runs every entry point on [bytes]; fails on unexpected exceptions or slow reads. */
    private fun probe(label: String, name: String, bytes: ByteArray, ref: PictureRef?) {
        cases++
        val f = File(tmp.root, name)
        f.writeBytes(bytes)
        val t0 = System.nanoTime()
        fun ok(what: String, fn: () -> Unit) {
            try {
                fn()
            } catch (e: IOException) {
                // fine
            } catch (e: UnsupportedFormatException) {
                // fine
            } catch (e: Throwable) {
                val w = java.io.StringWriter()
                e.printStackTrace(java.io.PrintWriter(w))
                fail("$label: $what threw $e\n$w")
            }
        }
        ok("read") { TagReader.read(f) }
        ok("readPicture(file)") { TagReader.readPicture(f) }
        if (ref != null) ok("readPicture(file, ref)") { TagReader.readPicture(f, ref) }
        val ms = (System.nanoTime() - t0) / 1_000_000
        if (ms > 2000) fail("$label: took $ms ms")
    }

    private fun refOf(f: File): PictureRef? = TagReader.read(f).picture

    @Test(timeout = 300_000)
    fun truncatedFiles() {
        for (f in fixtures) {
            val b = f.readBytes()
            val ref = refOf(f)
            val cuts = HashSet<Int>()
            for (n in listOf(0, 1, 2, 3, 4, 7, 8, 9, 10, 11, 12, 16, 27, 28, 32, 64, 100, 128, 200, 512, 1000)) cuts.add(n)
            var n = 0
            while (n < b.size) { cuts.add(n); n += maxOf(1, b.size / 150) }
            for (k in 1..64) cuts.add(b.size - k)
            for (c in cuts.filter { it in 0 until b.size }.sorted()) {
                probe("${f.name} truncated to $c", f.name, b.copyOf(c), ref)
            }
        }
        println("truncation cases: $cases")
    }

    @Test(timeout = 300_000)
    fun bitFlips() {
        val rnd = Random(1234)
        for (f in fixtures) {
            val b = f.readBytes()
            val ref = refOf(f)
            // Most damage that matters is in the headers and tags, so favour the first and last 8 KB.
            repeat(250) { round ->
                val c = b.copyOf()
                val flips = 1 + rnd.nextInt(8)
                repeat(flips) {
                    val i = when (rnd.nextInt(3)) {
                        0 -> rnd.nextInt(minOf(c.size, 8192))
                        1 -> c.size - 1 - rnd.nextInt(minOf(c.size, 8192))
                        else -> rnd.nextInt(c.size)
                    }
                    c[i] = if (rnd.nextBoolean()) (c[i].toInt() xor (1 shl rnd.nextInt(8))).toByte() else rnd.nextInt(256).toByte()
                }
                probe("${f.name} flip round $round", f.name, c, ref)
            }
        }
        println("bit-flip cases: $cases")
    }

    @Test(timeout = 300_000)
    fun hugeSizeFields() {
        // Overwrite every 4-byte window in the first 4 KB with 0xFFFFFFFF / 0x7FFFFFFF / syncsafe max:
        // size fields that claim more than the file holds.
        val patterns = listOf(
            byteArrayOf(-1, -1, -1, -1),
            byteArrayOf(0x7F, -1, -1, -1),
            byteArrayOf(0x7F, 0x7F, 0x7F, 0x7F),
            byteArrayOf(0, 0, 0, 0),
            byteArrayOf(0, 0, 0, 1),
        )
        for (f in fixtures) {
            val b = f.readBytes()
            val ref = refOf(f)
            var pos = 0
            while (pos + 4 <= minOf(b.size, 4096)) {
                for ((k, p) in patterns.withIndex()) {
                    val c = b.copyOf()
                    System.arraycopy(p, 0, c, pos, 4)
                    probe("${f.name} pattern $k at $pos", f.name, c, ref)
                }
                pos += if (pos < 256) 1 else 13
            }
        }
        println("size-field cases: $cases")
    }

    @Test(timeout = 120_000)
    fun garbage() {
        val rnd = Random(99)
        val magics = listOf("ID3", "fLaC", "OggS", "\u0000\u0000\u0000 ftypM4A ", "RIFF\u0000\u0000\u0000\u0000WAVE", "FORM\u0000\u0000\u0000\u0000AIFF", "ÿû\u0090\u0000")
        repeat(400) { i ->
            val size = rnd.nextInt(1, 70_000)
            val b = rnd.nextBytes(size)
            // Half the time start with a real magic so the format parsers run on noise.
            if (i % 2 == 0) {
                val m = magics[i / 2 % magics.size].toByteArray(Charsets.ISO_8859_1)
                System.arraycopy(m, 0, b, 0, minOf(m.size, b.size))
            }
            probe("garbage $i", if (i % 3 == 0) "garbage.mp3" else "garbage.bin", b, null)
        }
    }

    @Test(timeout = 60_000)
    fun staleRefsThrowIOException() {
        for (f in fixtures) {
            val ref = refOf(f) ?: continue
            val c = File(tmp.root, "stale-" + f.name)
            c.writeBytes(f.readBytes().copyOf(64))
            try {
                TagReader.readPicture(c, ref)
                fail("${f.name}: expected IOException for a stale ref")
            } catch (e: IOException) {
                // expected
            } catch (e: UnsupportedFormatException) {
                // also acceptable: the remains are not audio
            }
        }
    }
}
