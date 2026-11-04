package app.valence.ui.screens

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.PlaylistAdd
import androidx.compose.material.icons.automirrored.rounded.PlaylistPlay
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
import androidx.compose.material.icons.rounded.RemoveCircleOutline
import androidx.compose.material.icons.rounded.Shuffle
import androidx.compose.material.icons.rounded.SkipNext
import androidx.compose.material.icons.rounded.Speed
import androidx.compose.material.icons.rounded.SportsEsports
import androidx.compose.material.icons.rounded.StopCircle
import androidx.compose.material3.Checkbox
import androidx.compose.material3.Slider
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.valence.data.Playlist
import app.valence.data.Track
import app.valence.playback.TapMode
import app.valence.ui.LocalUi
import app.valence.ui.MenuTarget
import app.valence.ui.components.DialogButtons
import app.valence.ui.components.DialogItem
import app.valence.ui.components.DialogSeparator
import app.valence.ui.components.DialogTitle
import app.valence.ui.components.IconAction
import app.valence.ui.components.MDialog
import app.valence.ui.components.formatDuration
import app.valence.ui.components.songs
import app.valence.ui.rememberFlow
import app.valence.ui.theme.LocalPalette
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.withContext
import java.text.DateFormat
import java.util.Date
import java.util.Locale
import kotlin.math.roundToInt

/** The dialog behind every "•••" and long-press. */
@Composable
fun MenuHost() {
    val ui = LocalUi.current
    val target = ui.menu ?: return
    val close = { ui.menu = null }
    MDialog(close) {
        Column(Modifier.heightIn(max = 640.dp).verticalScroll(rememberScrollState())) {
            when (target) {
                is MenuTarget.Song -> SongMenu(target, close)
                is MenuTarget.AlbumMenu -> SongsMenu(target.album.title, null, close, albumId = target.album.id, artist = target.album.albumArtist, liked = target.album.liked)
                is MenuTarget.Songs -> SongsMenu(target.title, target.tracks, close)
                is MenuTarget.PlaylistMenu -> SongsMenu(target.playlist.name, target.tracks, close, playlist = target.playlist)
            }
        }
    }
}

@Composable
private fun SongMenu(m: MenuTarget.Song, close: () -> Unit) {
    val ui = LocalUi.current
    val pb = ui.playback
    val pal = LocalPalette.current
    val t = m.track
    val fresh by remember(t.id) { ui.library.watchTrack(t.id) }.collectAsState(t)
    val liked = fresh?.liked ?: t.liked
    val stopAfter by pb.stopAfterId.collectAsState()
    DialogTitle(t.title) {
        IconAction(
            if (liked) Icons.Rounded.Favorite else Icons.Rounded.FavoriteBorder, if (liked) "Remove from favorites" else "Add to favorites",
            { ui.app.sync.setTrackLiked(t, !liked) }, tint = if (liked) pal.accent else pal.text,
        )
    }
    DialogItem(Icons.Rounded.Info, "Song info", { ui.info = t; close() })
    DialogSeparator()
    if (m.queueIndex != null) {
        DialogItem(Icons.Rounded.SkipNext, "Play after current song", {
            val from = m.queueIndex
            val to = (pb.index.value + if (from > pb.index.value) 1 else 0).coerceAtMost(pb.queue.value.lastIndex)
            pb.move(from, to); close()
        }, enabled = m.queueIndex != pb.index.value)
        if (m.queueIndex != pb.index.value) DialogItem(Icons.Rounded.RemoveCircleOutline, "Remove from queue", { pb.removeAt(m.queueIndex); close() })
    } else {
        DialogItem(Icons.Rounded.SkipNext, "Play after current song", { pb.playNext(listOf(t)); close() })
        DialogItem(Icons.AutoMirrored.Rounded.QueueMusic, "Add to currently playing queue", { pb.addToQueue(listOf(t)); close() })
        DialogItem(Icons.AutoMirrored.Rounded.PlaylistPlay, "Play in a new queue", {
            pb.play(m.context.ifEmpty { listOf(t) }, m.context.indexOf(t).coerceAtLeast(0), m.label.ifEmpty { t.title }, mode = TapMode.NewQueue); close()
        })
    }
    DialogItem(Icons.AutoMirrored.Rounded.PlaylistAdd, "Add to playlists", { ui.addToPlaylist = listOf(t); close() })
    if (m.playlistId != null) DialogItem(Icons.Rounded.Delete, "Remove from this playlist", { ui.app.sync.removeFromPlaylist(m.playlistId, t); close() })
    DialogSeparator()
    if (t.albumId != null && t.album.isNotBlank()) DialogItem(Icons.Rounded.Album, "Go to album", { close(); ui.album(t.albumId) })
    if (t.isRip && !t.ripGame.isNullOrBlank()) DialogItem(Icons.Rounded.SportsEsports, "Go to game", { close(); ui.game(t.ripGame) })
    DialogItem(Icons.Rounded.Person, "Go to artist", { close(); ui.artist(t.albumArtist.takeIf { it.isNotBlank() && it != "Various Artists" } ?: t.artist) })
    DialogItem(Icons.Rounded.Folder, "Go to folder", { close(); ui.folder(t.relPath.substringBeforeLast('/', "")) })
    DialogSeparator()
    DialogItem(Icons.Rounded.StopCircle, if (stopAfter == t.id) "Don't stop after this song" else "Stop after this song", {
        pb.stopAfter(if (stopAfter == t.id) null else t.id); close()
    })
    DialogItem(Icons.Rounded.Speed, "Play speed", { ui.speedDialog = true; close() })
}

@Composable
private fun SongsMenu(
    title: String, tracks: List<Track>?, close: () -> Unit,
    albumId: Long? = null, artist: String? = null, liked: Boolean = false, playlist: Playlist? = null,
) {
    val ui = LocalUi.current
    val pb = ui.playback
    val pal = LocalPalette.current
    val list by produceState(tracks, albumId, playlist?.id) {
        if (tracks == null) value = withContext(Dispatchers.IO) {
            when {
                albumId != null -> ui.library.albumTracks(albumId).first()
                playlist != null -> ui.library.playlistTracks(playlist.id).first()
                else -> null
            }
        }
    }
    val album = if (albumId != null) remember(albumId) { ui.library.album(albumId) }.collectAsState(null).value else null
    val albumLiked = album?.liked ?: liked
    DialogTitle(title.ifBlank { "Songs" }, trailing = if (albumId != null) ({
        IconAction(
            if (albumLiked) Icons.Rounded.Favorite else Icons.Rounded.FavoriteBorder, if (albumLiked) "Remove album from favorites" else "Add album to favorites",
            { album?.let { ui.app.sync.setAlbumLiked(it, !it.liked) } }, tint = if (albumLiked) pal.accent else pal.text,
        )
    }) else null)
    val l = list
    if (l != null) Text(
        "${songs(l.size)} · ${formatDuration(l.sumOf { it.durationMs })}",
        Modifier.padding(start = 22.dp, bottom = 4.dp), style = TextStyle(fontSize = 14.sp), color = pal.text2,
    )
    DialogSeparator()
    if (l != null && l.isNotEmpty()) {
        DialogItem(Icons.Rounded.PlayArrow, "Play", { ui.play(l, 0, title); close() })
        DialogItem(Icons.Rounded.Shuffle, "Shuffle", { ui.shuffle(l, title); close() })
        DialogItem(Icons.Rounded.SkipNext, "Play after current song", { pb.playNext(l); close() })
        DialogItem(Icons.AutoMirrored.Rounded.QueueMusic, "Add to currently playing queue", { pb.addToQueue(l); close() })
        DialogItem(Icons.AutoMirrored.Rounded.PlaylistPlay, "Play in a new queue", { pb.play(l, 0, title, mode = TapMode.NewQueue); close() })
        DialogItem(Icons.AutoMirrored.Rounded.PlaylistAdd, "Add to playlists", { ui.addToPlaylist = l; close() })
    }
    if (playlist != null) {
        DialogSeparator()
        DialogItem(Icons.Rounded.Edit, "Rename", { ui.renaming = playlist; close() })
        DialogItem(Icons.Rounded.Delete, "Delete playlist", { ui.deleting = playlist; close() })
    }
    if (albumId != null) {
        DialogSeparator()
        DialogItem(Icons.Rounded.Album, "Go to album", { close(); ui.album(albumId) })
        if (artist != null) DialogItem(Icons.Rounded.Person, "Go to artist", { close(); ui.artist(artist) })
    }
}

/** Pick a playlist on this phone (or make a new one) for the songs in [app.valence.ui.UiActions.addToPlaylist]. */
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
    MDialog(close) {
        Column(Modifier.heightIn(max = 600.dp).verticalScroll(rememberScrollState())) {
            DialogTitle(if (tracks.size == 1) "Add to playlists" else "Add ${songs(tracks.size)} to playlists", icon = Icons.AutoMirrored.Rounded.PlaylistAdd)
            DialogItem(Icons.Rounded.Add, "New playlist", { creating = true })
            DialogSeparator()
            for (p in playlists.orEmpty().filter { it.editable }) {
                DialogItem(Icons.AutoMirrored.Rounded.QueueMusic, p.name, { ui.app.sync.addToPlaylist(p.id, tracks); close() }, trailing = {
                    Text("${p.itemCount}", style = TextStyle(fontSize = 14.sp), color = LocalPalette.current.text2)
                })
            }
            DialogButtons("Cancel" to close)
        }
    }
}

/** Read-only details of a song: file, format, tags and listening stats. */
@Composable
fun SongInfoDialog() {
    val ui = LocalUi.current
    val pal = LocalPalette.current
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
    MDialog({ ui.info = null }) {
        Column {
            DialogTitle("Song info", icon = Icons.Rounded.Info)
            Column(Modifier.heightIn(max = 520.dp).verticalScroll(rememberScrollState()).padding(horizontal = 22.dp)) {
                for ((k, v) in rows) {
                    Text(k, style = TextStyle(fontSize = 12.sp), color = pal.accent, modifier = Modifier.padding(top = 8.dp))
                    Text(v, style = TextStyle(fontSize = 15.sp, fontFamily = if (k == "File") FontFamily.Monospace else null), color = pal.text)
                }
            }
            DialogButtons("Close" to { ui.info = null })
        }
    }
}

@Composable
fun NewPlaylistDialog(onDismiss: () -> Unit, onCreate: (String) -> Unit) =
    TextDialog("New playlist", "", "Create", "Saved as an .m3u8 in your Playlists folder, so it syncs to your other devices.", onDismiss, onCreate)

/** Rename and delete, for the playlist in [app.valence.ui.UiActions.renaming] / [app.valence.ui.UiActions.deleting]. */
@Composable
fun PlaylistDialogs() {
    val ui = LocalUi.current
    val pal = LocalPalette.current
    ui.renaming?.let { p ->
        TextDialog("Rename playlist", p.name, "Rename", onDismiss = { ui.renaming = null }) { name ->
            ui.renaming = null
            ui.app.sync.renamePlaylist(p.id, name) { newId -> if (newId != null && newId != p.id) ui.leavePlaylist(p.id, newId) }
        }
    }
    ui.deleting?.let { p ->
        MDialog({ ui.deleting = null }) {
            Column {
                DialogTitle("Delete “${p.name}”?")
                Text(
                    "The playlist is deleted on this phone and, through Syncthing, on your other devices. The songs stay in your library.",
                    Modifier.padding(horizontal = 22.dp), style = TextStyle(fontSize = 15.sp), color = pal.text2,
                )
                DialogButtons("Cancel" to { ui.deleting = null }, "Delete" to {
                    ui.deleting = null
                    ui.app.sync.deletePlaylist(p.id) { ui.leavePlaylist(p.id) }
                })
            }
        }
    }
}

@Composable
fun SleepDialog(onDismiss: () -> Unit) {
    val pb = LocalUi.current.playback
    val pal = LocalPalette.current
    val sleepAt by pb.sleepAt.collectAsState()
    val songsLeft by pb.sleepSongs.collectAsState()
    var minutes by remember { mutableFloatStateOf(30f) }
    var finishSong by remember { mutableStateOf(false) }
    val on = sleepAt != null || songsLeft > 0
    MDialog(onDismiss) {
        Column {
            DialogTitle("Sleep timer")
            Column(Modifier.padding(horizontal = 22.dp)) {
                Text(
                    when {
                        sleepAt != null -> "Playback pauses at ${DateFormat.getTimeInstance(DateFormat.SHORT).format(Date(sleepAt!!))}."
                        songsLeft == 1 -> "Playback pauses at the end of this song."
                        songsLeft > 1 -> "Playback pauses after $songsLeft more songs."
                        else -> "Fades out and pauses after a while."
                    },
                    style = TextStyle(fontSize = 15.sp), color = pal.text2,
                )
                Spacer(Modifier.size(12.dp))
                Text("After ${minutes.roundToInt()} minutes", style = TextStyle(fontSize = 17.sp), color = pal.text)
                Slider(minutes, { minutes = it }, valueRange = 5f..120f, steps = 22)
                Row(Modifier.clickable { finishSong = !finishSong }, verticalAlignment = Alignment.CenterVertically) {
                    Checkbox(finishSong, { finishSong = it })
                    Text("Let the last song finish", style = TextStyle(fontSize = 15.sp), color = pal.text)
                }
                Spacer(Modifier.size(6.dp))
                Text("After songs", style = TextStyle(fontSize = 17.sp), color = pal.text)
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.padding(vertical = 8.dp)) {
                    app.valence.ui.components.Chip("This one", false, { pb.sleepAfterCurrent(); onDismiss() })
                    for (n in listOf(3, 5, 10)) app.valence.ui.components.Chip("$n", false, { pb.sleepAfterSongs(n); onDismiss() })
                }
            }
            if (on) DialogButtons("Turn off" to { pb.cancelSleep(); onDismiss() }, "Start" to { pb.sleepIn(minutes.roundToInt(), finishSong); onDismiss() })
            else DialogButtons("Cancel" to onDismiss, "Start" to { pb.sleepIn(minutes.roundToInt(), finishSong); onDismiss() })
        }
    }
}

@Composable
fun SpeedDialog(onDismiss: () -> Unit) {
    val pb = LocalUi.current.playback
    val pal = LocalPalette.current
    val speed by pb.speed.collectAsState()
    var value by remember { mutableFloatStateOf(speed) }
    MDialog(onDismiss) {
        Column {
            DialogTitle("Play speed")
            Column(Modifier.padding(horizontal = 22.dp)) {
                Text("${"%.2f".format(value)}×", style = TextStyle(fontSize = 17.sp), color = pal.text)
                Slider(value, { value = (it * 20).roundToInt() / 20f; pb.setSpeed(value) }, valueRange = 0.5f..2f)
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.fillMaxWidth().padding(vertical = 6.dp)) {
                    for (s in listOf(0.75f, 1f, 1.25f, 1.5f)) app.valence.ui.components.Chip("$s×", value == s, { value = s; pb.setSpeed(s) })
                }
            }
            DialogButtons("Done" to onDismiss)
        }
    }
}
