package app.valence.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.runtime.toMutableStateList
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.zIndex
import app.valence.ui.components.DragHandle
import app.valence.ui.components.reorderHandle
import app.valence.ui.components.rememberReorderState
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.QueueMusic
import androidx.compose.material.icons.rounded.Close
import androidx.compose.material.icons.rounded.FavoriteBorder
import androidx.compose.material.icons.rounded.History
import androidx.compose.material.icons.rounded.Search
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.valence.data.AutoList
import app.valence.data.Collection
import app.valence.data.Scanner
import app.valence.data.Track
import app.valence.ui.LocalUi
import app.valence.ui.MenuTarget
import app.valence.ui.components.CountLine
import app.valence.ui.components.EmptyState
import app.valence.ui.components.FastScroller
import app.valence.ui.components.HDivider
import app.valence.ui.components.IconAction
import app.valence.ui.components.ListActions
import app.valence.ui.components.ScrollStrip
import app.valence.ui.components.SongRow
import app.valence.ui.components.SortDialog
import app.valence.ui.components.SortOption
import app.valence.ui.components.TopBar
import app.valence.ui.components.formatDuration
import app.valence.ui.components.indexLetter
import app.valence.ui.components.line2
import app.valence.ui.components.line3
import app.valence.ui.components.songs
import app.valence.ui.rememberFlow
import app.valence.ui.theme.LocalPalette
import java.text.DateFormat
import java.util.Date

val DETAIL_SORTS = listOf(SortOption("default", "Default order")) + SONG_SORTS

/** Sorts a page's songs on the phone (lists that aren't sorted by the database). */
fun sortTracks(list: List<Track>, key: String): List<Track> {
    fun by(f: (Track) -> String) = list.map { it to Scanner.fold(f(it)) }.sortedBy { it.second }.map { it.first }
    return when (key) {
        "title" -> by { it.title }
        "artist" -> by { it.artist + "\u0000" + it.album + "\u0000" + "%03d%04d".format(it.discNo ?: 1, it.trackNo ?: 9999) }
        "album" -> by { it.album + "\u0000" + "%03d%04d".format(it.discNo ?: 1, it.trackNo ?: 9999) }
        "year" -> list.sortedByDescending { it.year ?: -1 }
        "added" -> list.sortedByDescending { it.addedAt }
        "plays" -> list.sortedByDescending { it.playCount }
        "duration" -> list.sortedByDescending { it.durationMs }
        "game" -> by { (it.ripGame ?: "￿") + "\u0000" + it.title }
        else -> list
    }
}

fun sortLabel(t: Track, key: String): String = when (key) {
    "title" -> indexLetter(t.title)
    "artist" -> indexLetter(t.artist)
    "album" -> indexLetter(t.album)
    "year" -> t.year?.toString() ?: ""
    "game" -> indexLetter(t.ripGame ?: "")
    else -> ""
}

/**
 * The songs of a page, with Musicolet's scroll bar. [header] items sit above the songs (and scroll
 * with them); [headerItems] says how many there are, for the scroll bar's labels.
 */
@Composable
fun SongList(
    tracks: List<Track>,
    playLabel: String,
    stateKey: String,
    label: (Track) -> String = { "" },
    header: (LazyListScope.() -> Unit)? = null,
    headerItems: Int = 0,
    line2: (Track) -> String = { it.line2() },
    line3: ((Track) -> String)? = { it.line3() },
    trailing: ((Track) -> String)? = null,
    playlistId: String? = null,
    onReorder: ((List<Track>) -> Unit)? = null,
) {
    val ui = LocalUi.current
    val pal = LocalPalette.current
    val current by ui.playback.current.collectAsState()
    val playingId = current?.id
    // While a row is dragged the list is reordered here; the new order is saved when it's dropped.
    val local = remember(tracks) { tracks.toMutableStateList() }
    val list: List<Track> = if (onReorder != null) local else tracks
    // Keys survive moves: a song's id plus which copy of it this is.
    val keys = remember(list.toList()) {
        val seen = HashMap<Long, Int>()
        list.map { t -> val n = (seen[t.id] ?: 0) + 1; seen[t.id] = n; "${t.id}#$n" }
    }
    Box(Modifier.fillMaxSize()) {
        val state = ui.listState(stateKey)
        val reorder = rememberReorderState(state, onEnd = { onReorder?.invoke(local.toList()) }) { from, to ->
            val a = from - headerItems
            val b = to - headerItems
            if (a in local.indices && b in local.indices) local.add(b, local.removeAt(a))
        }
        LazyColumn(state = state, contentPadding = PaddingValues(bottom = 8.dp)) {
            header?.invoke(this)
            itemsIndexed(list, key = { i, _ -> keys.getOrElse(i) { "x$i" } }, contentType = { _, _ -> "song" }) { i, t ->
                val dragging = onReorder != null && reorder.dragging == i + headerItems
                SongRow(
                    t,
                    onClick = { ui.play(list.toList(), i, playLabel) },
                    onMenu = { ui.menu = MenuTarget.Song(t, list.toList(), playLabel, playlistId) },
                    modifier = if (onReorder == null) Modifier else Modifier
                        .zIndex(if (dragging) 1f else 0f)
                        .graphicsLayer { translationY = if (dragging) reorder.offset else 0f }
                        .then(if (dragging) Modifier.shadow(8.dp).background(pal.bar) else Modifier),
                    playing = t.id == playingId,
                    line2 = line2(t),
                    line3 = line3?.invoke(t),
                    trailingText = trailing?.invoke(t) ?: formatDuration(t.durationMs),
                    leading = if (onReorder == null) null else ({ DragHandle(Modifier.reorderHandle(reorder) { i + headerItems }) }),
                )
            }
        }
        FastScroller(state) { i -> list.getOrNull(i - headerItems)?.let(label) ?: "" }
    }
}

/** "Search in this list…" at the bottom of a song page; filters it in place. */
@Composable
fun FilterBar(filter: String, onFilter: (String) -> Unit, hint: String = "Search in this list…") {
    val pal = LocalPalette.current
    var editing by remember { mutableStateOf(filter.isNotEmpty()) }
    Column(Modifier.fillMaxWidth()) {
        HDivider()
        Row(Modifier.fillMaxWidth().height(48.dp).clickable(enabled = !editing) { editing = true }, verticalAlignment = Alignment.CenterVertically) {
            Spacer(Modifier.width(16.dp))
            Icon(Icons.Rounded.Search, null, Modifier.size(22.dp), tint = if (editing) pal.accent else pal.text2)
            Spacer(Modifier.width(16.dp))
            if (!editing) Text(hint, style = TextStyle(fontSize = 16.sp), color = pal.text2, modifier = Modifier.weight(1f))
            else {
                val focus = remember { FocusRequester() }
                LaunchedEffect(Unit) { focus.requestFocus() }
                Box(Modifier.weight(1f)) {
                    if (filter.isEmpty()) Text(hint, style = TextStyle(fontSize = 16.sp), color = pal.text3)
                    BasicTextField(
                        filter, onFilter, singleLine = true,
                        textStyle = TextStyle(fontSize = 16.sp, color = pal.text), cursorBrush = SolidColor(pal.accent),
                        keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
                        modifier = Modifier.fillMaxWidth().focusRequester(focus),
                    )
                }
                IconAction(Icons.Rounded.Close, "Close", { onFilter(""); editing = false }, tint = pal.text2)
            }
        }
    }
}

/**
 * A page of songs as Musicolet lays it out: title bar, then (scrolling with the list) any
 * [extraHeader], the song count and length, a divider, shuffle · sort · options, and the songs.
 */
@Composable
fun SongListPage(
    title: String,
    onBack: (() -> Unit)?,
    tracks: List<Track>?,
    playLabel: String,
    stateKey: String,
    menu: MenuTarget? = null,
    sort: String? = null,
    onSort: ((String) -> Unit)? = null,
    sortOptions: List<SortOption> = DETAIL_SORTS,
    extraHeader: (LazyListScope.() -> Unit)? = null,
    extraHeaderCount: Int = 0,
    line2: (Track) -> String = { it.line2() },
    line3: ((Track) -> String)? = { it.line3() },
    trailing: ((Track) -> String)? = null,
    playlistId: String? = null,
    countNoun: (Int) -> String = { songs(it) },
    onReorder: ((List<Track>) -> Unit)? = null,
    empty: @Composable () -> Unit = { EmptyState(Icons.AutoMirrored.Rounded.QueueMusic, "No songs") },
) {
    val ui = LocalUi.current
    var filter by rememberSaveable { mutableStateOf("") }
    var sorting by remember { mutableStateOf(false) }
    Column(Modifier.fillMaxSize()) {
        TopBar(title, onBack)
        if (tracks == null) return@Column
        val shown = remember(tracks, filter) {
            if (filter.isBlank()) tracks else tracks.filter { matches(it.title + " " + it.artist + " " + it.album + " " + (it.ripGame ?: ""), filter) }
        }
        Box(Modifier.weight(1f)) {
            if (tracks.isEmpty()) empty()
            else {
                SongList(
                    shown, playLabel, stateKey,
                    label = { t -> sortLabel(t, sort ?: "") },
                    header = {
                        extraHeader?.invoke(this)
                        item(key = "h:count", contentType = "h") { CountLine(tracks.size, tracks.sumOf { it.durationMs }, Modifier.padding(start = 16.dp, top = 4.dp, bottom = 10.dp), countNoun) }
                        item(key = "h:div", contentType = "h") { HDivider() }
                        item(key = "h:actions", contentType = "h") {
                            ListActions(
                                onShuffle = { ui.shuffle(shown, playLabel) },
                                onMenu = { ui.menu = menu ?: MenuTarget.Songs(playLabel, shown) },
                                onSort = if (onSort != null) ({ sorting = true }) else null,
                            )
                        }
                    },
                    headerItems = extraHeaderCount + 3,
                    line2 = line2, line3 = line3, trailing = trailing, playlistId = playlistId,
                    onReorder = if (filter.isBlank()) onReorder else null,
                )
            }
        }
        if (tracks.size > 8) FilterBar(filter, { filter = it })
    }
    if (sorting && onSort != null) SortDialog("Sort listed songs by…", sortOptions, sort ?: "default", onSort) { sorting = false }
}

// ---- Pages ---------------------------------------------------------------------------------------

@Composable
fun AlbumPage(id: Long, onBack: () -> Unit) {
    val ui = LocalUi.current
    val album by rememberFlow("album:$id", null) { ui.library.album(id) }
    val tracks by rememberFlow("albumTracks:$id", null) { ui.library.albumTracks(id) }
    var sort by rememberSaveable { mutableStateOf("default") }
    var only by rememberSaveable { mutableStateOf<String?>(null) }
    val a = album
    val list = tracks
    val artists = remember(list) { list.orEmpty().map { it.artist }.filter { it.isNotBlank() }.distinct() }
    val shown = remember(list, sort, only) { list?.let { l -> sortTracks(if (only == null) l else l.filter { it.artist == only }, sort) } }
    SongListPage(
        title = a?.title ?: "", onBack = onBack, tracks = shown, playLabel = a?.title ?: "", stateKey = "album:$id",
        menu = a?.let { MenuTarget.AlbumMenu(it) }, sort = sort, onSort = { sort = it },
        extraHeader = {
            if (artists.isNotEmpty()) item(key = "h:artists", contentType = "h") {
                SubCardRow("Artists", "${if (only == null) artists.size else 1}/${artists.size} artists") {
                    items(artists, key = { it }) { n ->
                        SubCard(n, only == n, onClick = { only = if (only == n) null else n }, onLongClick = { ui.artist(n, "track") })
                    }
                }
            }
        },
        extraHeaderCount = if (artists.isNotEmpty()) 1 else 0,
        line2 = { t -> if (t.isRip) t.ripGame ?: t.artist else t.artist },
        line3 = null,
    )
}

@Composable
fun ArtistPage(name: String, mode: String, onBack: () -> Unit) {
    val ui = LocalUi.current
    val tracks by rememberFlow("artistTracks:$mode:$name", null) { ui.library.artistTracksBy(name, mode) }
    var sort by rememberSaveable { mutableStateOf("default") }
    var only by rememberSaveable { mutableStateOf<Long?>(null) }
    val list = tracks
    val albums = remember(list) {
        list.orEmpty().filter { it.albumId != null }.groupBy { it.albumId!! }.map { (id, ts) -> Triple(id, ts.first().album, ts.firstOrNull { it.hasArt }?.id) }
    }
    val shown = remember(list, sort, only) { list?.let { l -> sortTracks(if (only == null) l else l.filter { it.albumId == only }, sort) } }
    SongListPage(
        title = name, onBack = onBack, tracks = shown, playLabel = name, stateKey = "artist:$mode:$name",
        sort = sort, onSort = { sort = it },
        extraHeader = {
            if (albums.isNotEmpty()) item(key = "h:albums", contentType = "h") {
                SubCardRow("Albums", "${if (only == null) albums.size else 1}/${albums.size} albums") {
                    items(albums, key = { it.first }) { (id, title, art) ->
                        SubCard(title, only == id, onClick = { only = if (only == id) null else id }, onLongClick = { ui.album(id) }, artTrackId = art, showArt = true)
                    }
                }
            }
        },
        extraHeaderCount = if (albums.isNotEmpty()) 1 else 0,
        line2 = { t -> t.album.ifBlank { t.artist } },
        line3 = null,
    )
}

@Composable
fun GenrePage(name: String, onBack: () -> Unit) {
    val ui = LocalUi.current
    val tracks by rememberFlow("genre:$name", null) { ui.library.genreTracks(name, Collection.All) }
    var sort by rememberSaveable { mutableStateOf("default") }
    val shown = remember(tracks, sort) { tracks?.let { sortTracks(it, sort) } }
    SongListPage(name, onBack, shown, name, "genre:$name", sort = sort, onSort = { sort = it })
}

@Composable
fun GamePage(name: String, onBack: () -> Unit) {
    val ui = LocalUi.current
    val tracks by rememberFlow("game:$name", null) { ui.library.gameTracks(name) }
    var sort by rememberSaveable { mutableStateOf("default") }
    val shown = remember(tracks, sort) { tracks?.let { sortTracks(it, sort) } }
    SongListPage(
        name, onBack, shown, name, "game:$name", sort = sort, onSort = { sort = it },
        line2 = { t -> t.album.ifBlank { t.artist } }, line3 = null,
        countNoun = { if (it == 1) "1 rip" else "$it rips" },
    )
}

@Composable
fun PlaylistPage(id: String, onBack: () -> Unit) {
    val ui = LocalUi.current
    val playlist by rememberFlow("playlist:$id", null) { ui.library.playlist(id) }
    val tracks by rememberFlow("playlistTracks:$id", null) { ui.library.playlistTracks(id) }
    var sort by rememberSaveable { mutableStateOf("default") }
    val p = playlist
    val shown = remember(tracks, sort) { tracks?.let { sortTracks(it, sort) } }
    SongListPage(
        p?.name ?: "", onBack, shown, p?.name ?: "", "playlist:$id",
        menu = p?.let { MenuTarget.PlaylistMenu(it, tracks.orEmpty()) },
        sort = sort, onSort = { sort = it },
        playlistId = if (p?.editable == true) id else null,
        // Hold a handle to reorder, as in Musicolet (in the playlist's own order only).
        onReorder = if (p?.editable == true && sort == "default") ({ l -> ui.app.sync.setPlaylistOrder(id, l.map { it.relPath }) }) else null,
        empty = { EmptyState(Icons.AutoMirrored.Rounded.QueueMusic, "Empty playlist", if (p?.editable == true) "Add songs with “Add to playlists” in any song's options." else null) },
    )
}

@Composable
fun AutoPage(name: String, onBack: () -> Unit) {
    val ui = LocalUi.current
    when (name) {
        "History" -> return HistoryPage(onBack)
        "All" -> return AllSongsPage(onBack)
    }
    val list = runCatching { AutoList.valueOf(name) }.getOrNull() ?: return
    val tracks by rememberFlow("auto:$name", null) { ui.library.autoList(list, Collection.All.takeIf { list == AutoList.Liked } ?: Collection.Main) }
    var sort by rememberSaveable { mutableStateOf("default") }
    val shown = remember(tracks, sort) { tracks?.let { sortTracks(it, sort) } }
    val title = if (list == AutoList.Liked) "Favorites" else if (list == AutoList.NeverPlayed) "Not played" else list.title
    SongListPage(
        title, onBack, shown, title, "auto:$name", sort = sort, onSort = { sort = it },
        trailing = if (list == AutoList.MostPlayed) ({ t -> "${t.playCount}×" }) else null,
        empty = {
            when (list) {
                AutoList.Liked -> EmptyState(Icons.Rounded.FavoriteBorder, "No favorites yet", "Tap the heart on any song. Favorites sync with your computers.")
                AutoList.MostPlayed, AutoList.RecentlyPlayed -> EmptyState(Icons.Rounded.History, "Nothing played yet", "Plays from all your devices count.")
                else -> EmptyState(Icons.AutoMirrored.Rounded.QueueMusic, "No songs")
            }
        },
    )
}

@Composable
private fun AllSongsPage(onBack: () -> Unit) {
    val ui = LocalUi.current
    val prefs = ui.app.prefs
    val sort by prefs.songSort.flow.collectAsState()
    val tracks by rememberFlow("songs:main:$sort", null) { ui.library.songs(Collection.Main, sort) }
    SongListPage(
        "All songs", onBack, tracks, "All songs", "allSongs:$sort",
        sort = sort, onSort = { prefs.songSort.value = it }, sortOptions = SONG_SORTS,
    )
}

@Composable
private fun HistoryPage(onBack: () -> Unit) {
    val ui = LocalUi.current
    val history by rememberFlow("history", null) { ui.library.history() }
    val fmt = remember { DateFormat.getDateTimeInstance(DateFormat.MEDIUM, DateFormat.SHORT) }
    Column(Modifier.fillMaxSize()) {
        TopBar("Listening history", onBack)
        val h = history ?: return@Column
        if (h.isEmpty()) return@Column EmptyState(Icons.Rounded.History, "Nothing played yet", "Plays from all your devices show up here.")
        val tracks = remember(h) { h.map { it.first } }
        val current by ui.playback.current.collectAsState()
        HDivider()
        Box(Modifier.fillMaxSize()) {
            val state = ui.listState("history")
            LazyColumn(state = state, contentPadding = PaddingValues(bottom = 8.dp)) {
                itemsIndexed(h, key = { i, _ -> i }, contentType = { _, _ -> "song" }) { i, (t, at) ->
                    SongRow(
                        t, onClick = { ui.play(tracks, i, "History") }, onMenu = { ui.menu = MenuTarget.Song(t, tracks, "History") },
                        playing = current?.id == t.id, line3 = fmt.format(Date(at)),
                    )
                }
            }
            FastScroller(state)
        }
    }
}
