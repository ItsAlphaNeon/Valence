package app.valence.playback

import android.app.PendingIntent
import android.content.Intent
import android.os.Bundle
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.session.CommandButton
import androidx.media3.session.DefaultMediaNotificationProvider
import androidx.media3.session.LibraryResult
import androidx.media3.session.MediaLibraryService
import androidx.media3.session.MediaSession
import androidx.media3.session.SessionCommand
import androidx.media3.session.SessionError
import androidx.media3.session.SessionResult
import app.valence.MainActivity
import app.valence.R
import app.valence.ValenceApp
import app.valence.art.ArtStore
import app.valence.data.AutoList
import app.valence.data.Collection
import app.valence.data.Db
import app.valence.data.Track
import com.google.common.collect.ImmutableList
import com.google.common.util.concurrent.Futures
import com.google.common.util.concurrent.ListenableFuture
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.guava.future
import kotlinx.coroutines.launch

/**
 * The media session around [Playback.player]: notification, lock screen, Bluetooth/headset
 * buttons, Android Auto and other controllers. Auto gets a browse tree of the library.
 */
class PlaybackService : MediaLibraryService() {
    private var session: MediaLibrarySession? = null
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val app get() = application as ValenceApp

    override fun onCreate() {
        super.onCreate()
        val pb = app.playback
        val open = PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java).putExtra(MainActivity.EXTRA_OPEN_PLAYER, true).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        session = MediaLibrarySession.Builder(this, pb.player, Callback())
            .setSessionActivity(open)
            .build()
        setMediaNotificationProvider(DefaultMediaNotificationProvider.Builder(this).build().apply { setSmallIcon(R.drawable.ic_notification) })
        scope.launch { pb.current.collect { updateLikeButton() } }
        scope.launch { app.db.version(Db.Topic.Favorites).collect { updateLikeButton() } }
    }

    override fun onGetSession(controllerInfo: MediaSession.ControllerInfo): MediaLibrarySession? = session

    override fun onTaskRemoved(rootIntent: Intent?) {
        val p = session?.player
        if (p == null || !p.playWhenReady || p.mediaItemCount == 0) {
            app.playback.persist()
            stopSelf()
        }
    }

    override fun onDestroy() {
        app.playback.persist()
        scope.cancel()
        // The player belongs to the app (it outlives the service); only the session goes.
        session?.release()
        session = null
        super.onDestroy()
    }

    // ---- Like button in the notification -------------------------------------------------------

    private fun currentLiked(): Boolean {
        val t = app.playback.current.value ?: return false
        return app.library.isLiked("t", t.trackKey)
    }

    private fun likeButton(liked: Boolean) = CommandButton.Builder(if (liked) CommandButton.ICON_HEART_FILLED else CommandButton.ICON_HEART_UNFILLED)
        .setDisplayName(if (liked) "Unlike" else "Like")
        .setSessionCommand(SessionCommand(CMD_LIKE, Bundle.EMPTY))
        .build()

    private fun updateLikeButton() {
        val s = session ?: return
        scope.launch {
            val liked = kotlinx.coroutines.withContext(Dispatchers.IO) { currentLiked() }
            s.setMediaButtonPreferences(ImmutableList.of(likeButton(liked)))
        }
    }

    // ---- Session callback ----------------------------------------------------------------------

    private inner class Callback : MediaLibrarySession.Callback {
        override fun onConnect(session: MediaSession, controller: MediaSession.ControllerInfo): MediaSession.ConnectionResult {
            val commands = MediaSession.ConnectionResult.DEFAULT_SESSION_AND_LIBRARY_COMMANDS.buildUpon()
                .add(SessionCommand(CMD_LIKE, Bundle.EMPTY))
                .build()
            return MediaSession.ConnectionResult.AcceptedResultBuilder(session)
                .setAvailableSessionCommands(commands)
                .setMediaButtonPreferences(ImmutableList.of(likeButton(currentLiked())))
                .build()
        }

        override fun onCustomCommand(session: MediaSession, controller: MediaSession.ControllerInfo, customCommand: SessionCommand, args: Bundle): ListenableFuture<SessionResult> {
            if (customCommand.customAction == CMD_LIKE) {
                app.playback.current.value?.let { t -> app.sync.setTrackLiked(t, !currentLiked()) }
                return Futures.immediateFuture(SessionResult(SessionResult.RESULT_SUCCESS))
            }
            return Futures.immediateFuture(SessionResult(SessionError.ERROR_NOT_SUPPORTED))
        }

        override fun onGetLibraryRoot(session: MediaLibrarySession, browser: MediaSession.ControllerInfo, params: LibraryParams?): ListenableFuture<LibraryResult<MediaItem>> =
            Futures.immediateFuture(LibraryResult.ofItem(folder(ROOT, "Valence"), params))

        override fun onGetItem(session: MediaLibrarySession, browser: MediaSession.ControllerInfo, mediaId: String): ListenableFuture<LibraryResult<MediaItem>> =
            scope.future(Dispatchers.IO) {
                val t = trackOf(mediaId)
                if (t != null) LibraryResult.ofItem(app.playback.run { t.toMediaItem() }, null) else LibraryResult.ofError(SessionError.ERROR_BAD_VALUE)
            }

        override fun onGetChildren(
            session: MediaLibrarySession, browser: MediaSession.ControllerInfo, parentId: String, page: Int, pageSize: Int, params: LibraryParams?,
        ): ListenableFuture<LibraryResult<ImmutableList<MediaItem>>> = scope.future(Dispatchers.IO) {
            val all = children(parentId)
            val from = (page * pageSize).coerceAtMost(all.size)
            val to = (from + pageSize).coerceAtMost(all.size)
            LibraryResult.ofItemList(ImmutableList.copyOf(all.subList(from, to)), params)
        }

        override fun onSearch(session: MediaLibrarySession, browser: MediaSession.ControllerInfo, query: String, params: LibraryParams?): ListenableFuture<LibraryResult<Void>> {
            scope.launch(Dispatchers.IO) {
                val n = app.library.search(query, Collection.All).tracks.size
                session.notifySearchResultChanged(browser, query, n, params)
            }
            return Futures.immediateFuture(LibraryResult.ofVoid())
        }

        override fun onGetSearchResult(
            session: MediaLibrarySession, browser: MediaSession.ControllerInfo, query: String, page: Int, pageSize: Int, params: LibraryParams?,
        ): ListenableFuture<LibraryResult<ImmutableList<MediaItem>>> = scope.future(Dispatchers.IO) {
            val all = app.library.search(query, Collection.All).tracks.map { playable(it, "search:$query") }
            val from = (page * pageSize).coerceAtMost(all.size)
            LibraryResult.ofItemList(ImmutableList.copyOf(all.subList(from, (from + pageSize).coerceAtMost(all.size))), params)
        }

        override fun onAddMediaItems(mediaSession: MediaSession, controller: MediaSession.ControllerInfo, mediaItems: List<MediaItem>): ListenableFuture<List<MediaItem>> =
            scope.future(Dispatchers.IO) { mediaItems.flatMap { expand(it).first } }

        override fun onSetMediaItems(
            mediaSession: MediaSession, controller: MediaSession.ControllerInfo, mediaItems: List<MediaItem>, startIndex: Int, startPositionMs: Long,
        ): ListenableFuture<MediaSession.MediaItemsWithStartPosition> = scope.future(Dispatchers.IO) {
            if (mediaItems.size == 1) {
                // A single browsed song plays in the context it was picked from (its album, playlist...).
                val (items, start) = expand(mediaItems[0])
                MediaSession.MediaItemsWithStartPosition(items, start, startPositionMs)
            } else {
                MediaSession.MediaItemsWithStartPosition(mediaItems.flatMap { expand(it).first }, startIndex, startPositionMs)
            }
        }

        override fun onPlaybackResumption(mediaSession: MediaSession, controller: MediaSession.ControllerInfo, isForPlayback: Boolean): ListenableFuture<MediaSession.MediaItemsWithStartPosition> =
            scope.future {
                val pb = app.playback
                pb.restore()
                // restore() loads asynchronously; wait for the queue to arrive.
                val q = kotlinx.coroutines.withTimeoutOrNull(3000) { pb.queue.first { it.isNotEmpty() } }.orEmpty()
                MediaSession.MediaItemsWithStartPosition(q.map { pb.run { it.toMediaItem() } }, pb.player.currentMediaItemIndex.coerceAtLeast(0), pb.player.currentPosition)
            }
    }

    // ---- Browse tree ---------------------------------------------------------------------------

    private fun folder(id: String, title: String, subtitle: String? = null, artTrack: Long? = null, playable: Boolean = false) = MediaItem.Builder()
        .setMediaId(id)
        .setMediaMetadata(
            MediaMetadata.Builder()
                .setTitle(title)
                .setSubtitle(subtitle)
                .setArtworkUri(artTrack?.let { ArtStore.uri(it) })
                .setIsBrowsable(true)
                .setIsPlayable(playable)
                .setMediaType(MediaMetadata.MEDIA_TYPE_FOLDER_MIXED)
                .build(),
        ).build()

    /** A song item whose id remembers where it was browsed from, so playing it plays that list. */
    private fun playable(t: Track, context: String): MediaItem {
        val base = Playback.mediaItemFor(t, app.library.fileOf(t))
        return base.buildUpon().setMediaId("track:${t.id}@$context").build()
    }

    private fun trackOf(mediaId: String): Track? {
        val id = mediaId.removePrefix("track:").substringBefore('@').toLongOrNull() ?: return null
        return app.library.track(id)
    }

    private suspend fun contextTracks(context: String): List<Track> {
        val lib = app.library
        val kind = context.substringBefore(':')
        val arg = context.substringAfter(':', "")
        return when (kind) {
            "album" -> lib.albumTracks(arg.toLong()).first()
            "artist" -> lib.artistTracks(arg).first()
            "playlist" -> lib.playlistTracksNow(arg)
            "auto" -> lib.autoListNow(AutoList.valueOf(arg), Collection.Main)
            "songs" -> lib.songs(Collection.Main, "title").first()
            "rips" -> lib.songs(Collection.Rips, "uploaded").first()
            "search" -> lib.search(arg, Collection.All).tracks
            else -> emptyList()
        }
    }

    /** Turns a controller's request into playable items (+ start index). */
    private suspend fun expand(item: MediaItem): Pair<List<MediaItem>, Int> {
        val pb = app.playback
        val id = item.mediaId
        val query = item.requestMetadata.searchQuery
        if (id.isEmpty() && !query.isNullOrBlank()) {
            // "Play <query> on Valence"
            val r = app.library.search(query, Collection.All)
            val tracks = r.tracks.ifEmpty { r.albums.firstOrNull()?.let { app.library.albumTracks(it.id).first() }.orEmpty() }
            return tracks.map { pb.run { it.toMediaItem() } } to 0
        }
        if (id.startsWith("track:")) {
            val t = trackOf(id) ?: return emptyList<MediaItem>() to 0
            val context = id.substringAfter('@', "")
            if (context.isNotEmpty()) {
                val list = contextTracks(context)
                val start = list.indexOfFirst { it.id == t.id }
                if (start >= 0) return list.map { pb.run { it.toMediaItem() } } to start
            }
            return listOf(pb.run { t.toMediaItem() }) to 0
        }
        id.toLongOrNull()?.let { app.library.track(it) }?.let { return listOf(pb.run { it.toMediaItem() }) to 0 }
        // A playable folder (album, playlist...): play it from the top.
        val list = contextTracks(id)
        return list.map { pb.run { it.toMediaItem() } } to 0
    }

    private suspend fun children(parentId: String): List<MediaItem> {
        val lib = app.library
        return when {
            parentId == ROOT -> listOf(
                folder(NODE_RECENT, "Recently added"),
                folder("auto:${AutoList.Liked.name}", "Liked songs", playable = true),
                folder(NODE_ALBUMS, "Albums"),
                folder(NODE_ARTISTS, "Artists"),
                folder(NODE_PLAYLISTS, "Playlists"),
                folder(NODE_SIIVA, "SiivaGunner"),
            )
            parentId == NODE_RECENT -> lib.autoListNow(AutoList.RecentlyAdded, Collection.Main).take(100).map { playable(it, "auto:${AutoList.RecentlyAdded.name}") }
            parentId == NODE_ALBUMS -> lib.albums(Collection.Main, "artist").first().map { folder("album:${it.id}", it.title, it.albumArtist, it.artTrackId, playable = true) }
            parentId == NODE_ARTISTS -> lib.artists(Collection.Main).first().map { folder("artist:${it.name}", it.name, "${it.trackCount} songs", it.artTrackId, playable = true) }
            parentId == NODE_PLAYLISTS -> lib.playlists().first().map { folder("playlist:${it.id}", it.name, "${it.itemCount} songs", it.artTrackId, playable = true) }
            parentId == NODE_SIIVA -> lib.seasons(app.sync.seasons()).first().plus(lib.ripAlbums().first())
                .map { folder("album:${it.id}", it.title, "${it.trackCount} rips", it.artTrackId, playable = true) }
            parentId.contains(':') && !parentId.startsWith("track:") -> contextTracks(parentId).map { playable(it, parentId) }
            else -> emptyList()
        }
    }

    companion object {
        const val CMD_LIKE = "app.valence.LIKE"
        private const val ROOT = "root"
        private const val NODE_RECENT = "node:recent"
        private const val NODE_ALBUMS = "node:albums"
        private const val NODE_ARTISTS = "node:artists"
        private const val NODE_PLAYLISTS = "node:playlists"
        private const val NODE_SIIVA = "node:siiva"
    }
}
