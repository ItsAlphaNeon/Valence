package app.valence.ui

import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.grid.LazyGridState
import androidx.compose.foundation.pager.PagerState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.QueueMusic
import androidx.compose.material.icons.rounded.Album
import androidx.compose.material.icons.rounded.Folder
import androidx.compose.material.icons.rounded.LibraryMusic
import androidx.compose.material.icons.rounded.Person
import androidx.compose.material.icons.rounded.PlayCircle
import androidx.compose.material.icons.rounded.SportsEsports
import androidx.compose.material.icons.rounded.Style
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Stable
import androidx.compose.runtime.State
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshots.SnapshotStateList
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.vector.ImageVector
import app.valence.ValenceApp
import app.valence.data.Album
import app.valence.data.Playlist
import app.valence.data.Track
import app.valence.playback.TapMode
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import kotlin.math.abs

/** Musicolet's tabs. Which ones show, and in what order, is a setting ("Arrange tabs"). */
enum class Tab(val key: String, val label: String, val icon: ImageVector) {
    Queues("queues", "Queues", Icons.AutoMirrored.Rounded.QueueMusic),
    Player("player", "Now playing", Icons.Rounded.PlayCircle),
    Folders("folders", "Folders", Icons.Rounded.Folder),
    Albums("albums", "Albums", Icons.Rounded.Album),
    Artists("artists", "Artists", Icons.Rounded.Person),
    Genres("genres", "Genres", Icons.Rounded.Style),
    Rips("rips", "SiivaGunner", Icons.Rounded.SportsEsports),
    Playlists("playlists", "Playlists", Icons.Rounded.LibraryMusic),
    ;

    companion object {
        fun parse(s: String): List<Tab> {
            val tabs = s.split(',').mapNotNull { k -> entries.firstOrNull { it.key == k.trim() } }.distinct()
            // The player can't be turned off; without it nothing could show what's playing.
            return if (Player in tabs) tabs else listOf(Player) + tabs
        }
    }
}

/** A page opened inside a tab (Musicolet keeps one back stack per tab). */
sealed interface Route {
    data class AlbumR(val id: Long) : Route
    /** [mode]: "album" (album artist), "track" (song artist) or "composer". */
    data class ArtistR(val name: String, val mode: String = "album") : Route
    data class GenreR(val name: String) : Route
    data class GameR(val name: String) : Route
    data class FolderR(val path: String) : Route
    data class PlaylistR(val id: String) : Route
    /** Built-in lists: an [app.valence.data.AutoList] name, "All", or "History". */
    data class AutoR(val name: String) : Route
}

/** Full-screen pages over the tabs. */
enum class Overlay { Search, Settings, Equalizer, TagEditor }

/** What a menu dialog is about. [context] is the list the item was in (for "play from here"). */
sealed interface MenuTarget {
    /** [queueIndex]/[queueId]: the song's place in a queue on the Queues page (or the playing one, from Now playing). */
    data class Song(
        val track: Track, val context: List<Track> = emptyList(), val label: String = "", val playlistId: String? = null,
        val queueIndex: Int? = null, val queueId: Long? = null,
    ) : MenuTarget
    data class AlbumMenu(val album: Album) : MenuTarget
    data class Songs(val title: String, val tracks: List<Track>) : MenuTarget
    /** [tracks] is null when the songs aren't loaded yet (a long-press in the Playlists tab). */
    data class PlaylistMenu(val playlist: Playlist, val tracks: List<Track>? = null) : MenuTarget
}

class Notice(val message: String, val action: String? = null, val onAction: (() -> Unit)? = null)

/** App-wide UI state and actions, provided once at the root. */
@Stable
class UiActions(val app: ValenceApp, val scope: CoroutineScope) {
    var menu by mutableStateOf<MenuTarget?>(null)
    var addToPlaylist by mutableStateOf<List<Track>?>(null)
    var info by mutableStateOf<Track?>(null)
    var renaming by mutableStateOf<Playlist?>(null)
    var deleting by mutableStateOf<Playlist?>(null)
    var sleepDialog by mutableStateOf(false)
    var castDialog by mutableStateOf(false)
    var speedDialog by mutableStateOf(false)
    var mainMenu by mutableStateOf(false)

    /** A short message at the bottom of the screen, with an action button (Undo) when [Notice.onAction] is set. */
    var notice by mutableStateOf<Notice?>(null)
    fun undoable(message: String, undo: (() -> Unit)?) { if (undo != null) notice = Notice(message, "Undo", undo) }

    /** Full-screen pages open over the tabs, topmost last (Settings → Equalizer). */
    val overlays = mutableStateListOf<Overlay>()
    fun show(o: Overlay) { overlays.remove(o); overlays.add(o); menu = null; mainMenu = false }

    /** The songs open in the tag editor. */
    var tagEditing by mutableStateOf<List<Track>>(emptyList())
        private set
    fun editTags(tracks: List<Track>) {
        if (tracks.isEmpty()) return
        tagEditing = tracks
        info = null
        show(Overlay.TagEditor)
    }
    fun closeTagEditor() {
        overlays.remove(Overlay.TagEditor)
        tagEditing = emptyList()
    }

    /** Set by the root once the tab list is known. */
    var tabs by mutableStateOf<List<Tab>>(emptyList())
    lateinit var pager: PagerState

    private val stacks = HashMap<Tab, SnapshotStateList<Route>>()
    fun stack(tab: Tab): SnapshotStateList<Route> = stacks.getOrPut(tab) { mutableStateListOf() }

    // Scroll positions survive a page leaving composition (pager neighbours come and go).
    private val lists = HashMap<String, LazyListState>()
    private val grids = HashMap<String, LazyGridState>()
    fun listState(key: String): LazyListState = lists.getOrPut(key) { LazyListState() }
    fun gridState(key: String): LazyGridState = grids.getOrPut(key) { LazyGridState() }
    fun forgetScroll(key: String) { lists.remove(key); grids.remove(key) }

    private val cache = object : LinkedHashMap<String, StateFlow<*>>(64, 0.75f, true) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, StateFlow<*>>?) = size > 64
    }

    /** Library queries shared across recompositions and tab switches, so lists come back instantly. */
    @Suppress("UNCHECKED_CAST")
    fun <T> cached(key: String, initial: T, create: () -> Flow<T>): StateFlow<T> =
        cache.getOrPut(key) { create().stateIn(app.scope, SharingStarted.WhileSubscribed(120_000), initial) } as StateFlow<T>

    val playback get() = app.playback
    val library get() = app.library

    val currentTab: Tab? get() = tabs.getOrNull(pager.currentPage)

    fun select(tab: Tab, animate: Boolean = true) {
        val i = tabs.indexOf(tab)
        if (i < 0) return
        overlays.clear()
        scope.launch {
            // Neighbouring tabs slide like Musicolet's; far ones jump, so the pages between aren't built.
            if (animate && abs(i - pager.currentPage) == 1) pager.animateScrollToPage(i) else pager.scrollToPage(i)
        }
    }

    fun openPlayer() = select(Tab.Player)

    /** Counts taps on a tab's button while it was already showing; pages without a back stack (Queues) reset on it. */
    val reselects = mutableStateMapOf<Tab, Int>()

    /**
     * A tap on a tab's button: goes to the tab, or, when it's already showing, back to its first
     * page (the albums list from an album, the playing queue from another queue).
     */
    fun tapTab(tab: Tab) {
        val i = tabs.indexOf(tab)
        if (i < 0) return
        if (overlays.isEmpty() && pager.currentPage == i && !pager.isScrollInProgress) {
            stack(tab).clear()
            reselects[tab] = (reselects[tab] ?: 0) + 1
            menu = null
        } else select(tab)
    }

    /** Opens [route] in the tab it belongs to (or the current one when that tab is turned off). */
    fun open(route: Route) {
        val home = when (route) {
            is Route.AlbumR -> Tab.Albums
            is Route.ArtistR -> Tab.Artists
            is Route.GenreR -> Tab.Genres
            is Route.GameR -> Tab.Rips
            is Route.FolderR -> Tab.Folders
            is Route.PlaylistR, is Route.AutoR -> Tab.Playlists
        }
        val cur = currentTab
        val tab = when {
            home in tabs -> home
            cur != null && cur != Tab.Player && cur != Tab.Queues -> cur
            else -> tabs.firstOrNull { it != Tab.Player && it != Tab.Queues } ?: return
        }
        val s = stack(tab)
        if (tab == Tab.Folders && route is Route.FolderR) {
            // The Folders tab's stack is the path itself, so back goes up one folder.
            s.clear()
            val parts = route.path.split('/').filter { it.isNotEmpty() }
            for (i in 1..parts.size) s.add(Route.FolderR(parts.take(i).joinToString("/")))
        } else if (s.lastOrNull() != route) {
            s.add(route)
        }
        menu = null
        select(tab)
    }

    fun album(id: Long?) { if (id != null) open(Route.AlbumR(id)) }
    fun artist(name: String, mode: String = "album") = open(Route.ArtistR(name, mode))
    fun genre(name: String) = open(Route.GenreR(name))
    fun game(name: String) = open(Route.GameR(name))
    fun folder(path: String) = open(Route.FolderR(path))
    fun playlist(id: String) = open(Route.PlaylistR(id))
    fun auto(name: String) = open(Route.AutoR(name))

    /** Back inside the current tab. False when there's nothing to go back to. */
    fun back(): Boolean {
        if (overlays.isNotEmpty()) { overlays.removeAt(overlays.lastIndex); return true }
        val tab = currentTab ?: return false
        val s = stack(tab)
        if (s.isEmpty()) return false
        s.removeAt(s.lastIndex)
        return true
    }

    /** After a tag edit emptied album [old]: its pages show [replacement] instead (or close, when there's none). */
    fun albumMoved(old: Long, replacement: Long?) {
        for (s in stacks.values) {
            for (i in s.indices.reversed()) {
                if (s[i] != Route.AlbumR(old)) continue
                if (replacement != null && s.getOrNull(i - 1) != Route.AlbumR(replacement)) s[i] = Route.AlbumR(replacement)
                else while (s.size > i) s.removeAt(s.lastIndex)
            }
        }
    }

    /** Leaves playlist [id]'s page wherever it's open (after a delete), or swaps in [replacement] (after a rename). */
    fun leavePlaylist(id: String, replacement: String? = null) {
        for (s in stacks.values) {
            val i = s.indexOfFirst { it is Route.PlaylistR && it.id == id }
            if (i < 0) continue
            if (replacement != null) s[i] = Route.PlaylistR(replacement) else while (s.size > i) s.removeAt(s.lastIndex)
        }
    }

    fun play(tracks: List<Track>, start: Int, label: String) = playback.play(tracks, start, label)
    fun shuffle(tracks: List<Track>, label: String) = playback.play(tracks, 0, label, mode = playback.tapMode().let { if (it == TapMode.Replace) it else TapMode.Named }, shuffle = true)
    fun songMenu(t: Track, context: List<Track> = emptyList(), label: String = "", playlistId: String? = null) { menu = MenuTarget.Song(t, context, label, playlistId) }
}

val LocalUi = staticCompositionLocalOf<UiActions> { error("No UiActions") }

/** A library query as Compose state, cached by [key] (so going back to a list is instant). */
@Composable
fun <T> rememberFlow(key: String, initial: T, create: () -> Flow<T>): State<T> {
    val ui = LocalUi.current
    val flow = remember(key) { ui.cached(key, initial, create) }
    return flow.collectAsState()
}
