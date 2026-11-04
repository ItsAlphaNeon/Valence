package app.valence.data

import androidx.compose.runtime.Immutable

/** Which part of the library a list shows: the main library, the SiivaGunner rips, or both. */
enum class Collection { Main, Rips, All }

@Immutable
data class Track(
    val id: Long,
    val relPath: String,
    val trackKey: String,
    val title: String,
    val artist: String,
    val album: String,
    val albumArtist: String,
    val albumId: Long?,
    val trackNo: Int?,
    val discNo: Int?,
    val year: Int?,
    val genre: String?,
    val composer: String?,
    val durationMs: Long,
    val codec: String?,
    val bitrate: Int?,
    val sampleRate: Int?,
    val bitDepth: Int?,
    val lossless: Boolean,
    val rating: Int,
    val hasArt: Boolean,
    val lyricsKind: Int, // 0 none, 1 plain, 2 synced
    val hqRip: String,
    val ripGame: String?,
    val addedAt: Long,
    val playCount: Int,
    val skipCount: Int,
    val lastPlayed: Long?,
    val liked: Boolean,
    val rgTrackGain: Double?,
    val rgTrackPeak: Double?,
    val rgAlbumGain: Double?,
    val rgAlbumPeak: Double?,
    val mtime: Long,
) {
    val isRip get() = hqRip.isNotEmpty()
}

@Immutable
data class Album(
    val id: Long,
    val key: String,
    val title: String,
    val albumArtist: String,
    val year: Int?,
    val genre: String?,
    val trackCount: Int,
    val durationMs: Long,
    val artTrackId: Long?,
    val hqRip: String,
    val relDir: String,
    val addedAt: Long,
    val liked: Boolean,
)

@Immutable
data class Artist(val name: String, val albumCount: Int, val trackCount: Int, val artTrackId: Long?, val liked: Boolean)

@Immutable
data class Genre(val name: String, val trackCount: Int, val artTrackId: Long?)

@Immutable
data class FolderEntry(val name: String, val relPath: String, val trackCount: Int, val artTrackId: Long?)

@Immutable
data class Playlist(
    val id: String,
    val name: String,
    /** "static" (an .m3u8 the phone may edit), "mirror" (desktop-owned copy of a TIDAL/Bandcamp list), "smart". */
    val kind: String,
    val relPath: String?,
    val itemCount: Int,
    val artTrackId: Long?,
) {
    val editable get() = kind == "static"
}

/** Built-in playlists computed from the library (like Musicolet's and the desktop's). */
enum class AutoList(val title: String) {
    Liked("Liked songs"),
    RecentlyAdded("Recently added"),
    MostPlayed("Most played"),
    RecentlyPlayed("Recently played"),
    NeverPlayed("Never played"),
}

data class ScanState(val running: Boolean = false, val done: Int = 0, val total: Int = 0, val message: String = "", val lastFinished: Long = 0)

data class LibraryCounts(val tracks: Int = 0, val albums: Int = 0, val artists: Int = 0, val rips: Int = 0, val durationMs: Long = 0)
