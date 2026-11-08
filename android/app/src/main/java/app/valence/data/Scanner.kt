package app.valence.data

import android.database.sqlite.SQLiteDatabase
import android.util.Log
import app.valence.core.Keys
import app.valence.core.Rips
import app.valence.tags.ReadResult
import app.valence.tags.TagReader
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import java.io.File
import java.text.Normalizer
import java.util.Locale

/**
 * Walks the music folder the way the desktop's scanner does (same skip rules, same rel paths,
 * byte-for-byte from directory names) and keeps the tracks/albums tables in step with it.
 * Only new or changed files (size or mtime) are read.
 */
class Scanner(private val db: Db) {
    private val _state = MutableStateFlow(ScanState())
    val state: StateFlow<ScanState> = _state.asStateFlow()
    private val lock = Mutex()

    data class Found(val rel: String, val file: File, val size: Long, val mtime: Long)

    /** Returns the number of tracks added, changed or removed. */
    @OptIn(ExperimentalCoroutinesApi::class)
    suspend fun scan(root: File): Int = lock.withLock {
        withContext(Dispatchers.IO) {
            if (!root.isDirectory) {
                _state.value = ScanState(message = "Music folder not found: ${root.path}")
                return@withContext 0
            }
            _state.value = ScanState(running = true, message = "Looking for music…")
            val found = ArrayList<Found>(8192)
            walk(root, "", 0, found)
            if (found.any { !Normalizer.isNormalized(it.rel, Normalizer.Form.NFC) }) Log.w(TAG, "Some paths are not NFC; path-keyed items may not match the desktop")

            val known = HashMap<String, Triple<Long, Long, Long>>(found.size * 2)
            db.readableDatabase.rawQuery("SELECT id, rel_path, size, mtime FROM tracks", null).use { c ->
                while (c.moveToNext()) known[c.getString(1)] = Triple(c.getLong(0), c.getLong(2), c.getLong(3))
            }
            val changed = found.filter { f -> known[f.rel]?.let { it.second != f.size || it.third != f.mtime } ?: true }
            val present = found.mapTo(HashSet(found.size * 2)) { it.rel }
            val gone = known.filterKeys { it !in present }.values.map { it.first }

            var done = 0
            _state.value = ScanState(running = true, total = changed.size, message = if (changed.isEmpty()) "Up to date" else "Reading tags…")
            val io = Dispatchers.IO.limitedParallelism(4)
            for (batch in changed.chunked(200)) {
                val read = coroutineScope {
                    batch.map { f -> async(io) { f to runCatching { TagReader.read(f.file) }.onFailure { Log.w(TAG, "Can't read ${f.rel}: ${it.message}") }.getOrNull() } }.awaitAll()
                }
                db.tx { for ((f, r) in read) if (r != null) upsert(this, f, r, known[f.rel]?.first) }
                done += batch.size
                _state.value = _state.value.copy(done = done)
            }
            if (gone.isNotEmpty()) db.tx { gone.chunked(500).forEach { ids -> execSQL("DELETE FROM tracks WHERE id IN (${ids.joinToString(",")})") } }
            val total = changed.size + gone.size
            if (total > 0 || known.isEmpty()) {
                rebuildAlbums()
                db.changed(Db.Topic.Tracks)
            }
            _state.value = ScanState(running = false, message = "", lastFinished = System.currentTimeMillis())
            total
        }
    }

    /**
     * Re-reads just [rels] (after the tag editor rewrote them) and regroups albums. Waits for a
     * running scan, so it always has the last word on those files.
     */
    suspend fun rescanFiles(root: File, rels: List<String>) = lock.withLock {
        withContext(Dispatchers.IO) {
            if (rels.isEmpty()) return@withContext
            val ids = HashMap<String, Long>()
            for (chunk in rels.chunked(500)) {
                val marks = chunk.joinToString(",") { "?" }
                db.readableDatabase.rawQuery("SELECT id, rel_path FROM tracks WHERE rel_path IN ($marks)", chunk.toTypedArray()).use { c ->
                    while (c.moveToNext()) ids[c.getString(1)] = c.getLong(0)
                }
            }
            val read = rels.mapNotNull { rel ->
                val file = File(root, rel)
                val r = runCatching { TagReader.read(file) }.onFailure { Log.w(TAG, "Can't read $rel: ${it.message}") }.getOrNull()
                r?.let { Found(rel, file, file.length(), file.lastModified()) to it }
            }
            db.tx { for ((f, r) in read) upsert(this, f, r, ids[f.rel]) }
            rebuildAlbums()
            db.changed(Db.Topic.Tracks)
        }
    }

    private fun walk(dir: File, rel: String, depth: Int, out: MutableList<Found>) {
        val entries = dir.listFiles() ?: return
        for (e in entries) {
            val name = e.name
            val childRel = if (rel.isEmpty()) name else "$rel/$name"
            if (e.isDirectory) {
                if (depth == 0 && name.equals("playlists", ignoreCase = true)) continue // playlists are indexed separately
                if (Keys.shouldSkipDir(name, depth)) continue
                walk(e, childRel, depth + 1, out)
            } else {
                if (name.startsWith('.') || Keys.isIgnoredName(name) || Keys.isConflictCopy(name)) continue
                val ext = name.substringAfterLast('.', "").lowercase(Locale.ROOT)
                if (ext !in Keys.AUDIO_EXTENSIONS) continue
                out.add(Found(childRel, e, e.length(), e.lastModified()))
            }
        }
    }

    private fun upsert(w: SQLiteDatabase, f: Found, r: ReadResult, existingId: Long?) {
        val t = r.tags
        val title = Keys.cleanText(t.title).ifEmpty { f.rel.substringAfterLast('/').substringBeforeLast('.') }
        val artist = Keys.cleanText(t.artist).ifEmpty { Keys.cleanText(t.albumArtist) }
        val album = Keys.cleanText(t.album)
        val compilation = t.compilation || Keys.isVariousArtists(t.albumArtist)
        val albumArtist = Keys.effectiveAlbumArtist(Keys.cleanText(t.albumArtist), artist, compilation)
        val hqRip = t.custom[Rips.TAG].orEmpty()
        val valenceId = t.valenceId?.takeIf { it.isNotBlank() }
        val year = (t.date ?: t.originalDate)?.let { Regex("\\d{4}").find(it)?.value?.toIntOrNull() }
        val lyricsKind = when {
            t.lyrics.isNullOrBlank() -> 0
            LRC.containsMatchIn(t.lyrics!!) -> 2
            else -> 1
        }
        val ripGame = t.custom["HQR_GAME"] ?: if (hqRip.isNotEmpty()) Rips.gameFromTitle(title) else null
        val values = cv(
            "rel_path" to f.rel,
            "folder" to Keys.relDirOf(f.rel),
            "size" to f.size,
            "mtime" to f.mtime,
            "valence_id" to valenceId,
            "track_key" to Keys.trackKey(valenceId, f.rel),
            "title" to title,
            "artist" to artist,
            "artists" to t.artists.joinToString("; ").ifEmpty { null },
            "album" to album.ifEmpty { null },
            "album_artist" to albumArtist,
            "track_no" to t.trackNo,
            "track_total" to t.trackTotal,
            "disc_no" to t.discNo,
            "disc_total" to t.discTotal,
            "year" to year,
            "date" to t.date,
            "genre" to Keys.cleanText(t.genre).ifEmpty { null },
            "composer" to Keys.cleanText(t.composer).ifEmpty { null },
            "compilation" to compilation,
            "duration_ms" to r.info.durationMs,
            "codec" to r.info.codec,
            "bitrate" to r.info.bitrate,
            "sample_rate" to r.info.sampleRate,
            "bit_depth" to r.info.bitDepth,
            "lossless" to r.info.lossless,
            "rg_track_gain" to t.rgTrackGain,
            "rg_track_peak" to t.rgTrackPeak,
            "rg_album_gain" to t.rgAlbumGain,
            "rg_album_peak" to t.rgAlbumPeak,
            "rating" to t.rating,
            "lyrics_kind" to lyricsKind,
            "pic_mime" to r.picture?.mime,
            "pic_offset" to r.picture?.offset,
            "pic_length" to r.picture?.length,
            "album_key" to Keys.albumKeyFor(f.rel, t.album, t.title),
            "hq_rip" to hqRip,
            "rip_game" to ripGame,
            "rip_platform" to t.custom["HQR_PLATFORM"],
            "yt_uploaded" to t.custom["YOUTUBE_UPLOADED"],
            "sort_title" to sortKey(title),
            "sort_artist" to sortKey(artist),
            "sort_album" to sortKey(album.ifEmpty { title }),
            "search" to fold(listOfNotNull(title, artist, album, albumArtist, t.composer, ripGame, t.custom["HQR_PLATFORM"]).joinToString(" ")),
        )
        if (existingId != null) {
            w.update("tracks", values, "id = ?", arrayOf(existingId.toString()))
        } else {
            values.put("added_at", f.mtime.takeIf { it > 0 } ?: System.currentTimeMillis())
            w.insertWithOnConflict("tracks", null, values, SQLiteDatabase.CONFLICT_REPLACE)
        }
    }

    /** Albums are folder + album title (the desktop's album_key), so album likes line up across devices. */
    private fun rebuildAlbums() = db.tx {
        execSQL(
            """INSERT INTO albums(album_key, title, album_artist, year, genre, track_count, duration_ms, art_track_id, hq_rip, rel_dir, added_at, sort_title, sort_artist)
               SELECT album_key,
                      coalesce(max(album), max(title)),
                      (SELECT t2.album_artist FROM tracks t2 WHERE t2.album_key = t.album_key GROUP BY t2.album_artist ORDER BY count(*) DESC LIMIT 1),
                      max(year), (SELECT t3.genre FROM tracks t3 WHERE t3.album_key = t.album_key AND t3.genre IS NOT NULL GROUP BY t3.genre ORDER BY count(*) DESC LIMIT 1),
                      count(*), sum(duration_ms),
                      (SELECT t4.id FROM tracks t4 WHERE t4.album_key = t.album_key AND t4.pic_length > 0 ORDER BY coalesce(t4.disc_no, 1), coalesce(t4.track_no, 0), t4.id LIMIT 1),
                      max(hq_rip), min(folder), min(added_at), min(sort_album), min(sort_artist)
               FROM tracks t GROUP BY album_key
               ON CONFLICT(album_key) DO UPDATE SET
                 title = excluded.title, album_artist = excluded.album_artist, year = excluded.year, genre = excluded.genre,
                 track_count = excluded.track_count, duration_ms = excluded.duration_ms, art_track_id = excluded.art_track_id,
                 hq_rip = excluded.hq_rip, rel_dir = excluded.rel_dir, added_at = excluded.added_at,
                 sort_title = excluded.sort_title, sort_artist = excluded.sort_artist""",
        )
        execSQL("DELETE FROM albums WHERE album_key NOT IN (SELECT album_key FROM tracks)")
        execSQL("UPDATE tracks SET album_id = (SELECT a.id FROM albums a WHERE a.album_key = tracks.album_key)")
        // Album artist sort key: articles don't count ("The Living Tombstone" sorts under L).
        execSQL("UPDATE albums SET sort_artist = (SELECT min(t.sort_artist) FROM tracks t WHERE t.album_id = albums.id)")
    }

    companion object {
        private const val TAG = "ValenceScanner"
        private val LRC = Regex("^\\s*\\[\\d{1,3}:\\d{2}(?:[.:]\\d{1,3})?]", RegexOption.MULTILINE)
        private val ARTICLE = Regex("^(the|a|an)\\s+", RegexOption.IGNORE_CASE)
        private val LEADING = Regex("^[^\\p{L}\\p{N}]+")

        private val MARKS = Regex("\\p{M}+")

        /** Lower-case, accents removed: what search compares. */
        fun fold(s: String): String = Normalizer.normalize(s, Normalizer.Form.NFKD).replace(MARKS, "").lowercase(Locale.ROOT)

        /** Case-insensitive, accent-folded sort key; leading articles and punctuation don't count. */
        fun sortKey(s: String): String {
            val folded = fold(s)
            return folded.replace(LEADING, "").replace(ARTICLE, "").ifEmpty { folded }
        }
    }
}
