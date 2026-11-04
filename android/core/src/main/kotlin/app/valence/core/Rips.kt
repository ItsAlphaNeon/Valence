package app.valence.core

import java.io.File
import java.util.regex.Pattern

/**
 * High Quality Rips: the HQ_RIP tag, SiIvaGunner seasons (src/main/sources/youtube/seasons.ts),
 * season album order (RipsView.tsx) and the game half of a rip title (metadata.ts).
 */
object Rips {
    /** Tag (TXXX / Vorbis comment / iTunes freeform) whose non-empty value marks a rip. */
    const val TAG = "HIGH QUALITY RIP"

    /** Genre the desktop gives rips. */
    const val GENRE = "High Quality Rip"

    /** A track is a rip when its hq_rip value is non-empty. */
    fun isRip(hqRip: String?): Boolean = !hqRip.isNullOrEmpty()

    data class Season(val key: String, val name: String, val start: String) {
        /** Album title of the season, e.g. "SiIvaGunner: Season 7 – The Year of Grand Dad". */
        val album: String get() = seasonAlbum(name)
    }

    val DEFAULT_SEASONS: List<Season> = listOf(
        Season("s1", "Season 1", "2016-01-09"),
        Season("s2", "Season 2", "2016-10-19"),
        Season("s3", "Season 3", "2018-01-01"),
        Season("s4", "Season 4", "2019-03-26"),
        Season("s4e2", "Season 4 Episode 2", "2020-02-01"),
        Season("s5", "Season 5", "2021-01-04"),
        Season("s6", "Season 6", "2022-01-31"),
        Season("s7", "Season 7: The Year of Grand Dad", "2023-02-01"),
        Season("s8", "Season 8", "2024-01-18"),
        Season("s9", "Season 9", "2025-01-24"),
        Season("sx", "Season X", "2026-01-07"),
    )

    /** The synced season table `<valenceDir>/rips/seasons.json`, or [DEFAULT_SEASONS] if missing or invalid (sorted by start). */
    fun seasons(valenceDir: File): List<Season> {
        return try {
            val text = File(File(valenceDir, "rips"), "seasons.json").readText(Charsets.UTF_8)
            val doc = JsJson.parse(text)
            validateSeasons((doc as? Map<*, *>)?.get("seasons")) ?: DEFAULT_SEASONS
        } catch (_: Exception) {
            DEFAULT_SEASONS
        }
    }

    private val SPACE_CLASS = "[\\t\\n\\u000B\\u000C\\r \\u00A0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000\\uFEFF]"
    private val DATE = Regex("\\d{4}-(\\d{2})-(\\d{2})")
    private val NON_ALNUM = Regex("[^a-z0-9]+")

    /** The desktop's validateSeasons; null where it would throw. */
    internal fun validateSeasons(input: Any?): List<Season>? {
        if (input !is List<*> || input.isEmpty()) return null
        val out = ArrayList<Season>()
        val keys = HashSet<String>()
        val names = HashSet<String>()
        for (raw in input) {
            if (raw == null || raw == JsonNull) return null
            val s = raw as? Map<*, *>
            fun field(k: String): String {
                val v = s?.get(k)
                return Js.trim(if (v == null || v == JsonNull) "" else Js.toJsString(v))
            }
            val name = field("name")
            val start = field("start")
            val key = field("key").ifEmpty { "s-" + NON_ALNUM.replace(Js.lower(name), "-") }
            if (name.isEmpty()) return null
            val m = DATE.matchEntire(start) ?: return null
            if (m.groupValues[1].toInt() !in 1..12 || m.groupValues[2].toInt() !in 1..31) return null
            if (!keys.add(key)) return null
            if (!names.add(Js.lower(name))) return null
            out.add(Season(key, name, start))
        }
        return out.sortedWith { a, b -> a.start.compareTo(b.start) }
    }

    /** "SiIvaGunner: " + name with its first colon turned into an en dash. */
    fun seasonAlbum(name: String): String = "SiIvaGunner: " + Regex("$SPACE_CLASS*:$SPACE_CLASS*").replaceFirst(name, " – ")

    /** The season of an upload time (ISO 8601): the latest that started on or before it, else the first. */
    fun seasonFor(uploaded: String, seasons: List<Season>): Season {
        require(seasons.isNotEmpty()) { "no seasons" }
        val day = uploaded.take(10)
        val sorted = seasons.sortedWith { a, b -> a.start.compareTo(b.start) }
        var hit = sorted[0]
        for (s in sorted) if (s.start <= day) hit = s
        return hit
    }

    // ASCII-only case folding, like a non-unicode JS /i regex (Kotlin's IGNORE_CASE would fold "ſ" to "s").
    private val SEASON_NO = Pattern.compile("season$SPACE_CLASS+(x|\\d+)($SPACE_CLASS+episode$SPACE_CLASS+(\\d+))?", Pattern.CASE_INSENSITIVE).toRegex()

    /** The desktop's RipsView seasonOrder: "Season 4 Episode 2" -> 4.2, "Season X" -> 10, no season -> 1000. */
    fun seasonNumber(title: String): Double {
        val m = SEASON_NO.find(title) ?: return 1000.0
        val n = if (m.groupValues[1].equals("x", ignoreCase = true)) 10.0 else m.groupValues[1].toDouble()
        val ep = m.groups[3]?.value
        return n + (if (ep != null) ep.toDouble() / 10 else 0.0)
    }

    /**
     * Sort rank of a season album in the Seasons view: its index in the season table (matched by
     * album title, see [Season.album]), else 100 + [seasonNumber].
     */
    fun seasonOrder(title: String, seasons: List<Season>): Double {
        val i = seasons.indexOfFirst { it.album == title }
        return if (i >= 0) i.toDouble() else 100 + seasonNumber(title)
    }

    /** [seasonOrder] against [DEFAULT_SEASONS]. */
    fun seasonOrder(title: String): Double = seasonOrder(title, DEFAULT_SEASONS)

    private val LEADING_DASH = Regex("^$SPACE_CLASS*[-–—]$SPACE_CLASS*")

    /** The game half of a rip title: what follows the "Music:" track name, else the text after the last " - ". */
    fun gameFromTitle(title: String, music: String? = null): String? {
        val t = Js.trim(title)
        if (!music.isNullOrEmpty()) {
            val m = Js.trim(music)
            if (Js.lower(t).startsWith(Js.lower(m))) {
                val rest = Js.trim(LEADING_DASH.replaceFirst(t.substring(minOf(m.length, t.length)), ""))
                if (rest.isNotEmpty()) return rest
            }
        }
        val i = t.lastIndexOf(" - ")
        return if (i > 0) Js.trim(t.substring(i + 3)).ifEmpty { null } else null
    }
}
