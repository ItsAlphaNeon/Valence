package app.valence.art

import android.content.ContentProvider
import android.content.ContentValues
import android.database.Cursor
import android.net.Uri
import android.os.ParcelFileDescriptor
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
import okio.Buffer
import java.io.File

/** Album art is the picture embedded in a track's file; nothing is extracted to disk. */
data class TrackArt(val trackId: Long)

object ArtStore {
    private data class Ref(val path: String, val mime: String, val offset: Long, val length: Int, val mtime: Long)

    private val refs = LruCache<Long, Ref>(4096)

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

    fun invalidate() = refs.evictAll()

    fun cacheKey(trackId: Long): String = "art:$trackId:${ref(trackId)?.mtime ?: 0}"

    /** The embedded picture's bytes and MIME type, or null if the track has none (or the file moved). */
    fun bytes(trackId: Long): Pair<ByteArray, String>? {
        val r = ref(trackId) ?: return null
        val bytes = runCatching { TagReader.readPicture(File(r.path), PictureRef(r.mime, r.offset, r.length)) }.getOrNull()
            ?: runCatching { TagReader.readPicture(File(r.path)) }.getOrNull()
            ?: return null
        return bytes to r.mime
    }

    fun uri(trackId: Long): Uri = Uri.parse("content://$AUTHORITY/track/$trackId")

    const val AUTHORITY = "app.valence.art"
}

class TrackArtFetcher(private val data: TrackArt, private val options: Options) : Fetcher {
    override suspend fun fetch(): FetchResult? {
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
    override fun key(data: TrackArt, options: Options): String = ArtStore.cacheKey(data.trackId)
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
