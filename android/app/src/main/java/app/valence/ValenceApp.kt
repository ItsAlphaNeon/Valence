package app.valence

import android.app.Application
import android.util.Log
import app.valence.art.ArtStore
import app.valence.art.TrackArtFetcher
import app.valence.art.TrackArtKeyer
import app.valence.data.Db
import app.valence.data.Library
import app.valence.data.Prefs
import app.valence.data.Scanner
import app.valence.playback.Playback
import app.valence.sync.Sync
import coil3.ImageLoader
import coil3.PlatformContext
import coil3.SingletonImageLoader
import coil3.memory.MemoryCache
import coil3.request.crossfade
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import java.io.File

/** Process-wide objects. Valence is a single-process app: the UI and the playback service share these. */
class ValenceApp : Application(), SingletonImageLoader.Factory {
    lateinit var prefs: Prefs
        private set
    lateinit var db: Db
        private set
    lateinit var library: Library
        private set
    lateinit var scanner: Scanner
        private set
    lateinit var sync: Sync
        private set
    lateinit var playback: Playback
        private set

    /** Work that should outlive a screen (scans, log ingest). */
    val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    override fun onCreate() {
        super.onCreate()
        instance = this
        prefs = Prefs(this)
        db = Db(this)
        library = Library(db) { prefs.musicRoot.value }
        scanner = Scanner(db)
        sync = Sync(this)
        playback = Playback(this)
    }

    override fun newImageLoader(context: PlatformContext): ImageLoader = ImageLoader.Builder(context)
        .components {
            add(TrackArtKeyer())
            add(TrackArtFetcher.Factory())
        }
        .memoryCache { MemoryCache.Builder().maxSizePercent(context, 0.2).build() }
        .diskCache(null) // art is read straight from the files, which is already fast
        .crossfade(150)
        .build()

    private var refreshJob: Job? = null
    private var lastRefresh = 0L

    /**
     * Brings the index up to date with the synced folder: rescans changed files, reads the other
     * devices' plays and likes, reindexes playlists. Cheap when nothing changed.
     */
    fun refresh(force: Boolean = false) {
        val root = prefs.musicRoot.value
        if (root.isEmpty()) return
        val now = System.currentTimeMillis()
        if (!force && now - lastRefresh < 30_000) return
        if (refreshJob?.isActive == true) return
        lastRefresh = now
        refreshJob = scope.launch {
            // With an index from last time, bring back the queue right away rather than after the scan.
            val indexed = runCatching {
                db.readableDatabase.rawQuery("SELECT 1 FROM tracks LIMIT 1", null).use { it.moveToFirst() }
            }.getOrDefault(false)
            if (indexed) launch(Dispatchers.Main) { playback.restore() }
            try {
                val changed = scanner.scan(File(root))
                if (changed > 0) {
                    ArtStore.invalidate()
                    prefs.lastScanAt.value = System.currentTimeMillis()
                }
                sync.ingest()
                if (changed > 0) launch(Dispatchers.Main) { playback.refreshTracks() }
            } catch (e: Exception) {
                Log.w("Valence", "Refresh failed", e)
            }
            launch(Dispatchers.Main) { playback.restore() }
        }
    }

    companion object {
        lateinit var instance: ValenceApp
            private set
    }
}
