package app.valence.art

import android.content.ContentProvider
import android.content.ContentValues
import android.database.Cursor
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import android.os.ParcelFileDescriptor
import android.os.Process
import android.system.Os
import android.util.LruCache
import app.valence.ValenceApp
import app.valence.tags.PictureRef
import app.valence.tags.TagReader
import coil3.ImageLoader
import coil3.decode.DataSource
import coil3.decode.ImageSource
import coil3.fetch.FetchResult
import coil3.fetch.Fetcher
import coil3.fetch.SourceFetchResult
import coil3.key.Keyer
import coil3.request.Options
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.isActive
import kotlinx.coroutines.withContext
import okio.Buffer
import okio.Path.Companion.toOkioPath
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FileOutputStream
import java.util.concurrent.atomic.AtomicInteger
import java.util.zip.CRC32
import kotlin.math.max

/**
 * Album art is the picture embedded in a track's file. Lists ask for [thumb] art: a small JPEG
 * made once per song and kept in the app's cache, so scrolling never decodes full-size covers.
 */
data class TrackArt(val trackId: Long, val thumb: Boolean = false)

object ArtStore {
    private data class Ref(val path: String, val mime: String, val offset: Long, val length: Int, val mtime: Long)

    private val refs = LruCache<Long, Ref>(8192)

    /** Bumped when a scan changes files, so cached images (keyed by id) are looked up again. */
    private val generation = AtomicInteger(0)

    private const val THUMB_PX = 320
    private const val TV_PX = 1000

    private fun ref(trackId: Long): Ref? {
        refs.get(trackId)?.let { return it }
        val app = ValenceApp.instance
        val root = app.prefs.musicRoot.value
        val r = app.db.readableDatabase.rawQuery(
            "SELECT rel_path, pic_mime, pic_offset, pic_length, mtime FROM tracks WHERE id = ? AND pic_length > 0",
            arrayOf(trackId.toString()),
        ).use { c -> if (c.moveToFirst()) Ref(File(root, c.getString(0)).path, c.getString(1) ?: "image/jpeg", c.getLong(2), c.getInt(3), c.getLong(4)) else null }
        if (r != null) refs.put(trackId, r)
        return r
    }

    fun invalidate() {
        refs.evictAll()
        generation.incrementAndGet()
    }

    /** Coil cache key. Computed without touching the database: it runs on the main thread. */
    fun cacheKey(art: TrackArt): String = "art:${art.trackId}:${generation.get()}:${if (art.thumb) "t" else "f"}"

    /** The embedded picture's bytes and MIME type, or null if the track has none (or the file moved). */
    fun bytes(trackId: Long): Pair<ByteArray, String>? {
        val r = ref(trackId) ?: return null
        val bytes = runCatching { TagReader.readPicture(File(r.path), PictureRef(r.mime, r.offset, r.length)) }.getOrNull()
            ?: runCatching { TagReader.readPicture(File(r.path)) }.getOrNull()
            ?: return null
        return bytes to r.mime
    }

    /** The track's art as a JPEG small enough for a TV page to handle quickly, or null if it has none. */
    fun tvJpeg(trackId: Long): ByteArray? {
        val (bytes, _) = bytes(trackId) ?: return null
        val bmp = decodeSampled(bytes, TV_PX) ?: return null
        val scaled = scaleDown(bmp, TV_PX)
        val out = ByteArrayOutputStream()
        scaled.compress(Bitmap.CompressFormat.JPEG, 90, out)
        if (scaled !== bmp) scaled.recycle()
        bmp.recycle()
        return out.toByteArray()
    }

    private fun thumbDir(): File = File(ValenceApp.instance.cacheDir, "thumbs").apply { mkdirs() }

    /** The thumbnail if it's already made (a file check, nothing more). */
    fun existingThumb(trackId: Long): File? {
        val r = ref(trackId) ?: return null
        return File(thumbDir(), "${trackId}_${r.mtime}.jpg").takeIf { it.length() > 0 }
    }

    /**
     * A [THUMB_PX] JPEG of the track's art, made on first use (null if it has none). Songs that
     * embed the same cover (most albums) share one thumbnail: it's made once, keyed by the
     * picture's checksum, and hard-linked under each song's name.
     */
    fun thumbFile(trackId: Long, stillWanted: () -> Boolean = { true }): File? {
        existingThumb(trackId)?.let { return it }
        val r = ref(trackId) ?: return null
        val f = File(thumbDir(), "${trackId}_${r.mtime}.jpg")
        val (bytes, _) = bytes(trackId) ?: return null
        val crc = CRC32().apply { update(bytes) }.value
        val shared = File(thumbDir(), "c${java.lang.Long.toHexString(crc)}_${bytes.size}.jpg")
        if (shared.length() == 0L) {
            if (!stillWanted()) return null
            val bmp = decodeSampled(bytes, THUMB_PX) ?: return null
            val scaled = scaleDown(bmp, THUMB_PX)
            val tmp = File(shared.path + ".${Thread.currentThread().id}.tmp")
            runCatching {
                FileOutputStream(tmp).use { scaled.compress(Bitmap.CompressFormat.JPEG, 88, it) }
                tmp.renameTo(shared)
            }
            if (scaled !== bmp) scaled.recycle()
            bmp.recycle()
        }
        if (shared.length() == 0L) return null
        runCatching { Os.link(shared.path, f.path) }
        return if (f.length() > 0) f else shared
    }

    /**
     * Makes the missing thumbnails for the whole library on one low-priority thread, so lists
     * almost never have to make one while you scroll. Cheap when they all exist.
     */
    fun prefetchThumbs(isActive: () -> Boolean) {
        val prio = Process.getThreadPriority(Process.myTid())
        Process.setThreadPriority(Process.THREAD_PRIORITY_LOWEST)
        try {
            val ids = ValenceApp.instance.db.readableDatabase.rawQuery(
                "SELECT id FROM tracks WHERE pic_length > 0 ORDER BY album_id, id", null,
            ).use { c -> buildList { while (c.moveToNext()) add(c.getLong(0)) } }
            for (id in ids) {
                if (!isActive()) return
                runCatching { thumbFile(id) }
            }
        } finally {
            Process.setThreadPriority(prio)
        }
    }

    /**
     * A tiny, blurred copy of the art for the Now playing backdrop. Blurring 40 px on the CPU once
     * per song is far cheaper than a GPU blur that would rerun on every frame of a tab swipe.
     */
    fun backdrop(trackId: Long): Bitmap? {
        val (bytes, _) = bytes(trackId) ?: return null
        val src = decodeSampled(bytes, 80) ?: return null
        val small = Bitmap.createScaledBitmap(src, 36, 36, true)
        if (small !== src) src.recycle()
        val w = small.width
        val h = small.height
        val px = IntArray(w * h)
        small.getPixels(px, 0, w, 0, 0, w, h)
        repeat(3) { boxBlur(px, w, h, 2) }
        val out = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
        out.setPixels(px, 0, w, 0, 0, w, h)
        small.recycle()
        return out
    }

    private fun decodeSampled(bytes: ByteArray, target: Int): Bitmap? {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
        if (bounds.outWidth <= 0) return null
        var sample = 1
        while (max(bounds.outWidth, bounds.outHeight) / (sample * 2) >= target) sample *= 2
        return BitmapFactory.decodeByteArray(bytes, 0, bytes.size, BitmapFactory.Options().apply { inSampleSize = sample })
    }

    private fun scaleDown(b: Bitmap, target: Int): Bitmap {
        val m = max(b.width, b.height)
        if (m <= target) return b
        val s = target.toFloat() / m
        return Bitmap.createScaledBitmap(b, max(1, (b.width * s).toInt()), max(1, (b.height * s).toInt()), true)
    }

    private fun boxBlur(px: IntArray, w: Int, h: Int, r: Int) {
        val tmp = IntArray(px.size)
        for (pass in 0..1) {
            val src = if (pass == 0) px else tmp
            val dst = if (pass == 0) tmp else px
            for (y in 0 until h) for (x in 0 until w) {
                var a = 0; var rr = 0; var g = 0; var b = 0; var n = 0
                for (k in -r..r) {
                    val xx = if (pass == 0) (x + k).coerceIn(0, w - 1) else x
                    val yy = if (pass == 0) y else (y + k).coerceIn(0, h - 1)
                    val c = src[yy * w + xx]
                    a += c ushr 24; rr += (c shr 16) and 0xFF; g += (c shr 8) and 0xFF; b += c and 0xFF; n++
                }
                dst[y * w + x] = ((a / n) shl 24) or ((rr / n) shl 16) or ((g / n) shl 8) or (b / n)
            }
        }
    }

    fun uri(trackId: Long): Uri = Uri.parse("content://$AUTHORITY/track/$trackId")

    const val AUTHORITY = "app.valence.art"
}

private val thumbGate = Dispatchers.IO.limitedParallelism(2)

class TrackArtFetcher(private val data: TrackArt, private val options: Options) : Fetcher {
    override suspend fun fetch(): FetchResult? {
        if (data.thumb) {
            // Made ones load straight away; making one waits for one of two slots and is skipped
            // if the row has scrolled away meanwhile (Coil cancels the request).
            val f = ArtStore.existingThumb(data.trackId) ?: withContext(thumbGate) {
                val job = coroutineContext
                ArtStore.thumbFile(data.trackId) { job.isActive }
            } ?: return null
            return SourceFetchResult(
                source = ImageSource(f.toOkioPath(), options.fileSystem),
                mimeType = "image/jpeg",
                dataSource = DataSource.DISK,
            )
        }
        val (bytes, mime) = ArtStore.bytes(data.trackId) ?: return null
        return SourceFetchResult(
            source = ImageSource(Buffer().write(bytes), options.fileSystem),
            mimeType = mime,
            dataSource = DataSource.DISK,
        )
    }

    class Factory : Fetcher.Factory<TrackArt> {
        override fun create(data: TrackArt, options: Options, imageLoader: ImageLoader): Fetcher = TrackArtFetcher(data, options)
    }
}

class TrackArtKeyer : Keyer<TrackArt> {
    override fun key(data: TrackArt, options: Options): String = ArtStore.cacheKey(data)
}

/**
 * Serves embedded art as content://app.valence.art/track/<id> for the media notification, the
 * lock screen and Android Auto, which load artwork by URI from outside the app.
 */
class ArtProvider : ContentProvider() {
    override fun onCreate() = true

    override fun getType(uri: Uri): String = "image/jpeg"

    override fun openFile(uri: Uri, mode: String): ParcelFileDescriptor? {
        val id = uri.lastPathSegment?.toLongOrNull() ?: return null
        val (bytes, _) = ArtStore.bytes(id) ?: return null
        val (read, write) = ParcelFileDescriptor.createPipe()
        Thread { runCatching { ParcelFileDescriptor.AutoCloseOutputStream(write).use { it.write(bytes) } } }.start()
        return read
    }

    override fun query(uri: Uri, projection: Array<out String>?, selection: String?, selectionArgs: Array<out String>?, sortOrder: String?): Cursor? = null
    override fun insert(uri: Uri, values: ContentValues?): Uri? = null
    override fun delete(uri: Uri, selection: String?, selectionArgs: Array<out String>?) = 0
    override fun update(uri: Uri, values: ContentValues?, selection: String?, selectionArgs: Array<out String>?) = 0
}
