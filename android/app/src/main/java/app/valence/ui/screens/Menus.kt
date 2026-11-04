package app.valence.ui.screens

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.PlaylistAdd
import androidx.compose.material.icons.automirrored.rounded.QueueMusic
import androidx.compose.material.icons.rounded.Add
import androidx.compose.material.icons.rounded.Album
import androidx.compose.material.icons.rounded.Delete
import androidx.compose.material.icons.rounded.Edit
import androidx.compose.material.icons.rounded.Favorite
import androidx.compose.material.icons.rounded.FavoriteBorder
import androidx.compose.material.icons.rounded.Folder
import androidx.compose.material.icons.rounded.Info
import androidx.compose.material.icons.rounded.Person
import androidx.compose.material.icons.rounded.PlayArrow
import androidx.compose.material.icons.automirrored.rounded.PlaylistPlay
import androidx.compose.material.icons.rounded.RemoveCircleOutline
import androidx.compose.material.icons.rounded.Shuffle
import androidx.compose.material.icons.rounded.SkipNext
import androidx.compose.material.icons.rounded.SportsEsports
import androidx.compose.material.icons.rounded.StopCircle
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import app.valence.data.Playlist
import app.valence.data.Track
import app.valence.ui.LocalUi
import app.valence.ui.MenuTarget
import app.valence.ui.components.Art
import app.valence.ui.components.formatDuration
import app.valence.ui.components.formatTotal
import app.valence.ui.components.songs
import app.valence.ui.components.subtitle
import app.valence.ui.rememberFlow
import app.valence.playback.TapMode
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.withContext
import java.text.DateFormat
import java.util.Date
import java.util.Locale

@Composable
private fun MenuItem(icon: ImageVector, text: String, onClick: () -> Unit) {
    Row(Modifier.fillMaxWidth().clickable(onClick = onClick).padding(horizontal = 24.dp, vertical = 14.dp), verticalAlignment = Alignment.CenterVertically) {
        Icon(icon, null, tint = MaterialTheme.colorScheme.onSurfaceVariant)
        Spacer(Modifier.width(20.dp))
        Text(text, style = MaterialTheme.typography.bodyLarge)
    }
}

/** The bottom sheet behind every "⋮" and long-press. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun MenuHost() {
    val ui = LocalUi.current
    val target = ui.menu ?: return
    val sheet = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    val close = { ui.menu = null }
    ModalBottomSheet(onDismissRequest = close, sheetState = sheet) {
        Column(Modifier.navigationBarsPadding().verticalScroll(rememberScrollState())) {
            when (target) {
                is MenuTarget.Song -> SongMenu(target, close)
                is MenuTarget.AlbumMenu -> SongsMenu(target.album.title, null, target.album.artTrackId, close, albumId = target.album.id, artist = target.album.albumArtist, liked = target.album.liked)
                is MenuTarget.Songs -> SongsMenu(target.title, target.tracks, target.tracks.firstOrNull { it.hasArt }?.id, close)
                is MenuTarget.PlaylistMenu -> SongsMenu(target.playlist.name, target.tracks, target.playlist.artTrackId ?: target.tracks?.firstOrNull { it.hasArt }?.id, close, playlist = target.playlist)
            }
        }
    }
}

@Composable
private fun SongMenu(m: MenuTarget.Song, close: () -> Unit) {
    val ui = LocalUi.current
    val pb = ui.playback
    val t = m.track
    val fresh by remember(t.id) { ui.library.watchTrack(t.id) }.collectAsState(t)
    val liked = fresh?.liked ?: t.liked
    val stopAfter by pb.stopAfterId.collectAsState()
    Row(Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
        Art(if (t.hasArt) t.id else null, Modifier.size(56.dp))
        Spacer(Modifier.width(14.dp))
        Column(Modifier.weight(1f)) {
            Text(t.title, style = MaterialTheme.typography.titleMedium, maxLines = 2, overflow = TextOverflow.Ellipsis)
            Text(t.subtitle(), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        IconButton(onClick = { ui.app.sync.setTrackLiked(t, !liked) }) {
            Icon(if (liked) Icons.Rounded.Favorite else Icons.Rounded.FavoriteBorder, if (liked) "Unlike" else "Like", tint = if (liked) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
    HorizontalDivider()
    val inQueue = m.queueIndex != null
    if (!inQueue) {
        if (m.context.isNotEmpty()) {
            MenuItem(Icons.Rounded.PlayArrow, "Play") { ui.play(m.context, m.context.indexOf(t).coerceAtLeast(0), m.label); close() }
        } else {
            MenuItem(Icons.Rounded.PlayArrow, "Play") { pb.play(listOf(t), 0, t.title); close() }
        }
        MenuItem(Icons.Rounded.SkipNext, "Play next") { pb.playNext(listOf(t)); close() }
        MenuItem(Icons.AutoMirrored.Rounded.QueueMusic, "Add to queue") { pb.addToQueue(listOf(t)); close() }
        MenuItem(Icons.AutoMirrored.Rounded.PlaylistPlay, "Play in a new queue") { pb.play(m.context.ifEmpty { listOf(t) }, m.context.indexOf(t).coerceAtLeast(0), m.label.ifEmpty { t.title }, mode = TapMode.NewQueue); close() }
    } else {
        MenuItem(Icons.Rounded.SkipNext, "Play next") {
            val from = m.queueIndex
            val to = (pb.index.value + if (from > pb.index.value) 1 else 0).coerceAtMost(pb.queue.value.lastIndex)
            pb.move(from, to); close()
        }
        if (m.queueIndex != pb.index.value) MenuItem(Icons.Rounded.RemoveCircleOutline, "Remove from queue") { pb.removeAt(m.queueIndex); close() }
    }
    MenuItem(Icons.Rounded.StopCircle, if (stopAfter == t.id) "Don't stop after this song" else "Stop after this song") {
        pb.stopAfter(if (stopAfter == t.id) null else t.id); close()
    }
    MenuItem(Icons.AutoMirrored.Rounded.PlaylistAdd, "Add to playlist") { ui.addToPlaylist = listOf(t); close() }
    if (m.playlistId != null) MenuItem(Icons.Rounded.Delete, "Remove from this playlist") {
        ui.app.sync.removeFromPlaylist(m.playlistId, t); close()
    }
    if (t.albumId != null && t.album.isNotBlank()) MenuItem(Icons.Rounded.Album, "Go to album") { close(); ui.album(t.albumId) }
    if (t.isRip && !t.ripGame.isNullOrBlank()) MenuItem(Icons.Rounded.SportsEsports, "Go to game") { close(); ui.game(t.ripGame) }
    else MenuItem(Icons.Rounded.Person, "Go to artist") { close(); ui.artist(t.albumArtist.takeIf { it != "Various Artists" } ?: t.artist) }
    MenuItem(Icons.Rounded.Folder, "Go to folder") { close(); ui.folder(t.relPath.substringBeforeLast('/', "")) }
    MenuItem(Icons.Rounded.Info, "Song info") { ui.info = t; close() }
}

@Composable
private fun SongsMenu(
    title: String, tracks: List<Track>?, artTrackId: Long?, close: () -> Unit,
    albumId: Long? = null, artist: String? = null, liked: Boolean = false, playlist: Playlist? = null,
) {
    val ui = LocalUi.current
    val pb = ui.playback
    val list by produceState(tracks, albumId, playlist?.id) {
        if (tracks == null) value = withContext(Dispatchers.IO) {
            when {
                albumId != null -> ui.library.albumTracks(albumId).first()
                playlist != null -> ui.library.playlistTracks(playlist.id).first()
                else -> null
            }
        }
    }
    Row(Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
        Art(artTrackId, Modifier.size(56.dp))
        Spacer(Modifier.width(14.dp))
        Column(Modifier.weight(1f)) {
            Text(title.ifBlank { "Songs" }, style = MaterialTheme.typography.titleMedium, maxLines = 2, overflow = TextOverflow.Ellipsis)
            list?.let { Text("${songs(it.size)} · ${formatTotal(it.sumOf { t -> t.durationMs })}", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant) }
        }
    }
    HorizontalDivider()
    val l = list ?: return
    if (l.isNotEmpty()) {
        MenuItem(Icons.Rounded.PlayArrow, "Play") { ui.play(l, 0, title); close() }
        MenuItem(Icons.Rounded.Shuffle, "Shuffle") { ui.shuffle(l, title); close() }
        MenuItem(Icons.Rounded.SkipNext, "Play next") { pb.playNext(l); close() }
        MenuItem(Icons.AutoMirrored.Rounded.QueueMusic, "Add to queue") { pb.addToQueue(l); close() }
        MenuItem(Icons.AutoMirrored.Rounded.PlaylistPlay, "Play in a new queue") { pb.play(l, 0, title, mode = TapMode.NewQueue); close() }
        MenuItem(Icons.AutoMirrored.Rounded.PlaylistAdd, "Add to playlist") { ui.addToPlaylist = l; close() }
    }
    if (playlist?.editable == true) {
        MenuItem(Icons.Rounded.Edit, "Rename") { ui.renaming = playlist; close() }
        MenuItem(Icons.Rounded.Delete, "Delete playlist") { ui.deleting = playlist; close() }
    }
    if (albumId != null) {
        val album = remember(albumId) { ui.library.album(albumId) }.collectAsState(null).value
        MenuItem(if (album?.liked ?: liked) Icons.Rounded.Favorite else Icons.Rounded.FavoriteBorder, if (album?.liked ?: liked) "Unlike album" else "Like album") {
            album?.let { ui.app.sync.setAlbumLiked(it, !it.liked) }; close()
        }
        MenuItem(Icons.Rounded.Album, "Go to album") { close(); ui.album(albumId) }
        if (artist != null) MenuItem(Icons.Rounded.Person, "Go to artist") { close(); ui.artist(artist) }
    }
}

/** Pick a static playlist (or make a new one) for the songs in [UiActions.addToPlaylist]. */
@Composable
fun AddToPlaylistDialog() {
    val ui = LocalUi.current
    val tracks = ui.addToPlaylist ?: return
    val playlists by rememberFlow("playlists", null) { ui.library.playlists() }
    var creating by remember { mutableStateOf(false) }
    val close = { ui.addToPlaylist = null }
    if (creating) {
        NewPlaylistDialog(onDismiss = { creating = false }) { name ->
            ui.app.sync.createPlaylist(name, tracks) {}
            close()
        }
        return
    }
    AlertDialog(
        onDismissRequest = close,
        title = { Text(if (tracks.size == 1) "Add to playlist" else "Add ${songs(tracks.size)} to playlist") },
        text = {
            LazyColumn {
                item { MenuItem(Icons.Rounded.Add, "New playlist…") { creating = true } }
                items(playlists.orEmpty().filter { it.editable }, key = { it.id }) { p ->
                    MenuItem(Icons.AutoMirrored.Rounded.QueueMusic, "${p.name}  (${p.itemCount})") {
                        ui.app.sync.addToPlaylist(p.id, tracks); close()
                    }
                }
            }
        },
        confirmButton = { TextButton(onClick = close) { Text("Cancel") } },
    )
}

/** Read-only details of a song: file, format, tags and listening stats. */
@Composable
fun SongInfoDialog() {
    val ui = LocalUi.current
    val t = ui.info ?: return
    val file = ui.library.fileOf(t)
    val fmt = DateFormat.getDateTimeInstance(DateFormat.MEDIUM, DateFormat.SHORT)
    val rows = buildList {
        add("Title" to t.title)
        add("Artist" to t.artist)
        if (t.album.isNotBlank()) add("Album" to t.album)
        add("Album artist" to t.albumArtist)
        t.trackNo?.let { add("Track" to (t.discNo?.let { d -> "$d-" } ?: "") + it) }
        t.year?.let { add("Year" to it.toString()) }
        t.genre?.let { add("Genre" to it) }
        t.composer?.let { add("Composer" to it) }
        if (t.isRip) {
            add("Rip" to t.hqRip)
            t.ripGame?.let { add("Game" to it) }
        }
        add("Length" to formatDuration(t.durationMs))
        add("Format" to listOfNotNull(
            t.codec?.uppercase(Locale.ROOT),
            t.bitrate?.takeIf { it > 0 }?.let { "${it / 1000} kbps" },
            t.sampleRate?.let { "%.1f kHz".format(it / 1000.0) },
            t.bitDepth?.let { "$it-bit" },
        ).joinToString(" · "))
        add("Size" to "%.1f MB".format(file.length() / 1_048_576.0))
        if (t.rating > 0) add("Rating" to "★".repeat(t.rating) + "☆".repeat(5 - t.rating))
        t.rgTrackGain?.let { add("ReplayGain" to "track %+.2f dB".format(it) + (t.rgAlbumGain?.let { a -> " · album %+.2f dB".format(a) } ?: "")) }
        add("Plays" to "${t.playCount}" + if (t.skipCount > 0) " (${t.skipCount} skips)" else "")
        t.lastPlayed?.let { add("Last played" to fmt.format(Date(it))) }
        add("Added" to fmt.format(Date(t.addedAt)))
        add("Lyrics" to when (t.lyricsKind) { 2 -> "Synced"; 1 -> "Plain"; else -> "None" })
        add("File" to t.relPath)
    }
    AlertDialog(
        onDismissRequest = { ui.info = null },
        title = { Text("Song info") },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState())) {
                for ((k, v) in rows) {
                    Text(k, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 8.dp))
                    Text(v, style = MaterialTheme.typography.bodyMedium, fontFamily = if (k == "File") FontFamily.Monospace else null)
                }
            }
        },
        confirmButton = { TextButton(onClick = { ui.info = null }) { Text("Close") } },
    )
}
