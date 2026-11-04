package app.valence.data

import android.database.Cursor
import app.valence.core.Keys
import app.valence.core.Rips
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.conflate
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.flowOn
import kotlinx.coroutines.flow.mapLatest
import java.io.File

/**
 * Read side of the phone's index. Every list is a Flow that re-runs its query when the tables
 * it reads change (Db topics), so screens update after a scan, a log ingest or a like.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class Library(private val db: Db, private val rootPath: () -> String) {

    fun fileOf(t: Track) = File(rootPath(), t.relPath)
    fun fileOf(relPath: String) = File(rootPath(), relPath)

    private fun <T> watch(vararg topics: Db.Topic, load: () -> T): Flow<T> =
        combine(topics.map { db.version(it) }) { v -> v.toList() }
            .distinctUntilChanged().conflate()
            .mapLatest { load() }
            .flowOn(Dispatchers.IO)

    private fun q(sql: String, vararg args: Any?): Cursor =
        db.readableDatabase.rawQuery(sql, args.map { it?.toString() }.toTypedArray())

    private fun tracks(where: String, order: String, vararg args: Any?, limit: Int? = null): List<Track> =
        q("$TRACK_SELECT WHERE $where ORDER BY $order${limit?.let { " LIMIT $it" } ?: ""}", *args).mapAll { track() }

    private val trackTopics = arrayOf(Db.Topic.Tracks, Db.Topic.Plays, Db.Topic.Favorites)

    // ---- Counts --------------------------------------------------------------------------------

    fun counts(c: Collection): Flow<LibraryCounts> = watch(Db.Topic.Tracks) {
        q("SELECT count(*), count(DISTINCT album_id), count(DISTINCT album_artist), sum(hq_rip <> ''), coalesce(sum(duration_ms), 0) FROM tracks t WHERE ${c.where()}").use {
            it.moveToFirst()
            LibraryCounts(it.getInt(0), it.getInt(1), it.getInt(2), it.getInt(3), it.getLong(4))
        }
    }

    // ---- Songs ---------------------------------------------------------------------------------

    fun songs(c: Collection, sort: String): Flow<List<Track>> = watch(*trackTopics) { tracks(c.where(), songOrder(sort)) }

    fun track(id: Long): Track? = tracks("t.id = ?", "t.id", id).firstOrNull()
    fun tracksByIds(ids: List<Long>): List<Track> {
        if (ids.isEmpty()) return emptyList()
        val byId = ids.distinct().chunked(500).flatMap { chunk -> tracks("t.id IN (${chunk.joinToString(",")})", "t.id") }.associateBy { it.id }
        return ids.mapNotNull { byId[it] }
    }
    fun tracksByPaths(paths: List<String>): Map<String, Track> =
        paths.distinct().chunked(400).flatMap { chunk -> tracks("t.rel_path IN (${chunk.joinToString(",") { "?" }})", "t.id", *chunk.toTypedArray()) }.associateBy { it.relPath }
    fun trackByKey(key: String): Track? = tracks("t.track_key = ?", "t.id", key).firstOrNull()
    fun watchTrack(id: Long): Flow<Track?> = watch(*trackTopics) { track(id) }

    // ---- Albums --------------------------------------------------------------------------------

    fun albums(c: Collection, sort: String): Flow<List<Album>> = watch(Db.Topic.Tracks, Db.Topic.Favorites) {
        val where = when (c) { Collection.Main -> "a.hq_rip = ''"; Collection.Rips -> "a.hq_rip <> ''"; Collection.All -> "1" }
        albumsWhere(where, albumOrder(sort))
    }

    private fun albumsWhere(where: String, order: String, vararg args: Any?): List<Album> =
        q("$ALBUM_SELECT WHERE $where ORDER BY $order", *args).mapAll { album() }

    fun album(id: Long): Flow<Album?> = watch(Db.Topic.Tracks, Db.Topic.Favorites) { albumsWhere("a.id = ?", "a.id", id).firstOrNull() }
    fun albumTracks(id: Long): Flow<List<Track>> = watch(*trackTopics) {
        tracks("t.album_id = ?", "coalesce(t.disc_no, 1), coalesce(t.track_no, 9999), t.sort_title", id)
    }

    // ---- Artists (album artists, the desktop's artist-like key) ---------------------------------

    fun artists(c: Collection, sort: String = "name"): Flow<List<Artist>> = watch(Db.Topic.Tracks, Db.Topic.Favorites) {
        val order = when (sort) {
            "tracks" -> "count(*) DESC, min(t.sort_artist)"
            "albums" -> "count(DISTINCT t.album_id) DESC, min(t.sort_artist)"
            else -> "min(t.sort_artist), t.album_artist"
        }
        val liked = likedKeys("r")
        q(
            """SELECT t.album_artist, count(DISTINCT t.album_id), count(*),
                      (SELECT t2.id FROM tracks t2 WHERE t2.album_artist = t.album_artist AND t2.pic_length > 0 LIMIT 1)
               FROM tracks t WHERE ${c.where()} GROUP BY t.album_artist ORDER BY $order""",
        ).mapAll {
            val name = getString(0)
            Artist(name, getInt(1), getInt(2), longOrNull(3), Keys.artistFavoriteKey(name) in liked)
        }
    }

    /**
     * Musicolet's three artist lists: "album" = album artists (above), "track" = the artists on
     * each song (features split out), "composer" = composers.
     */
    fun artistsBy(mode: String, c: Collection, sort: String = "name"): Flow<List<Artist>> {
        if (mode == "album") {
            val base = artists(c, sort)
            return if (sort == "tracks" || sort == "albums") base else base.mapLatest { l -> l.sortedBy { Scanner.fold(it.name) } }
        }
        return watch(Db.Topic.Tracks, Db.Topic.Favorites) {
            val counts = HashMap<String, IntArray>() // songs
            val albums = HashMap<String, HashSet<Long>>()
            val art = HashMap<String, Long>()
            val names = HashMap<String, String>() // folded -> first spelling seen
            val sql = if (mode == "composer") "SELECT t.composer, NULL, t.album_id, CASE WHEN t.pic_length > 0 THEN t.id END FROM tracks t WHERE ${c.where()} AND t.composer IS NOT NULL AND t.composer <> ''"
            else "SELECT t.artist, t.artists, t.album_id, CASE WHEN t.pic_length > 0 THEN t.id END FROM tracks t WHERE ${c.where()}"
            q(sql).use { cur ->
                while (cur.moveToNext()) {
                    val list = (cur.str(1)?.split("; ")?.filter { it.isNotBlank() }?.takeIf { it.isNotEmpty() } ?: listOf(cur.str(0).orEmpty()))
                        .map { it.trim() }.filter { it.isNotEmpty() }.distinct()
                    for (n in list) {
                        val k = n.lowercase()
                        names.putIfAbsent(k, n)
                        counts.getOrPut(k) { IntArray(1) }[0]++
                        if (!cur.isNull(2)) albums.getOrPut(k) { HashSet() }.add(cur.getLong(2))
                        if (!cur.isNull(3)) art.putIfAbsent(k, cur.getLong(3))
                    }
                }
            }
            val liked = likedKeys("r")
            val list = names.map { (k, n) -> Artist(n, albums[k]?.size ?: 0, counts.getValue(k)[0], art[k], Keys.artistFavoriteKey(n) in liked) }
            when (sort) {
                "tracks" -> list.sortedWith(compareByDescending<Artist> { it.trackCount }.thenBy { Scanner.fold(it.name) })
                "albums" -> list.sortedWith(compareByDescending<Artist> { it.albumCount }.thenBy { Scanner.fold(it.name) })
                else -> list.sortedBy { Scanner.fold(it.name) }
            }
        }
    }

    /** Songs for an artist page; see [artistsBy] for [mode]. */
    fun artistTracksBy(name: String, mode: String): Flow<List<Track>> = when (mode) {
        "composer" -> watch(*trackTopics) { tracks("t.composer = ?", "t.sort_album, coalesce(t.disc_no, 1), coalesce(t.track_no, 9999)", name) }
        "track" -> watch(*trackTopics) {
            tracks(
                "t.artist = ? OR (t.artists IS NOT NULL AND ('; ' || t.artists || '; ') LIKE ?)",
                "t.sort_album, coalesce(t.disc_no, 1), coalesce(t.track_no, 9999)",
                name, "%; ${likeEscape(name)}; %",
            )
        }
        else -> artistTracks(name)
    }

    fun artistAlbums(name: String): Flow<List<Album>> = watch(Db.Topic.Tracks, Db.Topic.Favorites) {
        albumsWhere("a.album_artist = ?", "a.year IS NULL, a.year DESC, a.sort_title", name)
    }

    /** Songs credited to the artist: their own albums plus features on other albums. */
    fun artistTracks(name: String): Flow<List<Track>> = watch(*trackTopics) {
        tracks(
            "t.album_artist = ? OR t.artist = ? OR (t.artists IS NOT NULL AND ('; ' || t.artists || '; ') LIKE ?)",
            "t.sort_title",
            name, name, "%; ${likeEscape(name)}; %",
        )
    }

    fun artist(name: String): Flow<Artist?> = watch(Db.Topic.Tracks, Db.Topic.Favorites) {
        val liked = Keys.artistFavoriteKey(name) in likedKeys("r")
        q("SELECT count(DISTINCT album_id), count(*), (SELECT id FROM tracks WHERE album_artist = ?1 AND pic_length > 0 LIMIT 1) FROM tracks WHERE album_artist = ?1", name).use {
            if (!it.moveToFirst() || it.getInt(1) == 0) null else Artist(name, it.getInt(0), it.getInt(1), it.longOrNull(2), liked)
        }
    }

    // ---- Genres --------------------------------------------------------------------------------

    fun genres(c: Collection): Flow<List<Genre>> = watch(Db.Topic.Tracks) {
        q(
            """SELECT t.genre, count(*), (SELECT t2.id FROM tracks t2 WHERE t2.genre = t.genre AND t2.pic_length > 0 LIMIT 1)
               FROM tracks t WHERE ${c.where()} AND t.genre IS NOT NULL GROUP BY t.genre ORDER BY lower(t.genre)""",
        ).mapAll { Genre(getString(0), getInt(1), longOrNull(2)) }
    }

    fun genreTracks(name: String, c: Collection): Flow<List<Track>> = watch(*trackTopics) {
        tracks("t.genre = ? AND ${c.where()}", "t.sort_artist, t.sort_album, coalesce(t.disc_no, 1), coalesce(t.track_no, 9999)", name)
    }

    // ---- Folders (Musicolet-style browse of the synced tree) ------------------------------------

    /** Sub-folders of [parent] ("" = the music folder) that contain music somewhere below. */
    fun folders(parent: String): Flow<List<FolderEntry>> = watch(Db.Topic.Tracks) {
        val prefix = if (parent.isEmpty()) "" else "$parent/"
        val counts = LinkedHashMap<String, IntArray>()
        val art = HashMap<String, Long>()
        q(
            "SELECT folder, count(*), max(CASE WHEN pic_length > 0 THEN id END) FROM tracks WHERE folder LIKE ? ESCAPE '\\' GROUP BY folder",
            likeEscape(prefix) + "%",
        ).use { c ->
            while (c.moveToNext()) {
                val folder = c.getString(0)
                if (folder.length <= prefix.length) continue
                val child = folder.substring(prefix.length).substringBefore('/')
                counts.getOrPut(child) { IntArray(1) }[0] += c.getInt(1)
                if (!c.isNull(2)) art.putIfAbsent(child, c.getLong(2))
            }
        }
        counts.entries
            .sortedWith(compareBy(String.CASE_INSENSITIVE_ORDER) { it.key })
            .map { (name, n) -> FolderEntry(name, prefix + name, n[0], art[name]) }
    }

    fun folderTracks(folder: String): Flow<List<Track>> = watch(*trackTopics) {
        tracks("t.folder = ?", "coalesce(t.disc_no, 1), coalesce(t.track_no, 9999), t.sort_title", folder)
    }

    /** All songs at or below [folder], in folder order (for "play folder"). */
    fun folderTracksDeep(folder: String): List<Track> =
        if (folder.isEmpty()) tracks("1", "t.folder, coalesce(t.disc_no, 1), coalesce(t.track_no, 9999), t.sort_title")
        else tracks("t.folder = ? OR t.folder LIKE ? ESCAPE '\\'", "t.folder, coalesce(t.disc_no, 1), coalesce(t.track_no, 9999), t.sort_title", folder, likeEscape("$folder/") + "%")

    // ---- Built-in lists ------------------------------------------------------------------------

    fun autoList(list: AutoList, c: Collection): Flow<List<Track>> = watch(*trackTopics) { autoListNow(list, c) }

    fun autoListNow(list: AutoList, c: Collection): List<Track> = when (list) {
        AutoList.Liked -> tracks("coalesce(f.liked, 0) = 1", "f.at DESC, t.sort_title")
        AutoList.RecentlyAdded -> tracks(c.where(), "t.added_at DESC, t.album_id, coalesce(t.disc_no, 1), coalesce(t.track_no, 9999)", limit = 300)
        AutoList.MostPlayed -> tracks("${c.where()} AND coalesce(s.play_count, 0) > 0", "s.play_count DESC, s.last_played DESC", limit = 100)
        AutoList.RecentlyPlayed -> tracks("${c.where()} AND s.last_played IS NOT NULL", "s.last_played DESC", limit = 100)
        AutoList.NeverPlayed -> tracks("${c.where()} AND coalesce(s.play_count, 0) = 0", "t.sort_title")
    }

    /** The real listening history (every play from every device), newest first. */
    fun history(limit: Int = 300): Flow<List<Pair<Track, Long>>> = watch(*trackTopics) {
        val rows = q("SELECT track_key, played_at FROM plays WHERE skipped = 0 ORDER BY played_at DESC LIMIT $limit").mapAll { getString(0) to getLong(1) }
        val byKey = rows.map { it.first }.distinct().chunked(400).flatMap { ch ->
            tracks("t.track_key IN (${ch.joinToString(",") { "?" }})", "t.id", *ch.toTypedArray())
        }.associateBy { it.trackKey }
        rows.mapNotNull { (k, at) -> byKey[k]?.let { it to at } }
    }

    // ---- Favorites -----------------------------------------------------------------------------

    private fun likedKeys(kind: String): Set<String> =
        q("SELECT item_key FROM favorites WHERE kind = ? AND liked = 1", kind).mapAll { getString(0) }.toHashSet()

    fun isLiked(kind: String, key: String): Boolean =
        q("SELECT liked FROM favorites WHERE kind = ? AND item_key = ?", kind, key).use { it.moveToFirst() && it.getInt(0) == 1 }

    // ---- Playlists -----------------------------------------------------------------------------

    fun playlists(): Flow<List<Playlist>> = watch(Db.Topic.Playlists, Db.Topic.Tracks) {
        q(
            """SELECT p.id, p.name, p.kind, p.rel_path, p.item_count,
                      (SELECT t.id FROM playlist_items i JOIN tracks t ON t.rel_path = i.rel_path WHERE i.playlist_id = p.id AND t.pic_length > 0 ORDER BY i.pos LIMIT 1)
               FROM playlists p ORDER BY lower(p.name)""",
        ).mapAll { Playlist(getString(0), getString(1), getString(2), str(3), getInt(4), longOrNull(5)) }
    }

    fun playlist(id: String): Flow<Playlist?> = watch(Db.Topic.Playlists, Db.Topic.Tracks) {
        q("SELECT id, name, kind, rel_path, item_count FROM playlists WHERE id = ?", id).mapAll { Playlist(getString(0), getString(1), getString(2), str(3), getInt(4), null) }.firstOrNull()
    }

    /** Entries in order; entries whose file isn't on this phone are skipped (they stay in the .m3u8). */
    fun playlistTracks(id: String): Flow<List<Track>> = watch(Db.Topic.Playlists, *trackTopics) { playlistTracksNow(id) }

    fun playlistTracksNow(id: String): List<Track> {
        val paths = q("SELECT rel_path FROM playlist_items WHERE playlist_id = ? ORDER BY pos", id).mapAll { getString(0) }
        val byPath = tracksByPaths(paths)
        return paths.mapNotNull { byPath[it] }
    }

    // ---- SiivaGunner ---------------------------------------------------------------------------

    /** Season albums (rips tagged "YouTube"), in the desktop's season order. */
    fun seasons(seasons: List<Rips.Season>): Flow<List<Album>> = watch(Db.Topic.Tracks, Db.Topic.Favorites) {
        albumsWhere("a.hq_rip = 'YouTube'", "a.sort_title").sortedWith(compareBy({ Rips.seasonOrder(it.title, seasons) }, { it.title }))
    }

    fun ripAlbums(): Flow<List<Album>> = watch(Db.Topic.Tracks, Db.Topic.Favorites) {
        albumsWhere("a.hq_rip <> '' AND a.hq_rip <> 'YouTube'", "a.year IS NULL, a.year DESC, a.sort_title")
    }

    /** Games that have rips, with how many. */
    fun ripGames(): Flow<List<Genre>> = watch(Db.Topic.Tracks) {
        q(
            """SELECT t.rip_game, count(*), max(CASE WHEN t.pic_length > 0 THEN t.id END)
               FROM tracks t WHERE t.hq_rip <> '' AND t.rip_game IS NOT NULL AND t.rip_game <> '' GROUP BY t.rip_game ORDER BY lower(t.rip_game)""",
        ).mapAll { Genre(getString(0), getInt(1), longOrNull(2)) }
    }

    fun gameTracks(game: String): Flow<List<Track>> = watch(*trackTopics) {
        tracks("t.hq_rip <> '' AND t.rip_game = ?", "t.yt_uploaded IS NULL, t.yt_uploaded, t.sort_title", game)
    }

    // ---- Search --------------------------------------------------------------------------------

    data class SearchResult(val tracks: List<Track>, val albums: List<Album>, val artists: List<Artist>)

    fun search(query: String, c: Collection): SearchResult {
        val words = Scanner.fold(query).split(Regex("\\s+")).filter { it.isNotEmpty() }
        if (words.isEmpty()) return SearchResult(emptyList(), emptyList(), emptyList())
        val likes = words.map { "%" + likeEscape(it) + "%" }
        val where = words.joinToString(" AND ") { "t.search LIKE ? ESCAPE '\\'" }
        val tracks = tracks("${c.where()} AND $where", "t.sort_title", *likes.toTypedArray(), limit = 200)
        val albumIds = q("SELECT DISTINCT album_id FROM tracks t WHERE ${c.where()} AND " +
            words.joinToString(" AND ") { "(lower(coalesce(t.album, '')) || ' ' || lower(t.album_artist)) LIKE ? ESCAPE '\\'" } + " LIMIT 60", *likes.toTypedArray(),
        ).mapAll { longOrNull(0) }.filterNotNull()
        val albums = if (albumIds.isEmpty()) emptyList() else albumsWhere("a.id IN (${albumIds.joinToString(",")})", "a.sort_title")
        val liked = likedKeys("r")
        val artists = q(
            "SELECT t.album_artist, count(DISTINCT t.album_id), count(*), max(CASE WHEN t.pic_length > 0 THEN t.id END) FROM tracks t WHERE ${c.where()} AND " +
                words.joinToString(" AND ") { "lower(t.album_artist) LIKE ? ESCAPE '\\'" } + " GROUP BY t.album_artist ORDER BY count(*) DESC LIMIT 20",
            *likes.toTypedArray(),
        ).mapAll { Artist(getString(0), getInt(1), getInt(2), longOrNull(3), Keys.artistFavoriteKey(getString(0)) in liked) }
        return SearchResult(tracks, albums, artists)
    }

    // ---- Row mapping ---------------------------------------------------------------------------

    private fun Cursor.track() = Track(
        id = getLong(0), relPath = getString(1), trackKey = getString(2), title = getString(3), artist = str(4).orEmpty(),
        album = str(5).orEmpty(), albumArtist = getString(6), albumId = longOrNull(7), trackNo = intOrNull(8), discNo = intOrNull(9),
        year = intOrNull(10), genre = str(11), composer = str(12), durationMs = getLong(13), codec = str(14), bitrate = intOrNull(15),
        sampleRate = intOrNull(16), bitDepth = intOrNull(17), lossless = getInt(18) == 1, rating = getInt(19), hasArt = (longOrNull(20) ?: 0) > 0,
        lyricsKind = getInt(21), hqRip = getString(22), ripGame = str(23), addedAt = getLong(24), playCount = getInt(25), skipCount = getInt(26),
        lastPlayed = longOrNull(27), liked = getInt(28) == 1, rgTrackGain = dbl(29), rgTrackPeak = dbl(30), rgAlbumGain = dbl(31), rgAlbumPeak = dbl(32),
        mtime = getLong(33),
    )

    private fun Cursor.album() = Album(
        id = getLong(0), key = getString(1), title = getString(2), albumArtist = getString(3), year = intOrNull(4), genre = str(5),
        trackCount = getInt(6), durationMs = getLong(7), artTrackId = longOrNull(8), hqRip = getString(9), relDir = getString(10),
        addedAt = getLong(11), liked = getInt(12) == 1,
    )

    companion object {
        private const val TRACK_SELECT = """SELECT t.id, t.rel_path, t.track_key, t.title, t.artist, t.album, t.album_artist, t.album_id,
              t.track_no, t.disc_no, t.year, t.genre, t.composer, t.duration_ms, t.codec, t.bitrate, t.sample_rate, t.bit_depth, t.lossless,
              t.rating, t.pic_length, t.lyrics_kind, t.hq_rip, t.rip_game, t.added_at,
              coalesce(s.play_count, 0), coalesce(s.skip_count, 0), s.last_played, coalesce(f.liked, 0),
              t.rg_track_gain, t.rg_track_peak, t.rg_album_gain, t.rg_album_peak, t.mtime
            FROM tracks t
            LEFT JOIN play_stats s ON s.track_key = t.track_key
            LEFT JOIN favorites f ON f.kind = 't' AND f.item_key = t.track_key"""

        private const val ALBUM_SELECT = """SELECT a.id, a.album_key, a.title, a.album_artist, a.year, a.genre, a.track_count, a.duration_ms,
              a.art_track_id, a.hq_rip, a.rel_dir, a.added_at, coalesce(f.liked, 0)
            FROM albums a LEFT JOIN favorites f ON f.kind = 'a' AND f.item_key = a.album_key"""

        fun Collection.where() = when (this) {
            Collection.Main -> "t.hq_rip = ''"
            Collection.Rips -> "t.hq_rip <> ''"
            Collection.All -> "1"
        }

        fun songOrder(sort: String) = when (sort) {
            "artist" -> "t.sort_artist, t.sort_album, coalesce(t.disc_no, 1), coalesce(t.track_no, 9999)"
            "album" -> "t.sort_album, coalesce(t.disc_no, 1), coalesce(t.track_no, 9999)"
            "added" -> "t.added_at DESC, t.sort_title"
            "year" -> "t.year IS NULL, t.year DESC, t.sort_album, coalesce(t.track_no, 9999)"
            "duration" -> "t.duration_ms DESC"
            "plays" -> "coalesce(s.play_count, 0) DESC, t.sort_title"
            "game" -> "t.rip_game IS NULL, lower(t.rip_game), t.sort_title"
            "uploaded" -> "t.yt_uploaded IS NULL, t.yt_uploaded DESC, t.sort_title"
            else -> "t.sort_title, t.sort_artist"
        }

        fun albumOrder(sort: String) = when (sort) {
            "title" -> "a.sort_title"
            "year" -> "a.year IS NULL, a.year DESC, a.sort_title"
            "added" -> "a.added_at DESC"
            else -> "a.sort_artist, a.year, a.sort_title"
        }

        fun likeEscape(s: String) = s.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    }
}
