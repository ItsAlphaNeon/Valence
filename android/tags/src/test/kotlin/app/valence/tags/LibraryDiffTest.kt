package app.valence.tags

import org.junit.Assume.assumeTrue
import org.junit.Test
import java.io.File
import kotlin.math.abs

/**
 * Opt-in differential check against the desktop over a real library: set VALENCE_TAGS_DIFF to a JSON
 * file mapping absolute paths to the desktop's probeFile output ({tags, format, tagTypes, picture}).
 * Prints a summary of every disagreement; never fails (real libraries hold surprises worth reading).
 */
class LibraryDiffTest {
    @Test
    fun compareWithDesktopDump() {
        val path = System.getenv("VALENCE_TAGS_DIFF")
        assumeTrue("VALENCE_TAGS_DIFF not set", !path.isNullOrEmpty() && File(path).isFile)
        @Suppress("UNCHECKED_CAST")
        val dump = Json.parse(File(path!!).readText()) as Map<String, Map<String, Any?>>
        val byKind = LinkedHashMap<String, MutableList<String>>()
        fun note(kind: String, msg: String) { byKind.getOrPut(kind) { ArrayList() }.add(msg) }
        var totalNs = 0L
        var maxNs = 0L
        var maxFile = ""
        var files = 0
        var totalBytes = 0L
        var maxBytes = 0L
        var maxBytesFile = ""
        val perExt = java.util.TreeMap<String, LongArray>()
        for ((p, exp) in dump) {
            val f = File(p)
            if (!f.isFile) continue
            files++
            val t0 = System.nanoTime()
            val r = try {
                TagReader.read(f)
            } catch (e: Exception) {
                if (exp["error"] == null) note("phone error", "$p: $e")
                null
            }
            val dt = System.nanoTime() - t0
            totalNs += dt
            if (dt > maxNs) { maxNs = dt; maxFile = p }
            if (r == null) continue
            val read = Source(f).use { src -> TagReader.parse(src, Collector(), f.name); src.bytesRead }
            totalBytes += read
            val ext = f.extension.lowercase()
            val agg = perExt.getOrPut(ext) { LongArray(3) }
            agg[0]++; agg[1] += read; agg[2] += dt
            if (read > maxBytes) { maxBytes = read; maxBytesFile = "$p (${f.length()} bytes)" }
            if (exp["error"] != null) { note("desktop error only", "$p: ${exp["error"]}"); continue }
            @Suppress("UNCHECKED_CAST")
            val tags = exp["tags"] as Map<String, Any?>
            for ((key, get) in TagReaderTest.MODEL_KEYS) {
                val want = TagReaderTest.norm(key, tags[key])
                val got = TagReaderTest.norm(key, get(r.tags))
                val same = if (want is Double && got is Double) abs(want - got) < 1e-9 else want == got
                if (!same) note("tag $key", "$p: desktop=${show(want)} phone=${show(got)}")
            }
            @Suppress("UNCHECKED_CAST")
            val fm = exp["format"] as Map<String, Any?>
            val i = r.info
            val wantMs = (fm["durationMs"] as Double).toLong()
            if (abs(wantMs - i.durationMs) > 50) note("durationMs", "$p: desktop=$wantMs phone=${i.durationMs}")
            val wantBr = fm["bitrate"] as Double
            if (abs(wantBr - i.bitrate) > wantBr * 0.03 + 1) note("bitrate", "$p: desktop=${wantBr.toLong()} phone=${i.bitrate}")
            if (fm["codec"] != i.codec) note("codec", "$p: desktop=${fm["codec"]} phone=${i.codec}")
            if ((fm["sampleRate"] as Double).toInt() != i.sampleRate) note("sampleRate", "$p: desktop=${fm["sampleRate"]} phone=${i.sampleRate}")
            if ((fm["channels"] as Double).toInt() != i.channels) note("channels", "$p: desktop=${fm["channels"]} phone=${i.channels}")
            if (fm["lossless"] != i.lossless) note("lossless", "$p: desktop=${fm["lossless"]} phone=${i.lossless}")
            @Suppress("UNCHECKED_CAST")
            val pic = exp["picture"] as Map<String, Any?>?
            val ref = r.picture
            when {
                pic == null && ref != null -> note("picture extra", "$p: phone has ${ref.mime} ${ref.length}")
                pic != null && ref == null -> note("picture missing", "$p: desktop has ${pic["mime"]} ${pic["length"]}")
                pic != null && ref != null -> {
                    if (pic["mime"] != ref.mime) note("picture mime", "$p: desktop=${pic["mime"]} phone=${ref.mime}")
                    val bytes = try { TagReader.readPicture(f, ref) } catch (e: Exception) { note("picture load", "$p: $e"); null }
                    if (bytes != null && TagReaderTest.sha256(bytes) != pic["sha256"]) {
                        note("picture bytes", "$p: desktop=${pic["length"]} phone=${bytes.size}")
                    }
                }
            }
        }
        println("Library diff: $files files, avg ${totalNs / maxOf(files, 1) / 1000} us/read, max ${maxNs / 1000} us ($maxFile)")
        println("  disk reads: avg ${totalBytes / maxOf(files, 1)} bytes/file, max $maxBytes ($maxBytesFile)")
        for ((ext, a) in perExt) println("    .$ext: ${a[0]} files, avg ${a[1] / a[0]} bytes read, avg ${a[2] / a[0] / 1000} us")
        if (byKind.isEmpty()) println("  no differences")
        for ((kind, list) in byKind) {
            println("  [$kind] ${list.size}")
            for (m in list.take(8)) println("      $m")
        }
    }

    private fun show(v: Any?) = if (v is String) "\"" + v.replace("\n", "\\n").take(120) + "\"" else v.toString()
}
