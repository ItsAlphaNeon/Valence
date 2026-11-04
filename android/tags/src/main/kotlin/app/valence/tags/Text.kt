package app.valence.tags

import java.text.Normalizer

// JavaScript-compatible string helpers, so values come out exactly as the desktop (Node) produces them.

/** JS `\s` / `String.prototype.trim` whitespace (includes NBSP, U+2028/9, BOM, ...). */
internal fun isJsSpace(c: Char): Boolean = when (c) {
    ' ', '\t', '\n', '\u000B', '\u000C', '\r', ' ', ' ', ' ', ' ', ' ', ' ', '　', '﻿' -> true
    else -> c in ' '..' '
}

internal fun jsTrim(s: String): String {
    var a = 0
    var b = s.length
    while (a < b && isJsSpace(s[a])) a++
    while (b > a && isJsSpace(s[b - 1])) b--
    return if (a == 0 && b == s.length) s else s.substring(a, b)
}

internal fun trimNullPadding(s: String): String {
    var end = s.length
    while (end > 0 && s[end - 1] == '\u0000') end--
    return if (end == s.length) s else s.substring(0, end)
}

/** Zero-width, bidi embedding/isolate controls, BOM, soft hyphen, Mongolian vowel separator (sanitize.ts). */
private fun isZeroWidth(c: Char): Boolean =
    c in '​'..'‏' || c in '‪'..'‮' || c in '⁠'..'⁩' || c == '﻿' || c == '­' || c == '᠎'

/** Port of the desktop's `cleanText`: NFC, strip zero-width, controls to spaces, collapse whitespace, trim. */
internal fun cleanText(input: String?): String {
    if (input.isNullOrEmpty()) return ""
    var ascii = true
    for (ch in input) if (ch.code >= 0x80) { ascii = false; break }
    val s = if (ascii || Normalizer.isNormalized(input, Normalizer.Form.NFC)) input else Normalizer.normalize(input, Normalizer.Form.NFC)
    val out = StringBuilder(s.length)
    var pendingSpace = false
    for (ch in s) {
        if (isZeroWidth(ch)) continue
        val space = ch.code <= 0x1F || ch.code in 0x7F..0x9F || isJsSpace(ch)
        if (space) {
            if (out.isNotEmpty()) pendingSpace = true
        } else {
            if (pendingSpace) { out.append(' '); pendingSpace = false }
            out.append(ch)
        }
    }
    return if (out.length == s.length) s else out.toString()
}

/** `cleanText`, with empty results mapped to null. */
internal fun cleanOrNull(s: String?): String? = if (s.isNullOrEmpty()) null else cleanText(s).ifEmpty { null }

/** JS `Number.parseInt(s, 10)`; null where JS gives NaN. */
internal fun parseIntJs(s: String?): Long? {
    if (s == null) return null
    var i = 0
    while (i < s.length && isJsSpace(s[i])) i++
    var neg = false
    if (i < s.length && (s[i] == '+' || s[i] == '-')) { neg = s[i] == '-'; i++ }
    val start = i
    var v = 0L
    while (i < s.length && s[i] in '0'..'9') {
        if (v < 1_000_000_000_000L) v = v * 10 + (s[i] - '0')
        i++
    }
    if (i == start) return null
    return if (neg) -v else v
}

internal fun parseIntJsInt(s: String?): Int? = parseIntJs(s)?.let { if (it in Int.MIN_VALUE..Int.MAX_VALUE) it.toInt() else null }

/** JS `Number.parseFloat`: longest numeric prefix after leading whitespace; NaN if none. */
internal fun parseFloatJs(s: String?): Double {
    if (s == null) return Double.NaN
    var i = 0
    while (i < s.length && isJsSpace(s[i])) i++
    val start = i
    if (i < s.length && (s[i] == '+' || s[i] == '-')) i++
    if (s.startsWith("Infinity", i)) return if (s[start] == '-') Double.NEGATIVE_INFINITY else Double.POSITIVE_INFINITY
    val digitsStart = i
    while (i < s.length && s[i] in '0'..'9') i++
    var mantissaDigits = i - digitsStart
    if (i < s.length && s[i] == '.') {
        val f = i + 1
        var j = f
        while (j < s.length && s[j] in '0'..'9') j++
        mantissaDigits += j - f
        if (mantissaDigits > 0) i = j
    }
    if (mantissaDigits == 0) return Double.NaN
    if (i < s.length && (s[i] == 'e' || s[i] == 'E')) {
        var j = i + 1
        if (j < s.length && (s[j] == '+' || s[j] == '-')) j++
        val e = j
        while (j < s.length && s[j] in '0'..'9') j++
        if (j > e) i = j
    }
    return s.substring(start, i).toDoubleOrNull() ?: Double.NaN
}

/** Desktop `parseGain`: "-6.54 dB" -> -6.54 (comma decimal accepted). */
internal fun parseGain(s: String?): Double? {
    if (s.isNullOrEmpty()) return null
    val n = parseFloatJs(s.replaceFirst(',', '.'))
    return if (n.isFinite()) n else null
}

private val MULTI_SPLIT = Regex(
    "[\\s\\u00A0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000\\uFEFF]*;[\\s\\u00A0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000\\uFEFF]*" +
        "|[\\s\\u00A0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000\\uFEFF]*/[\\s\\u00A0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000\\uFEFF]*(?=[0-9a-fA-F]{8}-)",
)

/** Desktop `stringToMulti`: splits on ";" (and "/" before a UUID), trims, drops empties; null when empty. */
internal fun stringToMulti(values: List<String>?): List<String>? {
    if (values == null) return null
    val out = ArrayList<String>()
    for (v in values) {
        val parts = if (v.indexOf(';') < 0 && v.indexOf('/') < 0) listOf(v) else MULTI_SPLIT.split(v)
        for (p in parts) {
            val t = jsTrim(p)
            if (t.isNotEmpty()) out.add(t)
        }
    }
    return out.ifEmpty { null }
}

/** music-metadata `joinArtists`. */
internal fun joinArtists(a: List<String>): String =
    if (a.size > 2) a.subList(0, a.size - 1).joinToString(", ") + " & " + a.last() else a.joinToString(" & ")

/** JS `String.prototype.toUpperCase` (locale-independent). */
internal fun jsUpper(s: String): String = s.uppercase(java.util.Locale.ROOT)

/** ID3v1 / Winamp genre list as used by music-metadata (index = genre byte). */
internal val GENRES: Array<String> = arrayOf(
    "Blues", "Classic Rock", "Country", "Dance", "Disco", "Funk", "Grunge", "Hip-Hop", "Jazz", "Metal", "New Age", "Oldies", "Other",
    "Pop", "R&B", "Rap", "Reggae", "Rock", "Techno", "Industrial", "Alternative", "Ska", "Death Metal", "Pranks", "Soundtrack",
    "Euro-Techno", "Ambient", "Trip-Hop", "Vocal", "Jazz+Funk", "Fusion", "Trance", "Classical", "Instrumental", "Acid", "House",
    "Game", "Sound Clip", "Gospel", "Noise", "Alt. Rock", "Bass", "Soul", "Punk", "Space", "Meditative", "Instrumental Pop",
    "Instrumental Rock", "Ethnic", "Gothic", "Darkwave", "Techno-Industrial", "Electronic", "Pop-Folk", "Eurodance", "Dream",
    "Southern Rock", "Comedy", "Cult", "Gangsta Rap", "Top 40", "Christian Rap", "Pop/Funk", "Jungle", "Native American", "Cabaret",
    "New Wave", "Psychedelic", "Rave", "Showtunes", "Trailer", "Lo-Fi", "Tribal", "Acid Punk", "Acid Jazz", "Polka", "Retro",
    "Musical", "Rock & Roll", "Hard Rock", "Folk", "Folk/Rock", "National Folk", "Swing", "Fast-Fusion", "Bebob", "Latin", "Revival",
    "Celtic", "Bluegrass", "Avantgarde", "Gothic Rock", "Progressive Rock", "Psychedelic Rock", "Symphonic Rock", "Slow Rock",
    "Big Band", "Chorus", "Easy Listening", "Acoustic", "Humour", "Speech", "Chanson", "Opera", "Chamber Music", "Sonata", "Symphony",
    "Booty Bass", "Primus", "Porn Groove", "Satire", "Slow Jam", "Club", "Tango", "Samba", "Folklore", "Ballad", "Power Ballad",
    "Rhythmic Soul", "Freestyle", "Duet", "Punk Rock", "Drum Solo", "A Cappella", "Euro-House", "Dance Hall", "Goa", "Drum & Bass",
    "Club-House", "Hardcore", "Terror", "Indie", "BritPop", "Negerpunk", "Polsk Punk", "Beat", "Christian Gangsta Rap", "Heavy Metal",
    "Black Metal", "Crossover", "Contemporary Christian", "Christian Rock", "Merengue", "Salsa", "Thrash Metal", "Anime", "JPop",
    "Synthpop", "Abstract", "Art Rock", "Baroque", "Bhangra", "Big Beat", "Breakbeat", "Chillout", "Downtempo", "Dub", "EBM",
    "Eclectic", "Electro", "Electroclash", "Emo", "Experimental", "Garage", "Global", "IDM", "Illbient", "Industro-Goth", "Jam Band",
    "Krautrock", "Leftfield", "Lounge", "Math Rock", "New Romantic", "Nu-Breakz", "Post-Punk", "Post-Rock", "Psytrance", "Shoegaze",
    "Space Rock", "Trop Rock", "World Music", "Neoclassical", "Audiobook", "Audio Theatre", "Neue Deutsche Welle", "Podcast",
    "Indie Rock", "G-Funk", "Dubstep", "Garage Rock", "Psybient",
)

private fun parseGenreCode(code: String): String? = when {
    code == "RX" -> "Remix"
    code == "CR" -> "Cover"
    code.all { it in '0'..'9' } -> parseIntJsInt(code)?.let { GENRES.getOrNull(it) }
    else -> null
}

/** music-metadata `parseGenre`: ID3v2.3 "(17)(18)Experimental" style references; bare "17" -> "Rock". */
internal fun parseGenre(orig: String): List<String> {
    val genres = ArrayList<String>(2)
    val word = StringBuilder()
    var offset = 0
    while (offset < orig.length) {
        val open = orig.indexOf('(', offset)
        if (open < 0) { word.append(orig, offset, orig.length); break }
        word.append(orig, offset, open)
        if (open + 1 < orig.length && orig[open + 1] == '(') { word.append('('); offset = open + 2; continue }
        val close = orig.indexOf(')', open + 1)
        if (close < 0) break
        if (word.isNotEmpty()) { genres.add(word.toString()); word.setLength(0) }
        parseGenreCode(orig.substring(open + 1, close))?.let { if (it.isNotEmpty()) genres.add(it) }
        offset = close + 1
    }
    if (word.isNotEmpty()) {
        var w: String? = word.toString()
        if (genres.isEmpty() && w!!.all { it in '0'..'9' }) w = parseGenreCode(w)
        if (!w.isNullOrEmpty()) genres.add(w)
    }
    return genres
}

/** Image type from magic bytes, or null. */
internal fun sniffImageMime(b: ByteArray, off: Int = 0, len: Int = b.size - off): String? {
    fun at(i: Int) = if (i < len) b[off + i].toInt() and 0xFF else -1
    return when {
        at(0) == 0xFF && at(1) == 0xD8 && at(2) == 0xFF -> "image/jpeg"
        at(0) == 0x89 && at(1) == 0x50 && at(2) == 0x4E && at(3) == 0x47 -> "image/png"
        at(0) == 'G'.code && at(1) == 'I'.code && at(2) == 'F'.code && at(3) == '8'.code -> "image/gif"
        at(0) == 'B'.code && at(1) == 'M'.code -> "image/bmp"
        at(0) == 'R'.code && at(1) == 'I'.code && at(2) == 'F'.code && at(3) == 'F'.code &&
            at(8) == 'W'.code && at(9) == 'E'.code && at(10) == 'B'.code && at(11) == 'P'.code -> "image/webp"
        else -> null
    }
}

/** Normalizes a picture MIME the way music-metadata + the desktop do; null means "sniff the bytes". */
internal fun normalizeMime(raw: String?): String? {
    val m = raw?.trim()?.lowercase(java.util.Locale.ROOT)
    if (m.isNullOrEmpty()) return null
    return when (m) {
        "jpg", "jpeg", "image/jpg" -> "image/jpeg"
        "png" -> "image/png"
        else -> if (m.contains('/')) m else "image/$m"
    }
}

/** UTF-8 like TextDecoder("utf-8"): a leading BOM is dropped, malformed input becomes U+FFFD. */
internal fun utf8(b: ByteArray, off: Int = 0, len: Int = b.size - off): String {
    if (len >= 3 && b[off] == 0xEF.toByte() && b[off + 1] == 0xBB.toByte() && b[off + 2] == 0xBF.toByte()) {
        return String(b, off + 3, len - 3, Charsets.UTF_8)
    }
    return String(b, off, len, Charsets.UTF_8)
}
