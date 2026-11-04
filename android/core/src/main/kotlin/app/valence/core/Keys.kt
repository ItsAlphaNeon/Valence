package app.valence.core

import java.text.BreakIterator
import java.text.Normalizer
import java.util.regex.Pattern

/**
 * Text keys exactly as the desktop derives them (src/shared/sanitize.ts, src/main/library/indexer.ts,
 * src/main/sync/favorites.ts, src/main/library/scanner.ts, src/main/tags/read.ts). Every function
 * here must agree with the desktop for every input: these strings are join keys across devices.
 */
object Keys {
    const val VARIOUS_ARTISTS = "Various Artists"
    const val UNKNOWN_ARTIST = "Unknown Artist"
    const val MAX_COMPONENT = 80

    val AUDIO_EXTENSIONS: Set<String> = linkedSetOf(
        "mp3", "flac", "m4a", "mp4", "aac", "alac", "ogg", "oga", "opus", "wav", "aif", "aiff", "aifc",
        "wma", "ape", "wv", "tta", "mpc", "mp2", "ac3", "dsf", "dff", "webm", "mka",
    )

    private val RESERVED_TOP_LEVEL: Set<String> = listOf(
        "playlists", ".valence", "music", "itunes", "garageband", "audio music apps", "logic", "podcasts", "android", "lost.dir",
    ).map { foldKey(it) }.toSet()

    private fun isZeroWidth(c: Char): Boolean =
        c in '​'..'‏' || c in '‪'..'‮' || c in '⁠'..'⁩' || c == '﻿' || c == '­' || c == '᠎'

    private fun isControl(c: Char): Boolean = c <= '\u001F' || c in '\u007F'..'\u009F'

    /** NFC, zero-width/bidi characters removed, control characters to spaces, whitespace collapsed, trimmed. */
    fun cleanText(input: String?): String {
        if (input.isNullOrEmpty()) return ""
        val nfc = Normalizer.normalize(input, Normalizer.Form.NFC)
        val sb = StringBuilder(nfc.length)
        for (c in nfc) {
            if (isZeroWidth(c)) continue
            sb.append(if (isControl(c)) ' ' else c)
        }
        return Js.trim(Js.collapseSpaces(sb.toString()))
    }

    /** Case-folded key for paths and folders (NFC + lower case). */
    fun foldKey(s: String): String = Js.lower(Normalizer.normalize(s, Normalizer.Form.NFC))

    private fun isAsciiWord(c: Char): Boolean = c in 'a'..'z' || c in 'A'..'Z' || c in '0'..'9' || c == '_'

    private fun isLetterOrNumber(cp: Int): Boolean = when (Character.getType(cp).toByte()) {
        Character.UPPERCASE_LETTER, Character.LOWERCASE_LETTER, Character.TITLECASE_LETTER, Character.MODIFIER_LETTER, Character.OTHER_LETTER,
        Character.DECIMAL_DIGIT_NUMBER, Character.LETTER_NUMBER, Character.OTHER_NUMBER -> true
        else -> false
    }

    /** Fuzzy-match key for artist/title/album comparisons (the desktop's matchKey, quirks included). */
    fun matchKey(s: String?): String {
        val nfkd = Normalizer.normalize(cleanText(s), Normalizer.Form.NFKD)
        val noMarks = StringBuilder(nfkd.length)
        for (c in nfkd) if (c !in '̀'..'ͯ') noMarks.append(c)
        val lowered = Js.lower(noMarks.toString())
        val amp = StringBuilder(lowered.length + 8)
        for (c in lowered) if (c == '&') amp.append(" and ") else amp.append(c)
        val noArticles = stripArticles(amp.toString())
        // /[^\p{L}\p{N}]+/gu -> ' '
        val sb = StringBuilder(noArticles.length)
        var i = 0
        var inRun = false
        while (i < noArticles.length) {
            val cp = noArticles.codePointAt(i)
            if (isLetterOrNumber(cp)) {
                sb.appendCodePoint(cp)
                inRun = false
            } else if (!inRun) {
                sb.append(' ')
                inRun = true
            }
            i += Character.charCount(cp)
        }
        return Js.trim(Js.collapseSpaces(sb.toString()))
    }

    /** `/\b(the|a|an)\b/g` -> ' ' with JS's ASCII-only word boundary. */
    private fun stripArticles(s: String): String {
        val sb = StringBuilder(s.length)
        var i = 0
        fun boundary(at: Int): Boolean {
            val before = at > 0 && isAsciiWord(s[at - 1])
            val after = at < s.length && isAsciiWord(s[at])
            return before != after
        }
        while (i < s.length) {
            var matched = 0
            if (boundary(i)) {
                for (w in ARTICLES) {
                    if (s.startsWith(w, i) && boundary(i + w.length)) {
                        matched = w.length
                        break
                    }
                }
            }
            if (matched > 0) {
                sb.append(' ')
                i += matched
            } else {
                sb.append(s[i])
                i++
            }
        }
        return sb.toString()
    }

    private val ARTICLES = arrayOf("the", "a", "an")

    /** Folder part of a library-relative path ("" for a file at the root). */
    fun relDirOf(relPath: String): String {
        val i = relPath.lastIndexOf('/')
        return if (i < 0) "" else relPath.substring(0, i)
    }

    fun pathKey(relPath: String): String = foldKey(relPath)

    /**
     * Album grouping key: same folder + same album title. [album] and [title] are the raw (first)
     * tag values; they are cleaned here the way the desktop's tag reader does.
     */
    fun albumKeyFor(relPath: String, album: String?, title: String?): String =
        foldKey(relDirOf(relPath)) + "|" + matchKey(cleanText(album).ifEmpty { cleanText(title) })

    fun isVariousArtists(name: String?): Boolean {
        val n = Js.lower(cleanText(name))
        return n == "various artists" || n == "various" || n == "va" || n == "v.a." || n == "verschiedene interpreten"
    }

    /** The album artist the desktop files and groups a track under. */
    fun effectiveAlbumArtist(albumArtist: String?, artist: String?, compilation: Boolean): String {
        val aa = cleanText(albumArtist)
        if (compilation || isVariousArtists(aa)) return VARIOUS_ARTISTS
        return aa.ifEmpty { cleanText(artist).ifEmpty { UNKNOWN_ARTIST } }
    }

    /** Favorites key of an artist (kind "r"). */
    fun artistFavoriteKey(name: String): String = Normalizer.normalize(Js.lower(Js.trim(name)), Normalizer.Form.NFC)

    /** Plays/favorites key of a track: its embedded Valence ID, else `path:<relPath>`. */
    fun trackKey(valenceId: String?, relPath: String): String = if (valenceId.isNullOrEmpty()) "path:$relPath" else valenceId

    /** Names Valence never indexes or touches: Syncthing internals, conflict copies, temp files. */
    fun isIgnoredName(name: String): Boolean {
        val n = Js.lower(name)
        return n.contains(".sync-conflict-") ||
            n.endsWith(".valence-tmp") ||
            n.startsWith("~syncthing~") ||
            n.startsWith(".syncthing.") ||
            n == ".stfolder" ||
            n == ".stversions" ||
            n == ".stignore" ||
            n == ".trashed" ||
            n.startsWith("._") ||
            n == "desktop.ini" ||
            n == "thumbs.db" ||
            n == ".ds_store"
    }

    /** A Syncthing conflict copy (`x.sync-conflict-<date>-<time>-<device>.ext`). */
    fun isConflictCopy(name: String): Boolean = Js.lower(name).contains(".sync-conflict-")

    /** Top-level folder names reserved for Valence, the phone, or other apps. */
    fun isReservedTopLevel(name: String): Boolean = foldKey(name) in RESERVED_TOP_LEVEL

    /** Scanner rule; note the desktop collects depth-0 `Playlists` (any case) for m3u8 files before applying it. */
    fun shouldSkipDir(name: String, depth: Int): Boolean {
        if (name.startsWith(".")) return true
        if (isIgnoredName(name)) return true
        return depth == 0 && isReservedTopLevel(name)
    }

    /** By extension, the desktop way (`"mp3"` with no dot counts too). */
    fun isAudioPath(path: String): Boolean = Js.lower(path).substringAfterLast('.') in AUDIO_EXTENSIONS

    /** File name without its extension. */
    fun stemOf(relPath: String): String {
        val name = relPath.substringAfterLast('/')
        val dot = name.lastIndexOf('.')
        return if (dot > 0) name.substring(0, dot) else name
    }

    // --- sanitizeComponent ----------------------------------------------------------------------

    private val COLON_SPACED = Regex("[\\t\\n\\u000B\\u000C\\r \\u00A0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000\\uFEFF]*:[\\t\\n\\u000B\\u000C\\r \\u00A0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000\\uFEFF]+")
    // ASCII-only case folding, like a non-unicode JS /i regex.
    private val WINDOWS_RESERVED = Pattern.compile("^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\\.[^\\n\\r\\u2028\\u2029]*)?\\z", Pattern.CASE_INSENSITIVE).toRegex()

    /** Makes one path component safe on every target filesystem (the desktop's sanitizeComponent). */
    fun sanitizeComponent(input: String?, maxLen: Int = MAX_COMPONENT): String {
        var s = cleanText(input)
        s = COLON_SPACED.replace(s, " - ")
        val sb = StringBuilder(s.length)
        for (c in s) {
            when (c) {
                ':', '/', '\\' -> sb.append('-')
                '?', '*' -> {}
                '"' -> sb.append('\'')
                '<', '>', '|' -> sb.append('_')
                else -> sb.append(c)
            }
        }
        s = Js.trim(Js.collapseSpaces(sb.toString()))
        s = s.trimStart('.').trimEnd('.', ' ')
        if (WINDOWS_RESERVED.containsMatchIn(s)) s = "_$s"
        s = truncateGraphemes(s, maxLen).trimEnd('.', ' ')
        return s.ifEmpty { "_" }
    }

    /** At most [max] UTF-16 units without splitting a grapheme cluster. */
    fun truncateGraphemes(s: String, max: Int): String {
        if (s.length <= max) return s
        val it = BreakIterator.getCharacterInstance()
        it.setText(s)
        var end = 0
        var next = it.next()
        while (next != BreakIterator.DONE && next <= max) {
            end = next
            next = it.next()
        }
        return s.substring(0, end)
    }
}
