package app.valence.core

import java.io.ByteArrayOutputStream
import java.io.File
import java.nio.ByteBuffer
import java.nio.charset.CharacterCodingException
import java.nio.charset.CodingErrorAction
import java.security.MessageDigest

/**
 * Extended M3U (UTF-8 `.m3u8`) the desktop's way (src/main/sync/m3u.ts): paths relative to the
 * playlist file, `/`-separated, LF line endings, `#EXTINF:<sec>,<Artist> - <Title>` before known tracks.
 */
object M3u8 {
    const val PLAYLISTS_DIR = "Playlists"

    /** [relPath] is library-relative; [title]/[durationSec] come from `#EXTINF` (null if absent). */
    data class Entry(val relPath: String, val title: String? = null, val durationSec: Int? = null)

    /** The entry the desktop writes for a library track: "artist - title", duration rounded to seconds. */
    fun entry(relPath: String, artist: String, title: String, durationMs: Long): Entry =
        Entry(relPath, "$artist - $title", jsRoundToInt(durationMs / 1000.0))

    /** Reads a playlist file inside [libraryRoot]; paths resolve relative to the file, absolute ones under the root are mapped. */
    fun read(file: File, libraryRoot: File): List<Entry> =
        parse(file.readText(Charsets.UTF_8), relPathOf(file, libraryRoot), libraryRoot.absolutePath)

    /** Writes a playlist file atomically (`<file>.valence-tmp`, then rename) in the desktop's exact format. */
    fun write(file: File, libraryRoot: File, entries: List<Entry>) {
        AtomicFiles.writeText(file, render(relPathOf(file, libraryRoot), entries))
    }

    /** Library-relative `/` path of [file]. */
    fun relPathOf(file: File, libraryRoot: File): String {
        val rel = libraryRoot.absoluteFile.toPath().normalize().relativize(file.absoluteFile.toPath().normalize()).toString()
        return rel.replace(File.separatorChar, '/')
    }

    /** The desktop's writeM3u. */
    fun render(playlistRelPath: String, entries: List<Entry>): String {
        val from = Posix.dirname(playlistRelPath)
        val sb = StringBuilder("#EXTM3U\n")
        for (e in entries) {
            val dur = e.durationSec ?: -1
            if (!e.title.isNullOrEmpty()) sb.append("#EXTINF:").append(dur).append(',').append(singleLine(e.title)).append('\n')
            sb.append(Posix.relative(from, e.relPath)).append('\n')
        }
        return sb.toString()
    }

    private fun singleLine(s: String): String {
        val sb = StringBuilder(s.length)
        var inRun = false
        for (c in s) {
            if (c == '\r' || c == '\n') {
                if (!inRun) sb.append(' ')
                inRun = true
            } else {
                sb.append(c)
                inRun = false
            }
        }
        return sb.toString()
    }

    /**
     * The desktop's parseM3u. Lines that point outside the library (or at absolute paths not under
     * [libraryRoot]) are dropped. Unlike the desktop, which fails the whole file, a `file://` line
     * with a malformed percent escape is skipped.
     */
    fun parse(text: String, playlistRelPath: String, libraryRoot: String? = null): List<Entry> {
        val from = Posix.dirname(playlistRelPath)
        val out = ArrayList<Entry>()
        var pendingTitle: String? = null
        var pendingDur: Int? = null
        val rootNorm = libraryRoot?.replace('\\', '/')?.trimEnd('/')?.let(Js::lower)
        val body = if (text.startsWith("﻿")) text.substring(1) else text
        for (raw in splitLines(body)) {
            val line = Js.trim(raw)
            if (line.isEmpty()) continue
            if (line.startsWith("#")) {
                val m = extinf(line)
                if (m != null) {
                    val n = m.first.toDouble()
                    pendingDur = if (n >= 0) jsRoundToInt(n) else null
                    pendingTitle = Js.trim(m.second).ifEmpty { null }
                }
                continue
            }
            var p = line.replace('\\', '/')
            var rel: String?
            val ok = if (p.length >= 7 && (0 until 7).all { asciiLower(p[it]) == "file://"[it] }) {
                val stripped = if (p.length > 7 && p[7] == '/') p.substring(8) else p.substring(7)
                decodeURIComponent(stripped)?.also { p = it } != null
            } else {
                true
            }
            if (!ok) {
                rel = null
            } else if (isWindowsAbsolute(p) || p.startsWith("/")) {
                rel = if (!rootNorm.isNullOrEmpty() && Js.lower(p).startsWith("$rootNorm/")) p.substring(minOf(rootNorm.length + 1, p.length)) else null
            } else {
                rel = Posix.normalize(Posix.join(from, p))
                if (rel.startsWith("../")) rel = null
            }
            if (!rel.isNullOrEmpty()) out.add(Entry(rel, pendingTitle, pendingDur))
            pendingTitle = null
            pendingDur = null
        }
        return out
    }

    /** Syncthing conflict copy of a playlist: keep `a`'s order, append `b`'s new paths (case-insensitive). */
    fun unionMerge(a: List<Entry>, b: List<Entry>): List<Entry> {
        val seen = a.mapTo(HashSet()) { Js.lower(it.relPath) }
        return a + b.filter { Js.lower(it.relPath) !in seen }
    }

    /** `Mix.sync-conflict-20250101-120000-ABCDEFG.m3u8` -> `Mix.m3u8` (the desktop's base-name rule). */
    fun conflictBaseName(name: String): String = Regex("\\.sync-conflict-[^.]*").replaceFirst(name, "")

    /** A file in `Playlists/` the desktop indexes (`*.m3u` / `*.m3u8`, any case, not a temp file). */
    fun isPlaylistFile(name: String): Boolean {
        val l = Js.lower(name)
        return (l.endsWith(".m3u8") || l.endsWith(".m3u")) && !name.contains(".valence-tmp")
    }

    /** The desktop's id of a static playlist: `m3u-` + first 16 hex of sha1(foldKey(relPath)). */
    fun staticId(relPath: String): String {
        val d = MessageDigest.getInstance("SHA-1").digest(Keys.foldKey(relPath).toByteArray(Charsets.UTF_8))
        return "m3u-" + d.joinToString("") { "%02x".format(it.toInt() and 0xff) }.substring(0, 16)
    }

    /** `text.split(/\r?\n/)` */
    private fun splitLines(s: String): List<String> {
        val out = ArrayList<String>()
        var start = 0
        var i = 0
        while (i < s.length) {
            if (s[i] == '\n') {
                val end = if (i > start && s[i - 1] == '\r') i - 1 else i
                out.add(s.substring(start, end))
                start = i + 1
            }
            i++
        }
        out.add(s.substring(start))
        return out
    }

    /** `/^#EXTINF:(-?\d+(?:\.\d+)?)\s*(?:[^,]*)?,(.*)$/` -> (number, title) or null. */
    private fun extinf(line: String): Pair<String, String>? {
        if (!line.startsWith("#EXTINF:")) return null
        var j = 8
        if (j < line.length && line[j] == '-') j++
        val digitsStart = j
        while (j < line.length && line[j] in '0'..'9') j++
        if (j == digitsStart) return null
        if (j + 1 < line.length && line[j] == '.' && line[j + 1] in '0'..'9') {
            j += 2
            while (j < line.length && line[j] in '0'..'9') j++
        }
        val num = line.substring(8, j)
        val comma = line.indexOf(',', j)
        if (comma < 0) return null
        val title = line.substring(comma + 1)
        if (title.any(Js::isLineTerminator)) return null
        return num to title
    }

    private fun asciiLower(c: Char): Char = if (c in 'A'..'Z') c + 32 else c

    private fun isWindowsAbsolute(p: String): Boolean =
        p.length >= 3 && (p[0] in 'a'..'z' || p[0] in 'A'..'Z') && p[1] == ':' && p[2] == '/'

    private fun jsRoundToInt(x: Double): Int {
        val r = Js.round(x)
        return when {
            r.isNaN() -> 0
            r >= Int.MAX_VALUE -> Int.MAX_VALUE
            r <= Int.MIN_VALUE -> Int.MIN_VALUE
            else -> r.toInt()
        }
    }

    /** `decodeURIComponent`, or null where it would throw URIError. */
    internal fun decodeURIComponent(s: String): String? {
        if (s.indexOf('%') < 0) return s
        val sb = StringBuilder(s.length)
        var i = 0
        while (i < s.length) {
            val c = s[i]
            if (c != '%') {
                sb.append(c)
                i++
                continue
            }
            val bytes = ByteArrayOutputStream()
            while (i < s.length && s[i] == '%') {
                if (i + 3 > s.length) return null
                val hi = Character.digit(s[i + 1], 16)
                val lo = Character.digit(s[i + 2], 16)
                if (hi < 0 || lo < 0 || s[i + 1].code > 127 || s[i + 2].code > 127) return null
                bytes.write(hi * 16 + lo)
                i += 3
            }
            val decoder = Charsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT).onUnmappableCharacter(CodingErrorAction.REPORT)
            try {
                sb.append(decoder.decode(ByteBuffer.wrap(bytes.toByteArray())))
            } catch (_: CharacterCodingException) {
                return null
            }
        }
        return sb.toString()
    }
}
