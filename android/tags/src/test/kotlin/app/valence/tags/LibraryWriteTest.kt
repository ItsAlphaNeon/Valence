package app.valence.tags

import org.junit.Assume.assumeTrue
import org.junit.Test
import java.io.File
import java.security.MessageDigest

/**
 * Opt-in check of the tag writer on real files: set VALENCE_TAGS_WRITE to a folder holding COPIES of
 * library files in `src/`. Each one gets an album-style edit written to `out/`, verified as the app
 * would. Prints what was refused and why; never fails, and never writes to `src/`.
 */
class LibraryWriteTest {
    @Test
    fun editCopiesOfRealFiles() {
        val root = System.getenv("VALENCE_TAGS_WRITE")?.let(::File)
        assumeTrue("VALENCE_TAGS_WRITE not set", root != null && File(root, "src").isDirectory)
        val srcDir = File(root, "src")
        val outDir = File(root, "out").apply { mkdirs() }
        val edit = TagEdit(
            mapOf(
                TagField.ALBUM to "Valence Test Album ✓",
                TagField.ALBUM_ARTIST to "Valence Tester",
                TagField.GENRE to "Test Genre",
                TagField.DATE to "2001",
                TagField.DISC_NO to "1",
                TagField.DISC_TOTAL to "1",
            ),
        )
        val refused = java.util.TreeMap<String, MutableList<String>>()
        var ok = 0
        var moved = 0
        var ns = 0L
        val files = srcDir.listFiles()!!.filter { it.isFile }.sortedBy { it.name }
        for (f in files) {
            val hash = sha(f)
            val dst = File(outDir, f.name)
            val t0 = System.nanoTime()
            try {
                TagWriter.writeVerified(f, dst, edit)
                ok++
                if (dst.length() != f.length()) moved++
                val t = TagReader.read(dst).tags
                check(t.album == "Valence Test Album ✓" && t.albumArtist == "Valence Tester" && t.discNo == 1) { "${f.name}: read-back" }
            } catch (e: TagWriteException) {
                refused.getOrPut(e.message ?: "?") { ArrayList() }.add(f.name)
            }
            ns += System.nanoTime() - t0
            check(sha(f).contentEquals(hash)) { "${f.name}: the source changed!" }
        }
        println("TAGWRITE files=${files.size} ok=$ok sizeChanged=$moved avgMs=${ns / 1_000_000 / maxOf(1, files.size)}")
        for ((why, names) in refused) println("TAGWRITE refused ${names.size}: $why -> ${names.take(12)}")
    }

    private fun sha(f: File): ByteArray {
        val md = MessageDigest.getInstance("SHA-256")
        f.inputStream().buffered().use { s ->
            val buf = ByteArray(1 shl 16)
            while (true) { val n = s.read(buf); if (n < 0) break; md.update(buf, 0, n) }
        }
        return md.digest()
    }
}
