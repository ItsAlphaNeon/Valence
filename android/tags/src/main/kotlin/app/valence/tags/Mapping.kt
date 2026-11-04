package app.valence.tags

import kotlin.math.floor
import kotlin.math.log10
import kotlin.math.pow

// The desktop reads tags with music-metadata and then maps them (src/main/tags/read.ts). This file
// ports both halves: Collector emulates music-metadata's native -> common mapping (tag priorities,
// singleton/list rules, artist cross-filling), and toTrackTags ports the desktop's mapTags.

internal enum class TagType(val prio: Int) {
    APE(2), VORBIS(3), ID3V24(4), ID3V23(5), ID3V22(6), EXIF(7), ITUNES(9), AIFF(10), ID3V1(12);

    val isId3v2: Boolean get() = this == ID3V24 || this == ID3V23 || this == ID3V22
}

private const val PRIO_ARTIFICIAL = 500
private const val PRIO_NONE = 1000

/** ID3 COMM / USLT value. */
internal class CommentValue(val descriptor: String, val text: String)

/** ID3 POPM value (rating 0..255). */
internal class PopmValue(val email: String, val rating: Int)

/**
 * One embedded picture. [loader] is null when the image bytes sit unmodified at [refOffset]; otherwise
 * it decodes them (base64, unsynchronisation, zlib) and [refOffset] marks the containing structure.
 */
internal class PictureEntry(
    val pictureType: Int,
    val mime: String?,
    val refOffset: Long,
    val length: Int,
    val loader: (() -> ByteArray)?,
)

internal class NativeTag(val type: TagType, val id: String, val value: Any)

/** music-metadata's "NaN" result of parseInt: occupies the slot but reads as absent. */
private object JsNaN

internal class Ratio(val dB: Double, val ratio: Double)

private val LIST_FIELDS = hashSetOf(
    "artists", "albumartists", "comment", "genre", "composer", "lyrics", "label", "isrc",
    "musicbrainz_artistid", "musicbrainz_albumartistid", "picture",
)
private val UNIQUE_FIELDS = hashSetOf("artists", "albumartists", "genre", "composer", "label")

private val RG_COMMON = listOf("replaygain_track_gain", "replaygain_track_peak", "replaygain_album_gain", "replaygain_album_peak")

private fun rgMap(prefix: String, upper: Boolean = true) = RG_COMMON.associateBy { prefix + if (upper) jsUpper(it) else it }

/** ID3v2.3 / ID3v2.4 (music-metadata id3v24TagMap); keys upper-cased, looked up case-insensitively. */
private val ID3V24_MAP: Map<String, String> = hashMapOf(
    "TIT2" to "title", "TPE1" to "artist", "TXXX:ARTISTS" to "artists", "TPE2" to "albumartist", "TALB" to "album",
    "TDRV" to "date", "TORY" to "originalyear", "TPOS" to "disk", "TCON" to "genre", "APIC" to "picture",
    "TCOM" to "composer", "USLT" to "lyrics", "TSOA" to "albumsort", "TSOT" to "titlesort", "TSOP" to "artistsort",
    "TSO2" to "albumartistsort", "TPUB" to "label", "TRCK" to "track", "TCMP" to "compilation", "TBPM" to "bpm",
    "TXXX:ISRC" to "isrc", "TSRC" to "isrc", "TXXX:ORIGINALYEAR" to "originalyear",
    "UFID:HTTP://MUSICBRAINZ.ORG" to "musicbrainz_recordingid",
    "TXXX:MUSICBRAINZ RELEASE TRACK ID" to "musicbrainz_trackid",
    "TXXX:MUSICBRAINZ ALBUM ID" to "musicbrainz_albumid",
    "TXXX:MUSICBRAINZ ARTIST ID" to "musicbrainz_artistid",
    "TXXX:MUSICBRAINZ ALBUM ARTIST ID" to "musicbrainz_albumartistid",
    "TXXX:MUSICBRAINZ RELEASE GROUP ID" to "musicbrainz_releasegroupid",
    "TDRC" to "date", "TYER" to "year", "TDOR" to "originaldate", "SYLT" to "lyrics", "COMM" to "comment",
    "TXXX:DISCOGS_ARTISTS" to "artists", "TXXX:DISCOGS_ARTIST_NAME" to "artists",
    "TXXX:DISCOGS_ALBUM_ARTISTS" to "albumartists", "TXXX:DISCOGS_DATE" to "originaldate",
    "TXXX:DISCOGS_LABEL" to "label", "TXXX:DISCOGS_RELEASED" to "date", "TXXX:STYLE" to "genre",
).apply { putAll(rgMap("TXXX:")) }

/** ID3v2.2 (music-metadata id3v22TagMap). TXX frames are read as TXXX, so those keys fall through to the v2.4 map. */
private val ID3V22_MAP: Map<String, String> = hashMapOf(
    "TT2" to "title", "TP1" to "artist", "TP2" to "albumartist", "TAL" to "album", "TYE" to "year", "COM" to "comment",
    "ULT" to "lyrics", "TRK" to "track", "TPA" to "disk", "TCO" to "genre", "PIC" to "picture", "TCM" to "composer",
    "TOR" to "originaldate", "TPB" to "label", "TCP" to "compilation", "TDR" to "date", "TS2" to "albumartistsort",
    "TSA" to "albumsort", "TSP" to "artistsort", "TST" to "titlesort", "TBP" to "bpm",
)

/** Vorbis comments (keys are upper-cased by the parser; the map itself is case-sensitive). */
private val VORBIS_MAP: Map<String, String> = hashMapOf(
    "TITLE" to "title", "ARTIST" to "artist", "ARTISTS" to "artists", "ALBUMARTIST" to "albumartist",
    "ALBUM ARTIST" to "albumartist", "ALBUM" to "album", "DATE" to "date", "ORIGINALDATE" to "originaldate",
    "ORIGINALYEAR" to "originalyear", "COMMENT" to "comment", "DESCRIPTION" to "comment", "TRACKNUMBER" to "track",
    "DISCNUMBER" to "disk", "GENRE" to "genre", "METADATA_BLOCK_PICTURE" to "picture", "COMPOSER" to "composer",
    "LYRICS" to "lyrics", "UNSYNCEDLYRICS" to "lyrics", "ALBUMSORT" to "albumsort", "TITLESORT" to "titlesort",
    "ARTISTSORT" to "artistsort", "ALBUMARTISTSORT" to "albumartistsort", "LABEL" to "label",
    "ORGANIZATION" to "label", "PUBLISHER" to "label", "TRACKTOTAL" to "totaltracks", "DISCTOTAL" to "totaldiscs",
    "COMPILATION" to "compilation", "BPM" to "bpm", "ISRC" to "isrc",
    "MUSICBRAINZ_TRACKID" to "musicbrainz_recordingid", "MUSICBRAINZ_RELEASETRACKID" to "musicbrainz_trackid",
    "MUSICBRAINZ_ALBUMID" to "musicbrainz_albumid", "MUSICBRAINZ_ARTISTID" to "musicbrainz_artistid",
    "MUSICBRAINZ_ALBUMARTISTID" to "musicbrainz_albumartistid",
    "MUSICBRAINZ_RELEASEGROUPID" to "musicbrainz_releasegroupid", "TOTALTRACKS" to "totaltracks",
    "TOTALDISCS" to "totaldiscs", "DISCOGS_ARTISTS" to "artists", "DISCOGS_ARTIST_NAME" to "artists",
    "DISCOGS_ALBUM_ARTISTS" to "albumartists", "DISCOGS_DATE" to "originaldate", "DISCOGS_LABEL" to "label",
    "DISCOGS_RELEASED" to "date", "STYLE" to "genre",
).apply { putAll(rgMap("")) }

private const val ITUNES = "----:COM.APPLE.ITUNES:"

/** MP4 ilst (music-metadata mp4TagMap); keys upper-cased, looked up case-insensitively. */
private val MP4_MAP: Map<String, String> = hashMapOf(
    "©NAM" to "title", "©ART" to "artist", "AART" to "albumartist", "${ITUNES}BAND" to "albumartist",
    "©ALB" to "album", "©DAY" to "date", "©CMT" to "comment", "©COM" to "comment", "TRKN" to "track",
    "DISK" to "disk", "©GEN" to "genre", "COVR" to "picture", "©WRT" to "composer", "©LYR" to "lyrics",
    "SOAL" to "albumsort", "SONM" to "titlesort", "SOAR" to "artistsort", "SOAA" to "albumartistsort",
    "${ITUNES}LABEL" to "label", "CPIL" to "compilation", "TMPO" to "bpm", "${ITUNES}ISRC" to "isrc",
    "${ITUNES}NOTES" to "comment", "${ITUNES}MUSICBRAINZ TRACK ID" to "musicbrainz_recordingid",
    "${ITUNES}MUSICBRAINZ RELEASE TRACK ID" to "musicbrainz_trackid",
    "${ITUNES}MUSICBRAINZ ALBUM ID" to "musicbrainz_albumid",
    "${ITUNES}MUSICBRAINZ ARTIST ID" to "musicbrainz_artistid",
    "${ITUNES}MUSICBRAINZ ALBUM ARTIST ID" to "musicbrainz_albumartistid",
    "${ITUNES}MUSICBRAINZ RELEASE GROUP ID" to "musicbrainz_releasegroupid",
    "GNRE" to "genre", "${ITUNES}ALBUMARTISTSORT" to "albumartistsort", "${ITUNES}ARTISTS" to "artists",
    "${ITUNES}ORIGINALDATE" to "originaldate", "${ITUNES}ORIGINALYEAR" to "originalyear",
).apply { putAll(rgMap(ITUNES)) }

/** APEv2 (music-metadata apev2TagMap); keys upper-cased, looked up case-insensitively. */
private val APE_MAP: Map<String, String> = hashMapOf(
    "TITLE" to "title", "ARTIST" to "artist", "ARTISTS" to "artists", "ALBUM ARTIST" to "albumartist",
    "ALBUM" to "album", "YEAR" to "date", "DATE" to "date", "ORIGINALYEAR" to "originalyear",
    "ORIGINALDATE" to "originaldate", "COMMENT" to "comment", "TRACK" to "track", "DISC" to "disk",
    "DISCNUMBER" to "disk", "GENRE" to "genre", "COVER ART (FRONT)" to "picture", "COVER ART (BACK)" to "picture",
    "COMPOSER" to "composer", "LYRICS" to "lyrics", "ALBUMSORT" to "albumsort", "TITLESORT" to "titlesort",
    "ARTISTSORT" to "artistsort", "ALBUMARTISTSORT" to "albumartistsort", "LABEL" to "label",
    "COMPILATION" to "compilation", "BPM" to "bpm", "ISRC" to "isrc",
    "MUSICBRAINZ_TRACKID" to "musicbrainz_recordingid", "MUSICBRAINZ_RELEASETRACKID" to "musicbrainz_trackid",
    "MUSICBRAINZ_ALBUMID" to "musicbrainz_albumid", "MUSICBRAINZ_ARTISTID" to "musicbrainz_artistid",
    "MUSICBRAINZ_ALBUMARTISTID" to "musicbrainz_albumartistid",
    "MUSICBRAINZ_RELEASEGROUPID" to "musicbrainz_releasegroupid",
    "REPLAYGAIN_TRACK_GAIN" to "replaygain_track_gain", "REPLAYGAIN_TRACK_PEAK" to "replaygain_track_peak",
)

/** RIFF LIST/INFO (music-metadata riffInfoTagMap, fields the desktop maps). */
private val EXIF_MAP: Map<String, String> = hashMapOf(
    "IART" to "artist", "ICRD" to "date", "INAM" to "title", "TITL" to "title", "IPRD" to "album", "ITRK" to "track",
    "IPRT" to "track", "COMM" to "comment", "ICMT" to "comment", "GNRE" to "genre", "YEAR" to "year",
    "IGNR" to "genre", "IRPD" to "album",
)

/** AIFF text chunks (music-metadata AiffTagMap). */
private val AIFF_MAP: Map<String, String> = hashMapOf("NAME" to "title", "AUTH" to "artist", "ANNO" to "comment")

private val ID3V1_MAP: Map<String, String> = hashMapOf(
    "title" to "title", "artist" to "artist", "album" to "album", "year" to "year", "comment" to "comment",
    "track" to "track", "genre" to "genre",
)

/** Collects native tags in file order and keeps music-metadata's `common` view up to date. */
internal class Collector {
    val native = ArrayList<NativeTag>()
    private val single = HashMap<String, Any>()
    private val lists = HashMap<String, MutableList<Any>>()
    private val origin = HashMap<String, Int>()
    var trackNo: Int? = null
    var trackOf: Int? = null
    var diskNo: Int? = null
    var diskOf: Int? = null
    private var vorbisHasStandardDate = false

    fun add(type: TagType, id: String, value: Any) {
        native.add(NativeTag(type, id, value))
        val common = commonName(type, id, value) ?: return
        postMap(type.prio, common, value)
    }

    private fun commonName(type: TagType, id: String, value: Any): String? = when (type) {
        TagType.VORBIS -> {
            if (id == "DATE") {
                if (value !is String || jsTrim(value).isEmpty()) return null
                vorbisHasStandardDate = true
            } else if (id == "DISCOGS_RELEASED" && vorbisHasStandardDate) return null
            VORBIS_MAP[id]
        }
        TagType.ID3V24, TagType.ID3V23 -> ID3V24_MAP[jsUpper(id)]
        TagType.ID3V22 -> jsUpper(id).let { ID3V22_MAP[it] ?: if (it.startsWith("TXXX:")) ID3V24_MAP[it] else null }
        TagType.ITUNES -> MP4_MAP[jsUpper(id)]
        TagType.APE -> APE_MAP[jsUpper(id)]
        TagType.ID3V1 -> ID3V1_MAP[id]
        TagType.EXIF -> EXIF_MAP[id]
        TagType.AIFF -> AIFF_MAP[id]
    }

    /** music-metadata MetadataCollector.postMap. */
    fun postMap(prio: Int, id: String, value0: Any) {
        var value: Any = value0
        when (id) {
            "artist" -> return singularArtist(prio, value, "artist", "artists")
            "albumartist" -> return singularArtist(prio, value, "albumartist", "albumartists")
            "artists" -> return pluralArtist(prio, value, "artist", "artists")
            "albumartists" -> return pluralArtist(prio, value, "albumartist", "albumartists")
            "picture" -> {
                val p = value as? PictureEntry ?: return
                if (p.length <= 0 || p.mime == null) return
            }
            "totaltracks" -> { trackOf = parseIntJsInt(value.toString()); return }
            "totaldiscs" -> { diskOf = parseIntJsInt(value.toString()); return }
            "track", "disk" -> {
                val parts = value.toString().split('/', limit = 3)
                val no = parseIntJsInt(parts[0])?.takeIf { it != 0 }
                val of = parts.getOrNull(1)?.let { parseIntJsInt(it) }?.takeIf { it != 0 }
                if (id == "track") { trackNo = no; trackOf = trackOf ?: of } else { diskNo = no; diskOf = diskOf ?: of }
                return
            }
            "bpm", "year", "originalyear" -> value = parseIntJsInt(value.toString()) ?: JsNaN
            "date" -> {
                val s = value.toString()
                parseIntJsInt(s.take(4))?.let { single["year"] = it }
            }
            "replaygain_track_gain", "replaygain_track_peak", "replaygain_album_gain", "replaygain_album_peak" ->
                value = toRatio(value.toString())
            "compilation" -> value = value == "1" || value == 1L || value == 1 || value == true
            "isrc" -> if (lists["isrc"]?.contains(value) == true) return
            "comment" -> if (value is String) value = CommentValue("", value)
            "lyrics" -> if (value is String) value = CommentValue("", value)
        }
        setGeneric(prio, id, value)
    }

    private fun singularArtist(prio: Int, value: Any, singular: String, plural: String) {
        if (origin[singular] == prio) return postMap(PRIO_ARTIFICIAL, plural, value)
        if (lists[plural] == null) setGeneric(PRIO_ARTIFICIAL, plural, value)
        setGeneric(prio, singular, value)
    }

    private fun pluralArtist(prio: Int, value: Any, singular: String, plural: String) {
        if (single[singular] == null || origin[singular] == PRIO_ARTIFICIAL) {
            val existing = lists[plural]
            if (existing == null || !existing.contains(value)) {
                val all = (existing ?: emptyList<Any>()) + value
                setGeneric(PRIO_ARTIFICIAL, singular, joinArtists(all.map { it.toString() }))
            }
        }
        setGeneric(prio, plural, value)
    }

    private fun setGeneric(prio1: Int, id: String, value: Any) {
        val prio0 = origin[id] ?: PRIO_NONE
        if (id !in LIST_FIELDS) {
            if (prio1 <= prio0) {
                single[id] = value
                origin[id] = prio1
            }
        } else {
            val list = lists[id]
            if (prio1 == prio0 && list != null) {
                if (id !in UNIQUE_FIELDS || !list.contains(value)) list.add(value)
            } else if (prio1 < prio0) {
                lists[id] = arrayListOf(value)
                origin[id] = prio1
            }
        }
    }

    fun str(id: String): String? = single[id] as? String
    fun int(id: String): Int? = single[id] as? Int
    fun bool(id: String): Boolean = single[id] == true
    fun ratio(id: String): Ratio? = single[id] as? Ratio
    fun list(id: String): List<Any> = lists[id] ?: emptyList()
    fun strings(id: String): List<String> = list(id).map { it.toString() }
    fun pictures(): List<PictureEntry> = list("picture").filterIsInstance<PictureEntry>()
}

/** music-metadata toRatio. */
private fun toRatio(value: String): Ratio {
    val ps = value.split(' ', limit = 3).take(2).map { jsTrim(it).lowercase(java.util.Locale.ROOT) }
    val v = parseFloatJs(ps[0])
    return if (ps.size == 2 && ps[1] == "db") Ratio(v, 10.0.pow(v / 10)) else Ratio(10 * log10(v), v)
}

/** JS `Number(s)` for the plain decimal strings tags hold; NaN otherwise. */
private fun jsNumber(s: String?): Double {
    if (s == null) return Double.NaN
    val t = jsTrim(s)
    if (t.isEmpty()) return 0.0
    if (!NUMBER.matches(t)) return when (t) {
        "Infinity", "+Infinity" -> Double.POSITIVE_INFINITY
        "-Infinity" -> Double.NEGATIVE_INFINITY
        else -> Double.NaN
    }
    return t.toDouble()
}

private val NUMBER = Regex("[+-]?(\\d+\\.?\\d*|\\.\\d+)([eE][+-]?\\d+)?")
private val FOUR_DIGITS = Regex("\\d{4}")
private val LYRICS_KEY = Regex("^(UNSYNCED)?LYRICS$", RegexOption.IGNORE_CASE)

/** Desktop popmToStars (tag-schema.ts). */
internal fun popmToStars(v: Double): Int = when {
    v.isNaN() || v == 0.0 -> 0
    v < 32 -> 1
    v < 96 -> 2
    v < 160 -> 3
    v < 224 -> 4
    else -> 5
}

private fun jsRound(x: Double): Double = floor(x + 0.5)

private fun nativeValue(v: Any): String? = when (v) {
    is String -> v
    is Long, is Int -> v.toString()
    is CommentValue -> v.text
    else -> null
}

/** Desktop customMap: free-form fields plus a few pseudo-keys (POPM:<owner>, RAWLYRICS, ID3DATE ...). */
private fun customMap(native: List<NativeTag>): Map<String, MutableList<String>> {
    val out = LinkedHashMap<String, MutableList<String>>()
    fun push(k: String, v: String?) {
        if (v.isNullOrEmpty()) return
        out.getOrPut(jsUpper(k)) { ArrayList(1) }.add(v)
    }
    for (t in native) {
        val id = t.id
        when (t.type) {
            TagType.ID3V24, TagType.ID3V23, TagType.ID3V22 -> when {
                id.startsWith("TXXX:") -> push(id.substring(5), nativeValue(t.value))
                id == "POPM" || id == "POP" -> (t.value as? PopmValue)?.let { push("POPM:${it.email}", it.rating.toString()) }
                id == "USLT" || id == "ULT" -> push("RAWLYRICS", nativeValue(t.value))
                id == "TDOR" || id == "TORY" || id == "TOR" -> push("ORIGINALDATE", nativeValue(t.value))
                id == "TYER" || id == "TDRC" || id == "TYE" -> push("ID3DATE", nativeValue(t.value))
                id == "TDAT" || id == "TDA" -> push("ID3TDAT", nativeValue(t.value))
            }
            TagType.VORBIS -> {
                push(id, nativeValue(t.value))
                if (LYRICS_KEY.matches(id)) push("RAWLYRICS", nativeValue(t.value))
            }
            TagType.ITUNES -> when {
                id.startsWith("----:") -> push(id.split(':').drop(2).joinToString(":"), nativeValue(t.value))
                id == "©lyr" -> push("RAWLYRICS", nativeValue(t.value))
            }
            else -> {}
        }
    }
    return out
}

/** The model's `custom`: every free-form field (TXXX, Vorbis, MP4 freeform), multi-values joined by "; ". */
private fun freeFormFields(native: List<NativeTag>): Map<String, String> {
    val out = LinkedHashMap<String, MutableList<String>>()
    for (t in native) {
        val key = when {
            t.type.isId3v2 && t.id.startsWith("TXXX:") -> t.id.substring(5)
            t.type == TagType.VORBIS -> if (t.id == "METADATA_BLOCK_PICTURE" || t.id == "COVERART") null else t.id
            t.type == TagType.ITUNES && t.id.startsWith("----:") -> t.id.split(':').drop(2).joinToString(":")
            else -> null
        }
        if (key.isNullOrEmpty()) continue
        val v = nativeValue(t.value)
        if (v.isNullOrEmpty()) continue
        out.getOrPut(jsUpper(key)) { ArrayList(1) }.add(v)
    }
    val m = LinkedHashMap<String, String>(out.size * 2)
    for ((k, v) in out) m[k] = v.joinToString("; ")
    return m
}

/** [TrackTags key, ID3 TXXX description, Vorbis key, MP4 freeform name] (tag-schema.ts CUSTOM_FIELDS), model fields only. */
private enum class CustomField(val id3: String, val vorbis: String, val mp4: String) {
    ARTISTS("ARTISTS", "ARTISTS", "ARTISTS"),
    MB_TRACK("MusicBrainz Release Track Id", "MUSICBRAINZ_RELEASETRACKID", "MusicBrainz Release Track Id"),
    MB_ALBUM("MusicBrainz Album Id", "MUSICBRAINZ_ALBUMID", "MusicBrainz Album Id"),
    MB_GROUP("MusicBrainz Release Group Id", "MUSICBRAINZ_RELEASEGROUPID", "MusicBrainz Release Group Id"),
    MB_ARTIST("MusicBrainz Artist Id", "MUSICBRAINZ_ARTISTID", "MusicBrainz Artist Id"),
    MB_ALBUM_ARTIST("MusicBrainz Album Artist Id", "MUSICBRAINZ_ALBUMARTISTID", "MusicBrainz Album Artist Id"),
    ORIGINALDATE("ORIGINALDATE", "ORIGINALDATE", "ORIGINALDATE"),
    VALENCE_ID("VALENCE_ID", "VALENCE_ID", "VALENCE_ID"),
    VALENCE_OWNER("VALENCE_OWNER", "VALENCE_OWNER", "VALENCE_OWNER"),
    SOURCE("VALENCE_SOURCE", "VALENCE_SOURCE", "VALENCE_SOURCE"),
    SOURCE_QUALITY("VALENCE_SOURCE_QUALITY", "VALENCE_SOURCE_QUALITY", "VALENCE_SOURCE_QUALITY"),
}

/** The picture the desktop shows: the highest-priority tag's pictures, front cover first, else the first. */
internal fun choosePicture(c: Collector): PictureEntry? {
    val pics = c.pictures()
    return pics.firstOrNull { it.pictureType == 3 } ?: pics.firstOrNull()
}

/** Port of the desktop's mapTags (src/main/tags/read.ts). */
internal fun toTrackTags(c: Collector): TrackTags {
    val custom = customMap(c.native)
    fun cv(k: String): String? = custom[jsUpper(k)]?.firstOrNull()
    fun clean(s: String?): String? = cleanOrNull(s)

    val cArtist = c.str("artist")
    var artists = stringToMulti(custom["ARTISTS"] ?: c.strings("artists").ifEmpty { null })
        ?.takeIf { it.size > 1 || it[0] != cArtist }

    // ID3v2.3: TYER (YYYY) + TDAT (DDMM)
    val tyer = custom["ID3DATE"]?.firstOrNull()
    val tdat = custom["ID3TDAT"]?.firstOrNull()
    val date = when {
        tyer != null && FOUR_DIGITS.matches(tyer) && tdat != null && FOUR_DIGITS.matches(tdat) ->
            "$tyer-${tdat.substring(2)}-${tdat.substring(0, 2)}"
        !c.str("date").isNullOrEmpty() -> c.str("date")!!.take(10)
        (c.int("year") ?: 0) != 0 -> c.int("year").toString()
        else -> null
    }
    var originalDate: String? = c.str("originaldate") ?: cv("ORIGINALDATE")
        ?: c.int("originalyear")?.takeIf { it != 0 }?.toString()
    originalDate = clean(originalDate)

    var mbTrackId = clean(c.str("musicbrainz_trackid") ?: cv("MusicBrainz Release Track Id") ?: cv("MUSICBRAINZ_RELEASETRACKID"))
    var mbReleaseId = clean(c.str("musicbrainz_albumid"))
    var mbGroupId = clean(c.str("musicbrainz_releasegroupid"))
    var mbArtistIds = stringToMulti(c.strings("musicbrainz_artistid").ifEmpty { null })
    var mbAlbumArtistIds = stringToMulti(c.strings("musicbrainz_albumartistid").ifEmpty { null })

    val rg = DoubleArray(4) { Double.NaN }
    for ((i, key) in RG_COMMON.withIndex()) {
        var v = parseGain(cv(jsUpper(key)))
        if (v == null) {
            val r = c.ratio(key)
            if (r != null) v = if (key.endsWith("peak")) r.ratio else r.dB
        }
        if (v != null && v.isFinite()) rg[i] = v
    }

    val lyr = c.list("lyrics").firstOrNull() as? CommentValue
    val lyricsText = custom["RAWLYRICS"]?.firstOrNull() ?: lyr?.text
    val lyrics = if (lyricsText != null && jsTrim(lyricsText).isNotEmpty()) lyricsText.replace("\r\n", "\n") else null

    var rating = 0
    val popm = custom["POPM:WINDOWS MEDIA PLAYER 9 SERIES"]?.firstOrNull()
        ?: custom.entries.firstOrNull { it.key.startsWith("POPM:") }?.value?.firstOrNull()
    if (popm != null) {
        rating = popmToStars(jsNumber(popm))
    } else {
        val r = jsNumber(cv("RATING"))
        if (r > 0) rating = if (r <= 5) jsRound(r).toInt() else jsRound(r / 20).coerceIn(1.0, 5.0).toInt()
    }

    var valenceId: String? = null
    var valenceOwner: String? = null
    var source: String? = null
    var sourceQuality: String? = null
    for (f in CustomField.entries) {
        val already = when (f) {
            CustomField.ARTISTS -> artists != null
            CustomField.MB_TRACK -> mbTrackId != null
            CustomField.MB_ALBUM -> mbReleaseId != null
            CustomField.MB_GROUP -> mbGroupId != null
            CustomField.MB_ARTIST -> mbArtistIds != null
            CustomField.MB_ALBUM_ARTIST -> mbAlbumArtistIds != null
            CustomField.ORIGINALDATE -> originalDate != null
            else -> false
        }
        if (already) continue
        val v = cv(f.id3) ?: cv(f.vorbis) ?: cv(f.mp4) ?: continue
        when (f) {
            CustomField.ARTISTS -> artists = stringToMulti(listOf(v))
            CustomField.MB_TRACK -> mbTrackId = v
            CustomField.MB_ALBUM -> mbReleaseId = v
            CustomField.MB_GROUP -> mbGroupId = v
            CustomField.MB_ARTIST -> mbArtistIds = stringToMulti(listOf(v))
            CustomField.MB_ALBUM_ARTIST -> mbAlbumArtistIds = stringToMulti(listOf(v))
            CustomField.ORIGINALDATE -> originalDate = v
            CustomField.VALENCE_ID -> valenceId = v
            CustomField.VALENCE_OWNER -> valenceOwner = v
            CustomField.SOURCE -> source = v
            CustomField.SOURCE_QUALITY -> sourceQuality = v
        }
    }

    val comment = c.list("comment").firstOrNull()?.let { if (it is CommentValue) it.text else it.toString() }
    return TrackTags(
        title = clean(c.str("title")),
        artist = clean(cArtist),
        artists = artists ?: emptyList(),
        album = clean(c.str("album")),
        albumArtist = clean(c.str("albumartist")),
        trackNo = c.trackNo,
        trackTotal = c.trackOf,
        discNo = c.diskNo,
        discTotal = c.diskOf,
        date = clean(date),
        originalDate = originalDate,
        genre = clean(c.strings("genre").firstOrNull()),
        compilation = c.bool("compilation"),
        composer = clean(c.strings("composer").firstOrNull()),
        comment = clean(comment),
        isrc = clean(c.strings("isrc").firstOrNull()),
        label = clean(c.strings("label").firstOrNull()),
        bpm = c.int("bpm"),
        sortTitle = clean(c.str("titlesort")),
        sortArtist = clean(c.str("artistsort")),
        sortAlbum = clean(c.str("albumsort")),
        sortAlbumArtist = clean(c.str("albumartistsort")),
        valenceId = valenceId,
        valenceOwner = valenceOwner,
        source = source,
        sourceQuality = sourceQuality,
        mbRecordingId = clean(c.str("musicbrainz_recordingid")),
        mbReleaseId = mbReleaseId,
        mbReleaseGroupId = mbGroupId,
        mbArtistId = mbArtistIds?.joinToString("; "),
        mbAlbumArtistId = mbAlbumArtistIds?.joinToString("; "),
        mbTrackId = mbTrackId,
        rgTrackGain = rg[0].takeIf { !it.isNaN() },
        rgTrackPeak = rg[1].takeIf { !it.isNaN() },
        rgAlbumGain = rg[2].takeIf { !it.isNaN() },
        rgAlbumPeak = rg[3].takeIf { !it.isNaN() },
        rating = rating,
        lyrics = lyrics,
        custom = freeFormFields(c.native),
    )
}
