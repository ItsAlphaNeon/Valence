package app.valence.ui

import android.net.Uri
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Stable
import androidx.compose.runtime.State
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.navigation.NavHostController
import app.valence.ValenceApp
import app.valence.data.Album
import app.valence.data.Playlist
import app.valence.data.Track
import app.valence.playback.TapMode
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.stateIn

/** What a menu sheet is about. [context] is the list the item was in (for "play from here"). */
sealed interface MenuTarget {
    data class Song(val track: Track, val context: List<Track> = emptyList(), val label: String = "", val playlistId: String? = null, val queueIndex: Int? = null) : MenuTarget
    data class AlbumMenu(val album: Album) : MenuTarget
    data class Songs(val title: String, val tracks: List<Track>) : MenuTarget
    /** [tracks] is null when the songs aren't loaded yet (a long-press in the Playlists tab). */
    data class PlaylistMenu(val playlist: Playlist, val tracks: List<Track>? = null) : MenuTarget
}

/** App-wide UI hooks, provided once at the root. */
@Stable
class UiActions(val app: ValenceApp, val nav: NavHostController) {
    var menu by mutableStateOf<MenuTarget?>(null)
    var playerOpen by mutableStateOf(false)
    var queueOpen by mutableStateOf(false)
    var addToPlaylist by mutableStateOf<List<Track>?>(null)
    var info by mutableStateOf<Track?>(null)
    var renaming by mutableStateOf<Playlist?>(null)
    var deleting by mutableStateOf<Playlist?>(null)

    private val cache = object : LinkedHashMap<String, StateFlow<*>>(64, 0.75f, true) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, StateFlow<*>>?) = size > 48
    }

    /** Library queries shared across recompositions and back navigation, so lists come back instantly. */
    @Suppress("UNCHECKED_CAST")
    fun <T> cached(key: String, initial: T, create: () -> Flow<T>): StateFlow<T> =
        cache.getOrPut(key) { create().stateIn(app.scope, SharingStarted.WhileSubscribed(120_000), initial) } as StateFlow<T>

    val playback get() = app.playback
    val library get() = app.library

    fun go(route: String) {
        playerOpen = false
        queueOpen = false
        nav.navigate(route) { launchSingleTop = true }
    }

    fun album(id: Long?) { if (id != null) go("album/$id") }
    fun artist(name: String) = go("artist/${Uri.encode(name)}")
    fun genre(name: String) = go("genre/${Uri.encode(name)}")
    fun game(name: String) = go("game/${Uri.encode(name)}")
    fun folder(path: String) = go("folder/${Uri.encode(path.ifEmpty { "/" })}")
    fun playlist(id: String) = go("playlist/${Uri.encode(id)}")
    fun auto(name: String) = go("auto/$name")

    /** Leaves playlist [id]'s page if it's the one showing (after a delete), or swaps in [replacement] (after a rename). */
    fun leavePlaylist(id: String, replacement: String? = null) {
        val entry = nav.currentBackStackEntry ?: return
        if (entry.destination.route != "playlist/{id}" || entry.arguments?.getString("id") != id) return
        nav.popBackStack()
        if (replacement != null) playlist(replacement)
    }

    fun play(tracks: List<Track>, start: Int, label: String) = playback.play(tracks, start, label)
    fun shuffle(tracks: List<Track>, label: String) = playback.play(tracks, 0, label, mode = playback.tapMode().let { if (it == TapMode.Replace) it else TapMode.Named }, shuffle = true)
    fun songMenu(t: Track, context: List<Track> = emptyList(), label: String = "", playlistId: String? = null) { menu = MenuTarget.Song(t, context, label, playlistId) }
}

val LocalUi = staticCompositionLocalOf<UiActions> { error("No UiActions") }

/** A library query as Compose state, cached by [key] (so going back to a list keeps its scroll position). */
@Composable
fun <T> rememberFlow(key: String, initial: T, create: () -> Flow<T>): State<T> {
    val ui = LocalUi.current
    val flow = remember(key) { ui.cached(key, initial, create) }
    return flow.collectAsState()
}
