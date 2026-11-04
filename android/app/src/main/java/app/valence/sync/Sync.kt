package app.valence.sync

import android.database.sqlite.SQLiteDatabase
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.widget.Toast
import app.valence.ValenceApp
import app.valence.core.CursorStore
import app.valence.core.DeviceLog
import app.valence.core.FavoriteEvent
import app.valence.core.Hlc
import app.valence.core.Keys
import app.valence.core.LogReader
import app.valence.core.M3u8
import app.valence.core.PendingPlay
import app.valence.core.PlayEvent
import app.valence.core.Rips
import app.valence.data.Album
import app.valence.data.Db
import app.valence.data.Track
import app.valence.data.cv
import app.valence.data.mapAll
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.security.MessageDigest

data class SyncState(
    val busy: Boolean = false,
    val lastIngestAt: Long = 0,
    val devices: Int = 0,
    val error: String? = null,
)

/**
 * Everything shared with the other devices through the synced folder:
 * - reads every device's `.valence/devices/<id>/` plays and likes logs (this phone's too),
 * - appends this phone's own plays and likes (the only `.valence` files it ever writes, plus device.json),
 * - indexes `Playlists/<name>.m3u8` and the desktop's smart/mirror docs, and edits static playlists the
 *   way the desktop does (re-read, change, atomic rewrite with relative paths).
 * Audio files are never touched.
 *
 * All file and DB work runs on one background thread, in order.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class Sync(private val app: ValenceApp) {
    private val db get() = app.db
    val deviceId: String = app.prefs.deviceId
    val hlc = Hlc(deviceId)
    private val io = Dispatchers.IO.limitedParallelism(1)

    private val _state = MutableStateFlow(SyncState())
    val state: StateFlow<SyncState> = _state.asStateFlow()

    private var logDir: File? = null
    private var deviceLog: DeviceLog? = null
    private var seasonsCache: Pair<File?, List<Rips.Season>>? = null

    private val appVersion: String = runCatching {
        app.packageManager.getPackageInfo(app.packageName, 0).versionName
    }.getOrNull() ?: "0"

    init {
        // Our clock must never run behind anything already seen, so our events sort after them.
        app.scope.launch(io) {
            runCatching {
                db.readableDatabase.rawQuery(
                    "SELECT max(h) FROM (SELECT max(hlc) AS h FROM favorites UNION ALL SELECT max(hlc) AS h FROM plays)", null,
                ).use { if (it.moveToFirst() && !it.isNull(0)) hlc.observe(it.getString(0)) }
            }
        }
    }

    fun root(): File? = app.prefs.musicRoot.value.takeIf { it.isNotEmpty() }?.let(::File)
    private fun valenceDir(): File? = root()?.let { File(it, ".valence") }

    private fun log(): DeviceLog? {
        val dir = valenceDir() ?: return null
        if (dir != logDir || deviceLog == null) {
            logDir = dir
            deviceLog = DeviceLog(dir, deviceId, hlc, "android", appVersion).also {
                runCatching { it.touchDeviceJson() }.onFailure { e -> Log.w(TAG, "device.json", e) }
            }
        }
        return deviceLog
    }

    // ---- Likes ---------------------------------------------------------------------------------

    fun setTrackLiked(t: Track, on: Boolean) = setLiked("t", t.trackKey, on)
    fun setAlbumLiked(a: Album, on: Boolean) = setLiked("a", a.key, on)
    fun setArtistLiked(name: String, on: Boolean) = setLiked("r", Keys.artistFavoriteKey(name), on)

    private fun setLiked(kind: String, key: String, on: Boolean) {
        if (key.isEmpty()) return
        app.scope.launch(io) {
            val current = db.readableDatabase.rawQuery("SELECT liked FROM favorites WHERE kind = ? AND item_key = ?", arrayOf(kind, key))
                .use { it.moveToFirst() && it.getInt(0) == 1 }
            if (current == on) return@launch // the desktop logs only real changes, which keeps the original "liked at"
            val log = log() ?: return@launch
            val e = try {
                log.appendFavorite(kind, key, on)
            } catch (x: Exception) {
                fail("Couldn't save the like", x)
                return@launch
            }
            applyFavorite(db.writableDatabase, e)
            db.changed(Db.Topic.Favorites)
        }
    }

    /** Last writer wins per (kind, key), by HLC; unliked rows stay with liked = 0. */
    private fun applyFavorite(w: SQLiteDatabase, e: FavoriteEvent): Boolean {
        val at = e.effectiveAt()
        w.compileStatement(
            """INSERT INTO favorites(kind, item_key, liked, hlc, at) VALUES (?, ?, ?, ?, ?)
               ON CONFLICT(kind, item_key) DO UPDATE SET liked = excluded.liked, hlc = excluded.hlc, at = excluded.at
               WHERE excluded.hlc > favorites.hlc""",
        ).use { st ->
            st.bindString(1, e.kind)
            st.bindString(2, e.key)
            st.bindLong(3, if (e.on) 1 else 0)
            st.bindString(4, e.hlc)
            st.bindLong(5, at)
            return st.executeUpdateDelete() > 0
        }
    }

    // ---- Plays ---------------------------------------------------------------------------------

    fun recordPlay(p: PendingPlay) {
        app.scope.launch(io) {
            val log = log() ?: return@launch
            val e = try {
                log.appendPlay(p.trackKey, p.at, p.ms, p.completed, p.skipped)
            } catch (x: Exception) {
                fail("Couldn't log the play", x)
                return@launch
            }
            db.tx {
                insertPlay(this, e)
                execSQL(
                    """INSERT OR REPLACE INTO play_stats
                       SELECT track_key, sum(CASE WHEN skipped = 0 THEN 1 ELSE 0 END), sum(skipped), max(CASE WHEN skipped = 0 THEN played_at END)
                       FROM plays WHERE track_key = ? GROUP BY track_key""",
                    arrayOf(e.trackKey),
                )
            }
            db.changed(Db.Topic.Plays)
        }
    }

    private fun insertPlay(w: SQLiteDatabase, e: PlayEvent): Boolean =
        w.insertWithOnConflict(
            "plays", null,
            cv(
                "device_id" to e.device, "hlc" to e.hlc, "track_key" to e.trackKey, "played_at" to e.at,
                "ms" to e.ms, "completed" to e.completed, "skipped" to e.skipped,
            ),
            SQLiteDatabase.CONFLICT_IGNORE,
        ) != -1L

    // ---- Ingest --------------------------------------------------------------------------------

    /** Reads what every device appended since last time. Cursors move only with the stored events. */
    suspend fun ingest() = withContext(io) {
        val dir = valenceDir() ?: return@withContext
        val devicesDir = File(dir, "devices")
        if (!devicesDir.isDirectory) {
            indexPlaylistsNow()
            return@withContext
        }
        _state.update { it.copy(busy = true) }
        try {
            val cursors = BufferedCursors()
            val reader = LogReader(dir, cursors)
            val plays = reader.newPlays() // both sorted by HLC; cursors move only on commit()
            val favorites = reader.newFavorites()
            var newPlays = 0
            var newLikes = 0
            db.tx {
                for (e in plays) if (insertPlay(this, e)) newPlays++
                for (e in favorites) if (applyFavorite(this, e)) newLikes++
                plays.commit()
                favorites.commit()
                cursors.flush(this) // the new offsets land in the same transaction as the events
                if (newPlays > 0) execSQL(Db.REBUILD_STATS)
            }
            listOfNotNull(plays.maxHlc, favorites.maxHlc).maxOrNull()?.let(hlc::observe)
            if (newPlays > 0) db.changed(Db.Topic.Plays)
            if (newLikes > 0) db.changed(Db.Topic.Favorites)
            val devices = devicesDir.listFiles { f -> f.isDirectory }?.size ?: 0
            _state.update { it.copy(lastIngestAt = System.currentTimeMillis(), devices = devices, error = null) }
            if (newPlays + newLikes > 0) Log.i(TAG, "Ingested $newPlays plays and $newLikes likes")
            log() // creates our own folder and device.json once the library is in use
        } catch (x: Exception) {
            Log.w(TAG, "Ingest failed", x)
            _state.update { it.copy(error = x.message ?: x.javaClass.simpleName) }
        } finally {
            _state.update { it.copy(busy = false) }
        }
        indexPlaylistsNow()
    }

    /** Offsets the reader moves, written to the DB only in the transaction that stores the events. */
    private inner class BufferedCursors : CursorStore {
        private val pending = HashMap<Pair<String, String>, Long>()
        override fun get(device: String, file: String): Long = pending[device to file]
            ?: db.readableDatabase.rawQuery("SELECT offset FROM log_cursors WHERE device = ? AND file = ?", arrayOf(device, file))
                .use { if (it.moveToFirst()) it.getLong(0) else 0L }

        override fun set(device: String, file: String, offset: Long) {
            pending[device to file] = offset
        }

        fun flush(w: SQLiteDatabase) {
            for ((k, v) in pending) {
                w.insertWithOnConflict("log_cursors", null, cv("device" to k.first, "file" to k.second, "offset" to v), SQLiteDatabase.CONFLICT_REPLACE)
            }
            pending.clear()
        }
    }

    // ---- Rips ----------------------------------------------------------------------------------

    /** Season order and names: `.valence/rips/seasons.json` when present, else the desktop's defaults. */
    fun seasons(): List<Rips.Season> {
        val dir = valenceDir()
        seasonsCache?.let { (d, s) -> if (d == dir) return s }
        val s = runCatching { if (dir != null) Rips.seasons(dir) else Rips.DEFAULT_SEASONS }.getOrDefault(Rips.DEFAULT_SEASONS)
        seasonsCache = dir to s
        return s
    }

    // ---- Playlists -----------------------------------------------------------------------------

    fun indexPlaylists() {
        app.scope.launch(io) { indexPlaylistsNow() }
    }

    private class PlaylistRow(
        val id: String, val name: String, val kind: String, val relPath: String?, val rules: String?, val mtime: Long, val items: List<String>,
    )

    private fun indexPlaylistsNow() {
        val root = root() ?: return
        try {
            val rows = ArrayList<PlaylistRow>()
            val docsDir = File(root, ".valence/playlists")
            val mirrors = readDocs(docsDir, "mirror-")
            val mirrorByPath = mirrors.associateBy { Keys.foldKey(it.optString("relPath")) }
            val files = File(root, PLAYLISTS_DIR).listFiles { f -> f.isFile && M3U.containsMatchIn(f.name) && !f.name.contains(".valence-tmp") }.orEmpty()
            val (conflicts, plain) = files.partition { it.name.contains(".sync-conflict-") }
            for (f in plain) {
                val rel = "$PLAYLISTS_DIR/${f.name}"
                val mirror = mirrorByPath[Keys.foldKey(rel)]
                var items = M3u8.read(f, root).map { it.relPath }
                // A Syncthing conflict copy: show the union (the desktop resolves it; the phone never does).
                val copies = conflicts.filter { it.name.replace(CONFLICT_PART, "") == f.name }
                for (c in copies) {
                    val seen = items.mapTo(HashSet()) { it.lowercase() }
                    items = items + M3u8.read(c, root).map { it.relPath }.filter { seen.add(it.lowercase()) }
                }
                rows += PlaylistRow(
                    id = mirror?.optString("id")?.takeIf { it.isNotEmpty() } ?: staticId(rel),
                    name = mirror?.optString("name")?.takeIf { it.isNotEmpty() } ?: f.name.replace(M3U, ""),
                    kind = when {
                        mirror != null -> "mirror"
                        copies.isNotEmpty() -> "conflict"
                        else -> "static"
                    },
                    relPath = rel, rules = null, mtime = f.lastModified(), items = items,
                )
            }
            // Smart docs: the desktop's rename bug can leave two docs with one id; the newest wins.
            val smart = readDocs(docsDir, "smart-").filter { it.optString("id").isNotEmpty() }
                .groupBy { it.optString("id") }.values.map { docs -> docs.maxBy { it.optLong("updatedAt") } }
            for (doc in smart) {
                val rules = doc.optJSONObject("rules") ?: continue
                rows += PlaylistRow(
                    id = doc.getString("id"), name = doc.optString("name").ifEmpty { "Smart playlist" }, kind = "smart",
                    relPath = null, rules = rules.toString(), mtime = doc.optLong("updatedAt"),
                    items = runCatching { smartPaths(rules) }.onFailure { Log.w(TAG, "Smart playlist ${doc.optString("name")}", it) }.getOrDefault(emptyList()),
                )
            }
            db.tx {
                delete("playlist_items", null, null)
                delete("playlists", null, null)
                for (r in rows.distinctBy { it.id }) {
                    insert("playlists", null, cv("id" to r.id, "name" to r.name, "kind" to r.kind, "rel_path" to r.relPath, "rules" to r.rules, "mtime" to r.mtime, "item_count" to r.items.size))
                    r.items.forEachIndexed { i, p -> insert("playlist_items", null, cv("playlist_id" to r.id, "pos" to i, "rel_path" to p)) }
                }
            }
            db.changed(Db.Topic.Playlists)
        } catch (x: Exception) {
            Log.w(TAG, "Playlist index failed", x)
        }
    }

    private fun readDocs(dir: File, prefix: String): List<JSONObject> =
        dir.listFiles { f -> f.isFile && f.name.startsWith(prefix) && f.name.endsWith(".json") && !f.name.contains(".sync-conflict-") }
            .orEmpty().mapNotNull { f -> runCatching { JSONObject(f.readText()) }.getOrNull() }

    /** Port of the desktop's smartSql over the phone's index. */
    private fun smartPaths(rules: JSONObject): List<String> {
        val parts = ArrayList<String>()
        val args = ArrayList<String>()
        val list = rules.optJSONArray("rules") ?: JSONArray()
        val now = System.currentTimeMillis()
        var mentionsRips = false
        for (i in 0 until list.length()) {
            val r = list.optJSONObject(i) ?: continue
            val field = r.optString("field")
            if (field == "hqRip") mentionsRips = true
            val col = SMART_FIELDS[field] ?: continue
            val raw = r.opt("value")
            // Numbers (and booleans as 0/1) bind as numbers, so comparisons match SQLite's on the desktop.
            val num: Double? = when (raw) {
                is Boolean -> if (raw) 1.0 else 0.0
                is Number -> raw.toDouble()
                else -> null
            }
            val str = raw?.toString() ?: ""
            fun p(v: Any): String { args += v.toString(); return if (v is Number) "CAST(? AS NUMERIC)" else "?" }
            val v: Any = num ?: str
            when (r.optString("op")) {
                "is" -> parts += if (num == null) "$col = ${p(v)} COLLATE NOCASE" else "$col = ${p(v)}"
                "isNot" -> parts += if (num == null) "coalesce($col, '') <> ${p(v)} COLLATE NOCASE" else "coalesce($col, -1) <> ${p(v)}"
                "contains" -> parts += "$col LIKE ${p("%$str%")}"
                "notContains" -> parts += "coalesce($col, '') NOT LIKE ${p("%$str%")}"
                "startsWith" -> parts += "$col LIKE ${p("$str%")}"
                "gt" -> parts += "$col > ${p(v)}"
                "lt" -> parts += "$col < ${p(v)}"
                "between" -> {
                    val hi: Any = if (r.has("value2") && !r.isNull("value2")) r.optDouble("value2") else v
                    parts += "$col BETWEEN ${p(v)} AND ${p(hi)}"
                }
                "inLast" -> parts += "$col > ${p((now - (num ?: 0.0) * 86_400_000).toLong())}"
                "notInLast" -> parts += "($col IS NULL OR $col <= ${p((now - (num ?: 0.0) * 86_400_000).toLong())})"
            }
        }
        val where = if (parts.isEmpty()) "1" else parts.joinToString(if (rules.optString("match") == "any") " OR " else " AND ")
        val liked = "(SELECT f.at FROM favorites f WHERE f.kind = 't' AND f.item_key = t.track_key AND f.liked = 1)"
        val order = when (rules.optString("sort")) {
            "random" -> "random()"
            "addedAt" -> "t.added_at DESC"
            "lastPlayed" -> "ps.last_played DESC"
            "playCount" -> "coalesce(ps.play_count, 0) DESC"
            "rating" -> "t.rating DESC"
            "likedAt" -> "$liked DESC"
            "title" -> "t.title COLLATE NOCASE"
            else -> "t.album_artist COLLATE NOCASE, t.year, t.album COLLATE NOCASE, coalesce(t.disc_no, 1), t.track_no"
        }
        val rips = if (mentionsRips) "" else " AND t.hq_rip = ''"
        val limit = rules.optInt("limit", 0).takeIf { it > 0 }?.let { " LIMIT $it" } ?: ""
        val sql = "SELECT t.rel_path FROM tracks t LEFT JOIN play_stats ps ON ps.track_key = t.track_key WHERE ($where)$rips ORDER BY $order$limit"
        return db.readableDatabase.rawQuery(sql, args.toTypedArray()).mapAll { getString(0) }
    }

    /** Creates `Playlists/<Name>.m3u8` (the desktop's naming rules) and reports its id. */
    fun createPlaylist(name: String, tracks: List<Track>, done: (String?) -> Unit) {
        app.scope.launch(io) {
            val root = root()
            val id = if (root == null) null else try {
                val rel = freeName(root, name)
                M3u8.write(File(root, rel), root, tracks.map(::entryFor))
                indexPlaylistsNow()
                staticId(rel)
            } catch (x: Exception) {
                fail("Couldn't create the playlist", x)
                null
            }
            withContext(Dispatchers.Main) { done(id) }
        }
    }

    fun addToPlaylist(id: String, tracks: List<Track>) = editPlaylist(id) { entries ->
        val have = entries.mapTo(HashSet()) { it.relPath.lowercase() }
        val add = tracks.filter { have.add(it.relPath.lowercase()) }.map(::entryFor)
        if (add.isEmpty()) toast("Already in the playlist")
        else toast(if (add.size == 1) "Added to playlist" else "Added ${add.size} songs")
        entries + add
    }

    fun removeFromPlaylist(id: String, track: Track) = editPlaylist(id) { entries ->
        entries.filterNot { it.relPath.equals(track.relPath, ignoreCase = true) }
    }

    /** Renames a static playlist's file (the desktop does the same and re-indexes); reports the new id. */
    fun renamePlaylist(id: String, name: String, done: (String?) -> Unit) {
        app.scope.launch(io) {
            val newId = try {
                renamePlaylistNow(id, name)
            } catch (x: Exception) {
                fail("Couldn't rename the playlist", x)
                null
            }
            withContext(Dispatchers.Main) { done(newId) }
        }
    }

    private fun renamePlaylistNow(id: String, name: String): String? {
        val root = root() ?: return null
        val rel = staticPlaylistPath(id) ?: return null
        val target = freeName(root, name, except = rel)
        if (target == rel) return id
        val old = File(root, rel)
        // A plain rename keeps the file byte for byte. Shared storage ignores letter case, so a
        // case-only change goes through a temporary name.
        val ok = if (Keys.foldKey(target) == Keys.foldKey(rel)) {
            val tmp = File(old.parentFile, old.name + ".valence-tmp")
            old.renameTo(tmp) && tmp.renameTo(File(root, target))
        } else {
            old.renameTo(File(root, target))
        }
        if (!ok) throw java.io.IOException("the file couldn't be renamed")
        indexPlaylistsNow()
        return staticId(target)
    }

    /** Deletes a static playlist's file; Syncthing then removes it on the other devices too, like a desktop delete. */
    fun deletePlaylist(id: String, done: () -> Unit) {
        app.scope.launch(io) {
            val root = root()
            val rel = staticPlaylistPath(id)
            if (root != null && rel != null) {
                val f = File(root, rel)
                if (f.exists() && !f.delete()) toast("Couldn't delete the playlist") else toast("Playlist deleted")
                indexPlaylistsNow()
            }
            withContext(Dispatchers.Main) { done() }
        }
    }

    /** The file of a playlist the phone may change, or null (with a note) for desktop-managed ones. */
    private fun staticPlaylistPath(id: String): String? {
        val row = db.readableDatabase.rawQuery("SELECT rel_path, kind FROM playlists WHERE id = ?", arrayOf(id))
            .use { if (it.moveToFirst()) it.getString(0) to it.getString(1) else null } ?: return null
        if (row.second != "static" || row.first == null) {
            toast("This playlist is managed on your computer")
            return null
        }
        return row.first
    }

    /** Re-reads the file right before writing (never a stale copy) and keeps entries the phone can't resolve. */
    private fun editPlaylist(id: String, change: (List<M3u8.Entry>) -> List<M3u8.Entry>) {
        app.scope.launch(io) {
            val root = root() ?: return@launch
            val rel = staticPlaylistPath(id) ?: return@launch
            try {
                val file = File(root, rel)
                val before = M3u8.read(file, root)
                val after = change(before)
                if (after != before) M3u8.write(file, root, after)
                indexPlaylistsNow()
            } catch (x: Exception) {
                fail("Couldn't change the playlist", x)
            }
        }
    }

    private fun entryFor(t: Track) = M3u8.entry(t.relPath, t.artist, t.title, t.durationMs)

    /** The desktop's naming rules; [except] is a playlist being renamed, whose own name doesn't count as taken. */
    private fun freeName(root: File, name: String, except: String? = null): String {
        val base = Keys.sanitizeComponent(name.ifBlank { "Playlist" }, 60)
        val taken = File(root, PLAYLISTS_DIR).list().orEmpty().mapTo(HashSet()) { Keys.foldKey(it) }
        if (except != null) taken.remove(Keys.foldKey(except.substringAfterLast('/')))
        for (n in 1..999) {
            val file = base + (if (n > 1) " ($n)" else "") + ".m3u8"
            if (Keys.foldKey(file) !in taken) return "$PLAYLISTS_DIR/$file"
        }
        return "$PLAYLISTS_DIR/$base ${java.util.UUID.randomUUID().toString().take(6)}.m3u8"
    }

    // ---- Helpers -------------------------------------------------------------------------------

    private val main = Handler(Looper.getMainLooper())
    private fun toast(msg: String) = main.post { Toast.makeText(app, msg, Toast.LENGTH_SHORT).show() }
    private fun fail(msg: String, x: Exception) {
        Log.w(TAG, msg, x)
        toast("$msg: ${x.message ?: x.javaClass.simpleName}")
    }

    companion object {
        private const val TAG = "Sync"
        const val PLAYLISTS_DIR = "Playlists"
        private val M3U = Regex("\\.m3u8?$", RegexOption.IGNORE_CASE)
        private val CONFLICT_PART = Regex("\\.sync-conflict-[^.]*")

        private val SMART_FIELDS = mapOf(
            "title" to "t.title", "artist" to "t.artist", "album" to "t.album", "albumArtist" to "t.album_artist",
            "genre" to "t.genre", "year" to "t.year",
            // The desktop's rule editor stores stars x20 (4 stars = 80) while tags hold 0..5; compare like the editor means it.
            "rating" to "(t.rating * 20)",
            "playCount" to "coalesce(ps.play_count, 0)", "skipCount" to "coalesce(ps.skip_count, 0)",
            "addedAt" to "t.added_at", "lastPlayed" to "ps.last_played", "durationMs" to "t.duration_ms",
            "codec" to "t.codec", "lossless" to "t.lossless", "source" to "NULL", "compilation" to "t.compilation",
            "hqRip" to "t.hq_rip",
            "liked" to "(SELECT count(*) FROM favorites f WHERE f.kind = 't' AND f.item_key = t.track_key AND f.liked = 1)",
        )

        /** The desktop's static playlist id: derived from the path, so a rename makes a new id. */
        fun staticId(relPath: String): String {
            val sha = MessageDigest.getInstance("SHA-1").digest(Keys.foldKey(relPath).toByteArray())
            return "m3u-" + sha.joinToString("") { "%02x".format(it) }.take(16)
        }
    }
}
