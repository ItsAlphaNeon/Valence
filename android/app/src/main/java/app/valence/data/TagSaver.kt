package app.valence.data

import android.media.MediaExtractor
import android.media.MediaFormat
import android.media.MediaScannerConnection
import android.util.Log
import app.valence.ValenceApp
import app.valence.art.ArtStore
import app.valence.core.AtomicFiles
import app.valence.tags.TagEdit
import app.valence.tags.TagReader
import app.valence.tags.TagWriteException
import app.valence.tags.TagWriter
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import java.io.File
import java.nio.ByteBuffer
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.security.MessageDigest

/**
 * The only code that changes audio files, and only when someone presses Save in the tag editor.
 * Each file is written to `<name>.valence-tmp` beside it, checked (same audio, only the edited tags
 * different, Android still reads it the same), and only then renamed over the original. A file that
 * fails any check is left exactly as it was.
 */
class TagSaver(private val app: ValenceApp) {
    class Failure(val track: Track, val reason: String)

    /**
     * [unchanged]: songs that already had these tags, so their files weren't touched.
     * [albumMoves]: albums that no longer exist after the save → the album their songs went to.
     */
    class Result(val saved: List<Track>, val unchanged: List<Track>, val failures: List<Failure>, val albumMoves: Map<Long, Long?>)

    data class Progress(val done: Int, val total: Int)

    private val _progress = MutableStateFlow<Progress?>(null)
    val progress: StateFlow<Progress?> = _progress.asStateFlow()
    private val lock = Mutex()

    suspend fun save(tracks: List<Track>, edit: TagEdit): Result = lock.withLock {
        withContext(Dispatchers.IO) {
            val root = File(app.prefs.musicRoot.value)
            val before = app.library.tracksByIds(tracks.map { it.id }).associate { it.id to it.albumId }
            val saved = ArrayList<Track>()
            val unchanged = ArrayList<Track>()
            val failures = ArrayList<Failure>()
            _progress.value = Progress(0, tracks.size)
            try {
                for ((i, t) in tracks.withIndex()) {
                    when (val o = saveOne(File(root, t.relPath), edit)) {
                        Outcome.Saved -> saved.add(t)
                        Outcome.Unchanged -> unchanged.add(t)
                        is Outcome.Failed -> failures.add(Failure(t, o.reason))
                    }
                    _progress.value = Progress(i + 1, tracks.size)
                }
                if (saved.isEmpty()) return@withContext Result(saved, unchanged, failures, emptyMap())
                app.scanner.rescanFiles(root, saved.map { it.relPath })
                ArtStore.invalidate()
                // Other apps on the phone (and the system's media library) see the new tags too.
                runCatching { MediaScannerConnection.scanFile(app, saved.map { File(root, it.relPath).path }.toTypedArray(), null, null) }
                Result(saved, unchanged, failures, albumMoves(before, saved))
            } finally {
                _progress.value = null
            }
        }
    }

    private sealed interface Outcome {
        data object Saved : Outcome
        data object Unchanged : Outcome
        class Failed(val reason: String) : Outcome
    }

    private fun saveOne(file: File, edit: TagEdit): Outcome {
        if (!file.isFile) return Outcome.Failed("The file isn't there any more")
        val tmp = File(file.path + AtomicFiles.TMP_SUFFIX)
        try {
            // Don't rewrite (and have Syncthing send) a file that wouldn't change.
            if (runCatching { edit.isAppliedIn(TagReader.read(file).tags) }.getOrDefault(false)) return Outcome.Unchanged
            TagWriter.writeVerified(file, tmp, edit)
            platformCheck(file, tmp)?.let { return Outcome.Failed(it) }
            Files.move(tmp.toPath(), file.toPath(), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING)
            return Outcome.Saved
        } catch (e: TagWriteException) {
            return Outcome.Failed(e.message ?: "The tags couldn't be saved")
        } catch (e: Exception) {
            Log.w(TAG, "Saving tags of ${file.path} failed", e)
            return Outcome.Failed("The tags couldn't be saved (${e.message ?: e.javaClass.simpleName})")
        } finally {
            tmp.delete() // gone already after the move; otherwise don't leave it behind
        }
    }

    /**
     * Android's own parser must read the new file as it read the old one (same stream, same first
     * packets). Skipped when it can't read the original either: playback doesn't depend on it.
     */
    private fun platformCheck(original: File, edited: File): String? {
        val a = probe(original) ?: return null
        val b = probe(edited) ?: return "Android couldn't read the new file, so the original was kept"
        return if (a == b) null else "Android read the new file differently, so the original was kept"
    }

    private data class Probe(val mime: String, val rate: Int, val channels: Int, val times: List<Long>, val digest: String)

    private fun probe(f: File): Probe? {
        val ex = MediaExtractor()
        return try {
            ex.setDataSource(f.path)
            val i = (0 until ex.trackCount).firstOrNull { ex.getTrackFormat(it).getString(MediaFormat.KEY_MIME)?.startsWith("audio/") == true }
                ?: return null
            val fmt = ex.getTrackFormat(i)
            ex.selectTrack(i)
            val buf = ByteBuffer.allocate(1 shl 20)
            val md = MessageDigest.getInstance("SHA-256")
            val times = ArrayList<Long>()
            for (k in 0 until 16) {
                val n = ex.readSampleData(buf, 0)
                if (n < 0) break
                times.add(ex.sampleTime)
                md.update(buf.array(), buf.arrayOffset(), n)
                if (!ex.advance()) break
            }
            Probe(
                fmt.getString(MediaFormat.KEY_MIME)!!, fmt.getInteger(MediaFormat.KEY_SAMPLE_RATE), fmt.getInteger(MediaFormat.KEY_CHANNEL_COUNT),
                times, md.digest().joinToString("") { "%02x".format(it) },
            )
        } catch (e: Exception) {
            null
        } finally {
            ex.release()
        }
    }

    /** For each album the saved songs left that no longer exists: the album most of them are in now. */
    private fun albumMoves(before: Map<Long, Long?>, saved: List<Track>): Map<Long, Long?> {
        val after = app.library.tracksByIds(saved.map { it.id }).associate { it.id to it.albumId }
        val old = saved.mapNotNull { before[it.id] }.toSet()
        if (old.isEmpty()) return emptyMap()
        val still = HashSet<Long>()
        app.db.readableDatabase.rawQuery("SELECT id FROM albums WHERE id IN (${old.joinToString(",")})", null).use { c ->
            while (c.moveToNext()) still.add(c.getLong(0))
        }
        return (old - still).associateWith { gone ->
            saved.filter { before[it.id] == gone }.mapNotNull { after[it.id] }.groupingBy { it }.eachCount().maxByOrNull { it.value }?.key
        }
    }

    companion object {
        private const val TAG = "ValenceTags"
    }
}
