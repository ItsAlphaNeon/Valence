package app.valence.tags

/**
 * What the library scanner needs from one audio file. Field names follow the desktop's tag schema
 * (src/shared/tag-schema.ts) so a file tagged by the desktop reads back the same on the phone.
 */
data class AudioInfo(
    val codec: String, // "mp3", "flac", "aac", "alac", "opus", "vorbis", "pcm", or "unknown"
    val durationMs: Long,
    val bitrate: Int, // bits per second (average)
    val sampleRate: Int,
    val channels: Int,
    val bitDepth: Int?, // lossless only
    val lossless: Boolean,
)

data class TrackTags(
    val title: String? = null,
    val artist: String? = null,
    /** Individual artist credits (desktop's ARTISTS tag, "; "-joined in ID3), in order. */
    val artists: List<String> = emptyList(),
    val album: String? = null,
    val albumArtist: String? = null,
    val trackNo: Int? = null,
    val trackTotal: Int? = null,
    val discNo: Int? = null,
    val discTotal: Int? = null,
    /** As written: "2024", "2024-05-01", ... */
    val date: String? = null,
    val originalDate: String? = null,
    val genre: String? = null,
    val compilation: Boolean = false,
    val composer: String? = null,
    val comment: String? = null,
    val isrc: String? = null,
    val label: String? = null,
    val bpm: Int? = null,
    val sortTitle: String? = null,
    val sortArtist: String? = null,
    val sortAlbum: String? = null,
    val sortAlbumArtist: String? = null,
    /** Desktop identity (TXXX:VALENCE_ID / VALENCE_ID). */
    val valenceId: String? = null,
    val valenceOwner: String? = null,
    val source: String? = null,
    val sourceQuality: String? = null,
    val mbRecordingId: String? = null,
    val mbReleaseId: String? = null,
    val mbReleaseGroupId: String? = null,
    val mbArtistId: String? = null,
    val mbAlbumArtistId: String? = null,
    val mbTrackId: String? = null,
    val rgTrackGain: Double? = null, // dB
    val rgTrackPeak: Double? = null, // linear
    val rgAlbumGain: Double? = null,
    val rgAlbumPeak: Double? = null,
    /** 0 (unrated) or 1..5 stars, mapped exactly as the desktop reads POPM / RATING. */
    val rating: Int = 0,
    /** Unsynced lyrics frame / LYRICS field; may hold LRC text (desktop stores synced lyrics this way). */
    val lyrics: String? = null,
    /**
     * Every free-form field, upper-cased key -> value: ID3 TXXX descriptions, Vorbis comment names,
     * MP4 "----:com.apple.iTunes:NAME" atoms. Values with several entries are joined with "; ".
     * Lets callers read fields this model doesn't name (e.g. rip metadata).
     */
    val custom: Map<String, String> = emptyMap(),
)

/** Where the front cover sits in the file, so it can be read later without re-parsing the tags. */
data class PictureRef(val mime: String, val offset: Long, val length: Int)

data class ReadResult(val info: AudioInfo, val tags: TrackTags, val picture: PictureRef?)

class UnsupportedFormatException(message: String) : Exception(message)
