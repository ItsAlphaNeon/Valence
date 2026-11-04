package app.valence.data

import android.content.ContentValues
import android.content.Context
import android.database.Cursor
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * The phone's own index of the music folder. Like the desktop's, it is local and rebuildable:
 * files (and the synced .valence logs) are the source of truth. Migrations are append-only.
 */
class Db(context: Context) : SQLiteOpenHelper(context, "valence.db", null, MIGRATIONS.size) {

    /** Bumped after every write that changes what a screen shows; queries re-run when it changes. */
    enum class Topic { Tracks, Plays, Favorites, Playlists }

    private val versions = Topic.entries.associateWith { MutableStateFlow(0L) }
    fun version(t: Topic): StateFlow<Long> = versions.getValue(t).asStateFlow()
    fun changed(vararg topics: Topic) = topics.forEach { versions.getValue(it).value++ }

    override fun onConfigure(db: SQLiteDatabase) {
        db.enableWriteAheadLogging()
        db.setForeignKeyConstraintsEnabled(false)
    }

    override fun onCreate(db: SQLiteDatabase) = onUpgrade(db, 0, MIGRATIONS.size)

    override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) {
        for (v in oldVersion until newVersion) MIGRATIONS[v].forEach(db::execSQL)
    }

    inline fun <T> tx(block: SQLiteDatabase.() -> T): T {
        val db = writableDatabase
        db.beginTransaction()
        try {
            return db.block().also { db.setTransactionSuccessful() }
        } finally {
            db.endTransaction()
        }
    }

    companion object {
        const val REBUILD_STATS = """INSERT OR REPLACE INTO play_stats
            SELECT track_key, sum(CASE WHEN skipped = 0 THEN 1 ELSE 0 END), sum(skipped), max(CASE WHEN skipped = 0 THEN played_at END)
            FROM plays GROUP BY track_key"""

        private val MIGRATIONS: List<List<String>> = listOf(
            listOf(
                """CREATE TABLE tracks(
                    id INTEGER PRIMARY KEY,
                    rel_path TEXT NOT NULL UNIQUE,
                    folder TEXT NOT NULL,
                    size INTEGER NOT NULL, mtime INTEGER NOT NULL,
                    valence_id TEXT,
                    track_key TEXT NOT NULL,
                    title TEXT NOT NULL, artist TEXT, artists TEXT, album TEXT, album_artist TEXT NOT NULL,
                    track_no INTEGER, track_total INTEGER, disc_no INTEGER, disc_total INTEGER,
                    year INTEGER, date TEXT, genre TEXT, composer TEXT, compilation INTEGER NOT NULL DEFAULT 0,
                    duration_ms INTEGER NOT NULL DEFAULT 0, codec TEXT, bitrate INTEGER, sample_rate INTEGER, bit_depth INTEGER, lossless INTEGER NOT NULL DEFAULT 0,
                    rg_track_gain REAL, rg_track_peak REAL, rg_album_gain REAL, rg_album_peak REAL,
                    rating INTEGER NOT NULL DEFAULT 0, lyrics_kind INTEGER NOT NULL DEFAULT 0,
                    pic_mime TEXT, pic_offset INTEGER, pic_length INTEGER,
                    album_key TEXT NOT NULL, album_id INTEGER,
                    hq_rip TEXT NOT NULL DEFAULT '', rip_game TEXT, rip_platform TEXT, yt_uploaded TEXT,
                    sort_title TEXT NOT NULL, sort_artist TEXT NOT NULL, sort_album TEXT NOT NULL,
                    search TEXT NOT NULL DEFAULT '',
                    added_at INTEGER NOT NULL
                )""",
                "CREATE INDEX tracks_album ON tracks(album_id, disc_no, track_no)",
                "CREATE INDEX tracks_key ON tracks(track_key)",
                "CREATE INDEX tracks_folder ON tracks(folder)",
                "CREATE INDEX tracks_rip ON tracks(hq_rip, sort_title)",
                "CREATE INDEX tracks_artist ON tracks(album_artist)",
                """CREATE TABLE albums(
                    id INTEGER PRIMARY KEY,
                    album_key TEXT NOT NULL UNIQUE,
                    title TEXT NOT NULL, album_artist TEXT NOT NULL, year INTEGER, genre TEXT,
                    track_count INTEGER NOT NULL DEFAULT 0, duration_ms INTEGER NOT NULL DEFAULT 0,
                    art_track_id INTEGER, hq_rip TEXT NOT NULL DEFAULT '',
                    rel_dir TEXT NOT NULL, added_at INTEGER NOT NULL DEFAULT 0,
                    sort_title TEXT NOT NULL, sort_artist TEXT NOT NULL
                )""",
                "CREATE INDEX albums_artist ON albums(album_artist)",
                // Every device's plays, ingested from .valence/devices/*/plays-*.jsonl (this phone's included).
                """CREATE TABLE plays(
                    device_id TEXT NOT NULL, hlc TEXT NOT NULL, track_key TEXT NOT NULL,
                    played_at INTEGER NOT NULL, ms INTEGER NOT NULL, completed INTEGER NOT NULL, skipped INTEGER NOT NULL,
                    PRIMARY KEY(device_id, hlc)
                )""",
                "CREATE INDEX plays_key ON plays(track_key)",
                "CREATE INDEX plays_at ON plays(played_at)",
                // Per-track totals, rebuilt from plays after each ingest (a table, not a view, so list queries stay fast).
                """CREATE TABLE play_stats(
                    track_key TEXT PRIMARY KEY, play_count INTEGER NOT NULL, skip_count INTEGER NOT NULL, last_played INTEGER
                )""",
                // Likes, last-writer-wins by HLC across devices (favorites.jsonl).
                """CREATE TABLE favorites(
                    kind TEXT NOT NULL, item_key TEXT NOT NULL, liked INTEGER NOT NULL, at INTEGER, hlc TEXT NOT NULL,
                    PRIMARY KEY(kind, item_key)
                )""",
                "CREATE TABLE log_cursors(device TEXT NOT NULL, file TEXT NOT NULL, offset INTEGER NOT NULL, PRIMARY KEY(device, file))",
                """CREATE TABLE playlists(
                    id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL, rel_path TEXT, rules TEXT,
                    mtime INTEGER NOT NULL DEFAULT 0, item_count INTEGER NOT NULL DEFAULT 0
                )""",
                "CREATE TABLE playlist_items(playlist_id TEXT NOT NULL, pos INTEGER NOT NULL, rel_path TEXT NOT NULL, PRIMARY KEY(playlist_id, pos))",
                "CREATE INDEX playlist_items_path ON playlist_items(rel_path)",
            ),
        )
    }
}

fun Cursor.str(i: Int): String? = if (isNull(i)) null else getString(i)
fun Cursor.intOrNull(i: Int): Int? = if (isNull(i)) null else getInt(i)
fun Cursor.longOrNull(i: Int): Long? = if (isNull(i)) null else getLong(i)
fun Cursor.dbl(i: Int): Double? = if (isNull(i)) null else getDouble(i)

inline fun <T> Cursor.mapAll(row: Cursor.() -> T): List<T> = use { c ->
    buildList(c.count) { while (c.moveToNext()) add(c.row()) }
}

fun cv(vararg pairs: Pair<String, Any?>) = ContentValues(pairs.size).apply {
    for ((k, v) in pairs) when (v) {
        null -> putNull(k)
        is String -> put(k, v)
        is Int -> put(k, v)
        is Long -> put(k, v)
        is Double -> put(k, v)
        is Float -> put(k, v)
        is Boolean -> put(k, if (v) 1 else 0)
        else -> put(k, v.toString())
    }
}
