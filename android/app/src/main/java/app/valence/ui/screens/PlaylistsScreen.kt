package app.valence.ui.screens

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.QueueMusic
import androidx.compose.material.icons.rounded.Add
import androidx.compose.material.icons.rounded.AutoAwesome
import androidx.compose.material.icons.rounded.Favorite
import androidx.compose.material.icons.rounded.History
import androidx.compose.material.icons.rounded.LibraryAdd
import androidx.compose.material.icons.rounded.Replay
import androidx.compose.material.icons.rounded.Sync
import androidx.compose.material.icons.automirrored.rounded.TrendingUp
import androidx.compose.material.icons.rounded.VisibilityOff
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ExtendedFloatingActionButton
import androidx.compose.material3.Icon
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.unit.dp
import app.valence.data.AutoList
import app.valence.ui.LocalUi
import app.valence.ui.MenuTarget
import app.valence.ui.components.ListRow
import app.valence.ui.components.SectionTitle
import app.valence.ui.components.songs
import app.valence.ui.rememberFlow

private val AUTO_ICONS: Map<AutoList, ImageVector> = mapOf(
    AutoList.Liked to Icons.Rounded.Favorite,
    AutoList.RecentlyAdded to Icons.Rounded.LibraryAdd,
    AutoList.MostPlayed to Icons.AutoMirrored.Rounded.TrendingUp,
    AutoList.RecentlyPlayed to Icons.Rounded.Replay,
    AutoList.NeverPlayed to Icons.Rounded.VisibilityOff,
)

@Composable
fun PlaylistsScreen(bottomPadding: PaddingValues) {
    val ui = LocalUi.current
    val playlists by rememberFlow("playlists", null) { ui.library.playlists() }
    var creating by remember { mutableStateOf(false) }
    Box(Modifier.fillMaxSize()) {
        Column(Modifier.fillMaxSize()) {
            SectionHeader("Playlists")
            LazyColumn(contentPadding = PaddingValues(bottom = bottomPadding.calculateBottomPadding() + 80.dp)) {
                item { SectionTitle("Made for you") }
                items(AutoList.entries, key = { "a:" + it.name }) { a ->
                    ListRow(a.title, null, onClick = { ui.auto(a.name) }, icon = AUTO_ICONS.getValue(a))
                }
                item(key = "a:history") { ListRow("History", "Every play, from all your devices", onClick = { ui.auto("History") }, icon = Icons.Rounded.History) }
                val list = playlists.orEmpty()
                if (list.isNotEmpty()) item { SectionTitle("Your playlists") }
                items(list, key = { "p:" + it.id }) { p ->
                    ListRow(
                        p.name,
                        when (p.kind) {
                            "smart" -> "Smart playlist"
                            "mirror" -> "${songs(p.itemCount)} · mirrored"
                            else -> songs(p.itemCount)
                        },
                        onClick = { ui.playlist(p.id) },
                        onLongClick = { ui.menu = MenuTarget.PlaylistMenu(p) },
                        artTrackId = p.artTrackId,
                        icon = when (p.kind) { "smart" -> Icons.Rounded.AutoAwesome; "mirror" -> Icons.Rounded.Sync; else -> Icons.AutoMirrored.Rounded.QueueMusic },
                    )
                }
            }
        }
        ExtendedFloatingActionButton(
            onClick = { creating = true },
            icon = { Icon(Icons.Rounded.Add, null) },
            text = { Text("New playlist") },
            modifier = Modifier.align(Alignment.BottomEnd).padding(end = 16.dp, bottom = bottomPadding.calculateBottomPadding() + 16.dp),
        )
    }
    if (creating) NewPlaylistDialog(onDismiss = { creating = false }) { name ->
        creating = false
        ui.app.sync.createPlaylist(name, emptyList()) { id -> if (id != null) ui.playlist(id) }
    }
}

@Composable
fun NewPlaylistDialog(onDismiss: () -> Unit, onCreate: (String) -> Unit) =
    PlaylistNameDialog("New playlist", "Create", "", "Saved as an .m3u8 in your Playlists folder, so it syncs to your other devices.", onDismiss, onCreate)

@Composable
private fun PlaylistNameDialog(title: String, action: String, initial: String, note: String?, onDismiss: () -> Unit, onDone: (String) -> Unit) {
    var name by remember { mutableStateOf(initial) }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(title) },
        text = {
            Column {
                if (note != null) Text(note)
                OutlinedTextField(name, { name = it }, singleLine = true, label = { Text("Name") }, modifier = Modifier.padding(top = 12.dp))
            }
        },
        confirmButton = { TextButton(onClick = { onDone(name.trim()) }, enabled = name.isNotBlank()) { Text(action) } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}

/** Rename and delete, for the playlist in [app.valence.ui.UiActions.renaming] / [app.valence.ui.UiActions.deleting]. */
@Composable
fun PlaylistDialogs() {
    val ui = LocalUi.current
    ui.renaming?.let { p ->
        PlaylistNameDialog("Rename playlist", "Rename", p.name, null, onDismiss = { ui.renaming = null }) { name ->
            ui.renaming = null
            ui.app.sync.renamePlaylist(p.id, name) { newId -> if (newId != null && newId != p.id) ui.leavePlaylist(p.id, newId) }
        }
    }
    ui.deleting?.let { p ->
        AlertDialog(
            onDismissRequest = { ui.deleting = null },
            title = { Text("Delete \u201c${p.name}\u201d?") },
            text = { Text("The playlist is deleted on this phone and, through Syncthing, on your other devices. The songs stay in your library.") },
            confirmButton = {
                TextButton(onClick = {
                    ui.deleting = null
                    ui.app.sync.deletePlaylist(p.id) { ui.leavePlaylist(p.id) }
                }) { Text("Delete") }
            },
            dismissButton = { TextButton(onClick = { ui.deleting = null }) { Text("Cancel") } },
        )
    }
}
