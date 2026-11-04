package app.valence.ui.screens

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.QueueMusic
import androidx.compose.material.icons.rounded.Add
import androidx.compose.material.icons.rounded.Album
import androidx.compose.material.icons.rounded.AutoAwesome
import androidx.compose.material.icons.rounded.Block
import androidx.compose.material.icons.rounded.Favorite
import androidx.compose.material.icons.rounded.Folder
import androidx.compose.material.icons.rounded.History
import androidx.compose.material.icons.rounded.LibraryMusic
import androidx.compose.material.icons.rounded.LocalFireDepartment
import androidx.compose.material.icons.rounded.MoreTime
import androidx.compose.material.icons.rounded.Person
import androidx.compose.material.icons.rounded.Schedule
import androidx.compose.material.icons.rounded.SportsEsports
import androidx.compose.material.icons.rounded.Style
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.valence.data.Album
import app.valence.data.AutoList
import app.valence.data.Collection
import app.valence.data.Scanner
import app.valence.ui.LocalUi
import app.valence.ui.MenuTarget
import app.valence.ui.Route
import app.valence.ui.Tab
import app.valence.ui.components.Chip
import app.valence.ui.components.ChipRow
import app.valence.ui.components.DialogButtons
import app.valence.ui.components.DialogSeparator
import app.valence.ui.components.DialogTitle
import app.valence.ui.components.EmptyState
import app.valence.ui.components.FastScroller
import app.valence.ui.components.HDivider
import app.valence.ui.components.MDialog
import app.valence.ui.components.OutlinedAction
import app.valence.ui.components.PlainRow
import app.valence.ui.components.RadioItem
import app.valence.ui.components.ScrollStrip
import app.valence.ui.components.SearchHintBar
import app.valence.ui.components.SectionLabel
import app.valence.ui.components.SortDialog
import app.valence.ui.components.SortOption
import app.valence.ui.components.Thumb
import app.valence.ui.components.indexLetter
import app.valence.ui.components.songs
import app.valence.ui.rememberFlow
import app.valence.ui.theme.LocalPalette

val ALBUM_SORTS = listOf(SortOption("title", "Title"), SortOption("artist", "Album artist"), SortOption("year", "Year"), SortOption("added", "Date added"))
val ARTIST_SORTS = listOf(SortOption("name", "Name"), SortOption("tracks", "Number of songs"), SortOption("albums", "Number of albums"))
val SONG_SORTS = listOf(
    SortOption("title", "Title"), SortOption("artist", "Artist"), SortOption("album", "Album"), SortOption("year", "Year"),
    SortOption("added", "Date added"), SortOption("plays", "Play count"), SortOption("duration", "Length"),
)
val RIP_SORTS = listOf(
    SortOption("uploaded", "Upload date"), SortOption("title", "Title"), SortOption("game", "Game"),
    SortOption("added", "Date added"), SortOption("plays", "Play count"), SortOption("duration", "Length"),
)

/**
 * Rip album tiles drop the series name every one of them shares, as the desktop's do:
 * "SiIvaGunner: Season 7 – The Year of Grand Dad" → "Season 7 – The Year of Grand Dad",
 * "SiIvaGunner's Highest Quality Rips: Volume 🔥" → "Volume 🔥".
 */
fun ripTileTitle(title: String): String {
    val i = title.indexOf(": ")
    if (i <= 0) return title
    val head = title.substring(0, i)
    return if (head.contains("siivagunner", ignoreCase = true) || head.contains("highest quality rips", ignoreCase = true)) title.substring(i + 2) else title
}

/** Case- and accent-blind "contains", for the in-list search boxes. */
fun matches(text: String, filter: String): Boolean = filter.isBlank() || Scanner.fold(text).contains(Scanner.fold(filter.trim()))

/** One tab: its root page, or the page on top of its back stack. */
@Composable
fun TabPage(tab: Tab) {
    when (tab) {
        Tab.Player -> return PlayerPage()
        Tab.Queues -> return QueuesPage()
        else -> {}
    }
    val ui = LocalUi.current
    val stack = ui.stack(tab)
    val top = stack.lastOrNull()
    Box(Modifier.fillMaxSize().background(LocalPalette.current.bg)) {
        if (top == null) when (tab) {
            Tab.Folders -> FolderPage("", null)
            Tab.Albums -> AlbumsTab()
            Tab.Artists -> ArtistsTab()
            Tab.Genres -> GenresTab()
            Tab.Rips -> RipsTab()
            Tab.Playlists -> PlaylistsTab()
            else -> {}
        } else key(top, stack.size) {
            RoutePage(top) { ui.back() }
        }
    }
}

@Composable
private fun RoutePage(r: Route, onBack: () -> Unit) {
    when (r) {
        is Route.AlbumR -> AlbumPage(r.id, onBack)
        is Route.ArtistR -> ArtistPage(r.name, r.mode, onBack)
        is Route.GenreR -> GenrePage(r.name, onBack)
        is Route.GameR -> GamePage(r.name, onBack)
        is Route.FolderR -> FolderPage(r.path, onBack)
        is Route.PlaylistR -> PlaylistPage(r.id, onBack)
        is Route.AutoR -> AutoPage(r.name, onBack)
    }
}

// ---- Albums --------------------------------------------------------------------------------------

@Composable
fun AlbumsTab() {
    val ui = LocalUi.current
    val prefs = ui.app.prefs
    val sort by prefs.albumSort.flow.collectAsState()
    var filter by rememberSaveable { mutableStateOf("") }
    var sorting by remember { mutableStateOf(false) }
    var viewing by remember { mutableStateOf(false) }
    val albums by rememberFlow("albums:main:$sort", null) { ui.library.albums(Collection.Main, sort) }
    Column(Modifier.fillMaxSize().statusBarsPadding()) {
        SearchHintBar("Search an album…", filter, { filter = it }, onSort = { sorting = true }, onSettings = { viewing = true })
        val list = albums ?: return@Column
        val shown = remember(list, filter) { if (filter.isBlank()) list else list.filter { matches(it.title + " " + it.albumArtist, filter) } }
        if (list.isEmpty()) return@Column EmptyState(Icons.Rounded.Album, "No albums yet", "Albums appear here once Syncthing has synced your music folder.")
        AlbumGrid(shown, "albums:$sort", label = { a ->
            when (sort) {
                "year" -> a.year?.toString() ?: ""
                "added" -> ""
                "artist" -> indexLetter(a.albumArtist)
                else -> indexLetter(a.title)
            }
        })
    }
    if (sorting) SortDialog("Sort albums by…", ALBUM_SORTS, sort, { prefs.albumSort.value = it; ui.forgetScroll("albums:$it") }) { sorting = false }
    if (viewing) AlbumViewDialog { viewing = false }
}

/** Grid or list of albums, as set in the Albums tab's settings. */
@Composable
fun AlbumGrid(albums: List<Album>, stateKey: String, label: (Album) -> String = { indexLetter(it.title) }, title: (Album) -> String = { it.title }) {
    val ui = LocalUi.current
    val prefs = ui.app.prefs
    val grid by prefs.gridAlbums.flow.collectAsState()
    val columns by prefs.albumColumns.flow.collectAsState()
    Box(Modifier.fillMaxSize()) {
        if (grid) {
            val state = ui.gridState("$stateKey:g$columns")
            LazyVerticalGrid(
                GridCells.Fixed(columns.coerceIn(2, 5)),
                state = state,
                contentPadding = PaddingValues(start = 2.dp, end = ScrollStrip - 4.dp, top = 6.dp, bottom = 8.dp),
            ) {
                items(albums, key = { it.id }, contentType = { "album" }) { a ->
                    AlbumCard(a, onClick = { ui.album(a.id) }, onLongClick = { ui.menu = MenuTarget.AlbumMenu(a) }, title = title(a))
                }
            }
            FastScroller(state, columns.coerceIn(2, 5)) { i -> albums.getOrNull(i)?.let(label) ?: "" }
        } else {
            val state = ui.listState("$stateKey:l")
            LazyColumn(state = state, contentPadding = PaddingValues(end = ScrollStrip)) {
                items(albums, key = { it.id }, contentType = { "album" }) { a ->
                    PlainRow(
                        title(a), onClick = { ui.album(a.id) }, subtitle = listOfNotNull(a.albumArtist, a.year?.toString()).joinToString(" · "),
                        artTrackId = a.artTrackId, showArt = true, icon = Icons.Rounded.Album, onLongClick = { ui.menu = MenuTarget.AlbumMenu(a) },
                    )
                }
            }
            FastScroller(state) { i -> albums.getOrNull(i)?.let(label) ?: "" }
        }
    }
}

/** Musicolet's album tile: square art over the title, in a thin rounded outline. */
@OptIn(ExperimentalFoundationApi::class)
@Composable
fun AlbumCard(album: Album, onClick: () -> Unit, onLongClick: () -> Unit, modifier: Modifier = Modifier, selected: Boolean = false, title: String = album.title) {
    val pal = LocalPalette.current
    val shape = RoundedCornerShape(6.dp)
    Column(
        modifier
            .padding(4.dp)
            .clip(shape)
            .border(1.dp, if (selected) pal.accent else pal.outline, shape)
            .combinedClickable(onClick = onClick, onLongClick = onLongClick),
    ) {
        Thumb(album.artTrackId, Modifier.fillMaxWidth().aspectRatio(1f), icon = Icons.Rounded.Album, iconSize = 40.dp)
        Text(
            title,
            Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 7.dp),
            style = TextStyle(fontSize = 15.sp, lineHeight = 19.sp),
            color = pal.text,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
    }
}

@Composable
private fun AlbumViewDialog(onDismiss: () -> Unit) {
    val prefs = LocalUi.current.app.prefs
    val grid by prefs.gridAlbums.flow.collectAsState()
    val columns by prefs.albumColumns.flow.collectAsState()
    MDialog(onDismiss) {
        Column {
            DialogTitle("Albums")
            RadioItem("Grid", grid) { prefs.gridAlbums.value = true }
            RadioItem("List", !grid) { prefs.gridAlbums.value = false }
            if (grid) {
                DialogSeparator()
                for (n in 2..4) RadioItem("$n columns", columns == n) { prefs.albumColumns.value = n }
            }
            DialogButtons("Done" to onDismiss)
        }
    }
}

// ---- Artists -------------------------------------------------------------------------------------

@Composable
fun ArtistsTab() {
    val ui = LocalUi.current
    val prefs = ui.app.prefs
    val mode by prefs.artistMode.flow.collectAsState()
    val sort by prefs.artistSort.flow.collectAsState()
    var filter by rememberSaveable { mutableStateOf("") }
    var sorting by remember { mutableStateOf(false) }
    val artists by rememberFlow("artists:$mode:$sort", null) { ui.library.artistsBy(mode, Collection.Main, sort) }
    Column(Modifier.fillMaxSize().statusBarsPadding()) {
        ChipRow {
            Chip("Artists", mode == "track", { prefs.artistMode.value = "track" })
            Chip("Album-Artists", mode == "album", { prefs.artistMode.value = "album" })
            Chip("Composers", mode == "composer", { prefs.artistMode.value = "composer" })
        }
        SearchHintBar(if (mode == "composer") "Search a composer…" else "Search an artist…", filter, { filter = it }, onSort = { sorting = true })
        val list = artists ?: return@Column
        if (list.isEmpty()) return@Column EmptyState(Icons.Rounded.Person, if (mode == "composer") "No composers" else "No artists yet")
        val shown = remember(list, filter) { if (filter.isBlank()) list else list.filter { matches(it.name, filter) } }
        Box(Modifier.fillMaxSize()) {
            val state = ui.listState("artists:$mode:$sort")
            LazyColumn(state = state, contentPadding = PaddingValues(end = ScrollStrip, top = 4.dp, bottom = 8.dp)) {
                items(shown, key = { it.name }, contentType = { "artist" }) { a ->
                    PlainRow(a.name, onClick = { ui.artist(a.name, mode) }, modifier = Modifier.padding(start = 6.dp))
                }
            }
            FastScroller(state) { i -> shown.getOrNull(i)?.let { if (sort == "name") indexLetter(it.name) else "" } ?: "" }
        }
    }
    if (sorting) SortDialog("Sort artists by…", ARTIST_SORTS, sort, { prefs.artistSort.value = it }) { sorting = false }
}

// ---- Genres --------------------------------------------------------------------------------------

@Composable
fun GenresTab() {
    val ui = LocalUi.current
    var filter by rememberSaveable { mutableStateOf("") }
    val genres by rememberFlow("genres:${Collection.Main}", null) { ui.library.genres(Collection.Main) }
    Column(Modifier.fillMaxSize().statusBarsPadding()) {
        SearchHintBar("Search a genre…", filter, { filter = it })
        val list = genres ?: return@Column
        if (list.isEmpty()) return@Column EmptyState(Icons.Rounded.Style, "No genres")
        val shown = remember(list, filter) { list.filter { matches(it.name, filter) } }
        Box(Modifier.fillMaxSize()) {
            val state = ui.listState("genres")
            LazyColumn(state = state, contentPadding = PaddingValues(end = ScrollStrip, top = 4.dp, bottom = 8.dp)) {
                items(shown, key = { it.name }) { g ->
                    PlainRow(g.name, onClick = { ui.genre(g.name) }, subtitle = songs(g.trackCount), modifier = Modifier.padding(start = 6.dp))
                }
            }
            FastScroller(state) { i -> shown.getOrNull(i)?.let { indexLetter(it.name) } ?: "" }
        }
    }
}

// ---- SiivaGunner ---------------------------------------------------------------------------------

private val RIP_MODES = listOf("Seasons", "Albums", "Games", "Songs")

/** The SiivaGunner rips, kept apart from the library as on the desktop. */
@Composable
fun RipsTab() {
    val ui = LocalUi.current
    val prefs = ui.app.prefs
    val mode by prefs.ripsTab.flow.collectAsState()
    Column(Modifier.fillMaxSize().statusBarsPadding()) {
        ChipRow {
            RIP_MODES.forEachIndexed { i, m -> Chip(m, mode == i, { prefs.ripsTab.value = i }) }
        }
        when (mode.coerceIn(0, RIP_MODES.lastIndex)) {
            0 -> Seasons()
            1 -> RipAlbums()
            2 -> Games()
            else -> RipSongs()
        }
    }
}

@Composable
private fun Seasons() {
    val ui = LocalUi.current
    var filter by rememberSaveable { mutableStateOf("") }
    val seasons by rememberFlow("seasons", null) { ui.library.seasons(ui.app.sync.seasons()) }
    SearchHintBar("Search a season…", filter, { filter = it })
    val list = seasons ?: return
    if (list.isEmpty()) return EmptyState(Icons.Rounded.SportsEsports, "No seasons yet", "Rips tagged as YouTube season albums show up here.")
    AlbumGrid(remember(list, filter) { list.filter { matches(it.title, filter) } }, "seasons", label = { "" }, title = { ripTileTitle(it.title) })
}

@Composable
private fun RipAlbums() {
    val ui = LocalUi.current
    var filter by rememberSaveable { mutableStateOf("") }
    val albums by rememberFlow("ripAlbums", null) { ui.library.ripAlbums() }
    SearchHintBar("Search a rip album…", filter, { filter = it })
    val list = albums ?: return
    if (list.isEmpty()) return EmptyState(Icons.Rounded.SportsEsports, "No rip albums", "SiIvaGunner and SGFR albums show up here.")
    AlbumGrid(remember(list, filter) { list.filter { matches(it.title, filter) } }, "ripAlbums", label = { it.year?.toString() ?: "" }, title = { ripTileTitle(it.title) })
}

@Composable
private fun Games() {
    val ui = LocalUi.current
    var filter by rememberSaveable { mutableStateOf("") }
    val games by rememberFlow("ripGames", null) { ui.library.ripGames() }
    SearchHintBar("Search a game…", filter, { filter = it })
    val list = games ?: return
    if (list.isEmpty()) return EmptyState(Icons.Rounded.SportsEsports, "No games", "Rips with a game in their tags are grouped here.")
    val shown = remember(list, filter) { list.filter { matches(it.name, filter) } }
    Box(Modifier.fillMaxSize()) {
        val state = ui.listState("games")
        LazyColumn(state = state, contentPadding = PaddingValues(end = ScrollStrip, top = 4.dp, bottom = 8.dp)) {
            items(shown, key = { it.name }) { g ->
                PlainRow(g.name, onClick = { ui.game(g.name) }, subtitle = if (g.trackCount == 1) "1 rip" else "${g.trackCount} rips", modifier = Modifier.padding(start = 6.dp))
            }
        }
        FastScroller(state) { i -> shown.getOrNull(i)?.let { indexLetter(it.name) } ?: "" }
    }
}

@Composable
private fun RipSongs() {
    val ui = LocalUi.current
    val prefs = ui.app.prefs
    val sort by prefs.ripSort.flow.collectAsState()
    var filter by rememberSaveable { mutableStateOf("") }
    var sorting by remember { mutableStateOf(false) }
    val tracks by rememberFlow("songs:rips:$sort", null) { ui.library.songs(Collection.Rips, sort) }
    SearchHintBar("Search a rip…", filter, { filter = it }, onSort = { sorting = true })
    val list = tracks ?: return
    val shown = remember(list, filter) { if (filter.isBlank()) list else list.filter { matches(it.title + " " + (it.ripGame ?: "") + " " + it.album, filter) } }
    SongList(
        shown, "SiivaGunner", "ripSongs:$sort",
        label = { t ->
            when (sort) {
                "title" -> indexLetter(t.title)
                "game" -> indexLetter(t.ripGame ?: "")
                else -> ""
            }
        },
    )
    if (sorting) SortDialog("Sort rips by…", RIP_SORTS, sort, { prefs.ripSort.value = it }) { sorting = false }
}

// ---- Playlists -----------------------------------------------------------------------------------

private data class Builtin(val route: String, val title: String, val icon: androidx.compose.ui.graphics.vector.ImageVector)

private val BUILTINS = listOf(
    Builtin("All", "All songs", Icons.Rounded.LibraryMusic),
    Builtin(AutoList.Liked.name, "Favorites", Icons.Rounded.Favorite),
    Builtin(AutoList.RecentlyAdded.name, "Recently added", Icons.Rounded.MoreTime),
    Builtin(AutoList.RecentlyPlayed.name, "Recently played", Icons.Rounded.History),
    Builtin(AutoList.MostPlayed.name, "Most played", Icons.Rounded.LocalFireDepartment),
    Builtin(AutoList.NeverPlayed.name, "Not played", Icons.Rounded.Block),
    Builtin("History", "Listening history", Icons.Rounded.Schedule),
)

@Composable
fun PlaylistsTab() {
    val ui = LocalUi.current
    val pal = LocalPalette.current
    val playlists by rememberFlow("playlists", null) { ui.library.playlists() }
    var creating by remember { mutableStateOf(false) }
    val scan by ui.app.scanner.state.collectAsState()
    Column(Modifier.fillMaxSize().statusBarsPadding()) {
        if (scan.running) {
            Text(
                if (scan.total > 0) "${scan.message} ${scan.done} of ${scan.total}" else scan.message,
                Modifier.padding(horizontal = 16.dp, vertical = 6.dp), style = TextStyle(fontSize = 13.sp), color = pal.text2,
            )
            if (scan.total > 0) LinearProgressIndicator(progress = { scan.done.toFloat() / scan.total }, modifier = Modifier.fillMaxWidth())
            else LinearProgressIndicator(Modifier.fillMaxWidth())
        }
        val state = ui.listState("playlists")
        val list = playlists.orEmpty()
        LazyColumn(state = state, contentPadding = PaddingValues(top = 4.dp, bottom = 16.dp)) {
            items(BUILTINS, key = { "b:" + it.route }) { b ->
                PlainRow(b.title, onClick = { ui.auto(b.route) }, icon = b.icon)
            }
            item(key = "h:mine") { SectionLabel("Your playlists") }
            items(list, key = { "p:" + it.id }) { p ->
                PlainRow(
                    p.name, onClick = { ui.playlist(p.id) },
                    icon = if (p.kind == "smart") Icons.Rounded.AutoAwesome else Icons.AutoMirrored.Rounded.QueueMusic,
                    subtitle = if (p.kind == "smart") "Smart playlist · ${songs(p.itemCount)}" else songs(p.itemCount),
                    onLongClick = { ui.menu = MenuTarget.PlaylistMenu(p) },
                )
            }
            item(key = "h:new") {
                OutlinedAction("New Playlist", { creating = true }, Modifier.padding(start = 16.dp, top = 8.dp, bottom = 16.dp), icon = Icons.Rounded.Add)
            }
        }
    }
    if (creating) NewPlaylistDialog(onDismiss = { creating = false }) { name ->
        creating = false
        ui.app.sync.createPlaylist(name, emptyList()) { id -> if (id != null) ui.playlist(id) }
    }
}

// ---- Folders -------------------------------------------------------------------------------------

/** Musicolet's folder browser: sub-folders first, then the songs in this folder. */
@Composable
fun FolderPage(path: String, onBack: (() -> Unit)?) {
    val ui = LocalUi.current
    val pal = LocalPalette.current
    val folders by rememberFlow("folders:$path", null) { ui.library.folders(path) }
    val tracks by rememberFlow("folderTracks:$path", null) { ui.library.folderTracks(path) }
    val name = path.substringAfterLast('/').ifEmpty { "Music" }
    Column(Modifier.fillMaxSize()) {
        app.valence.ui.components.TopBar(name, onBack)
        Text(
            "/" + path,
            Modifier.fillMaxWidth().padding(start = 16.dp, end = 16.dp, bottom = 6.dp),
            style = TextStyle(fontSize = 13.sp), color = pal.text2, maxLines = 1, overflow = TextOverflow.StartEllipsis,
        )
        HDivider()
        val dirs = folders ?: return@Column
        val songs = tracks ?: return@Column
        if (dirs.isEmpty() && songs.isEmpty()) return@Column EmptyState(Icons.Rounded.Folder, "Nothing here")
        val current by ui.playback.current.collectAsState()
        val playingId = current?.id
        Box(Modifier.fillMaxSize()) {
            val state = ui.listState("folder:$path")
            LazyColumn(state = state, contentPadding = PaddingValues(bottom = 8.dp)) {
                items(dirs, key = { "d:" + it.relPath }, contentType = { "dir" }) { f ->
                    PlainRow(f.name, onClick = { ui.folder(f.relPath) }, subtitle = songs(f.trackCount), icon = Icons.Rounded.Folder, modifier = Modifier.padding(end = ScrollStrip))
                }
                if (songs.isNotEmpty()) {
                    item(key = "h:actions") {
                        app.valence.ui.components.ListActions(
                            onShuffle = { ui.shuffle(songs, name) },
                            onMenu = { ui.menu = MenuTarget.Songs(name, songs) },
                            start = { app.valence.ui.components.CountLine(songs.size, songs.sumOf { it.durationMs }, Modifier.padding(start = 16.dp)) },
                        )
                    }
                    itemsIndexed(songs, key = { _, t -> t.id }, contentType = { _, _ -> "song" }) { i, t ->
                        app.valence.ui.components.SongRow(t, onClick = { ui.play(songs, i, name) }, onMenu = { ui.menu = MenuTarget.Song(t, songs, name) }, playing = t.id == playingId)
                    }
                }
            }
            FastScroller(state)
        }
    }
}

@Composable
fun SubCard(title: String, selected: Boolean, onClick: () -> Unit, onLongClick: () -> Unit, artTrackId: Long? = null, showArt: Boolean = false) {
    val pal = LocalPalette.current
    val shape = RoundedCornerShape(6.dp)
    @OptIn(ExperimentalFoundationApi::class)
    Box(
        Modifier
            .padding(horizontal = 4.dp)
            .height(80.dp)
            .aspectRatio(1f)
            .clip(shape)
            .border(1.dp, pal.outline, shape)
            .combinedClickable(onClick = onClick, onLongClick = onLongClick),
        contentAlignment = Alignment.Center,
    ) {
        if (showArt) Thumb(artTrackId, Modifier.fillMaxSize(), icon = Icons.Rounded.Album)
        else Text(
            title, Modifier.padding(6.dp), style = TextStyle(fontSize = 13.sp, lineHeight = 16.sp, fontWeight = androidx.compose.ui.text.font.FontWeight.Bold),
            color = pal.text, maxLines = 3, overflow = TextOverflow.Ellipsis, textAlign = androidx.compose.ui.text.style.TextAlign.Center,
        )
        if (selected) Box(Modifier.align(Alignment.BottomCenter).padding(bottom = 4.dp).height(2.dp).fillMaxWidth(0.6f).background(pal.accent))
    }
}

@Composable
fun SubCardRow(label: String, count: String, content: androidx.compose.foundation.lazy.LazyListScope.() -> Unit) {
    val pal = LocalPalette.current
    Column(Modifier.fillMaxWidth()) {
        Row(Modifier.padding(start = 16.dp, top = 6.dp, bottom = 6.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(label, style = TextStyle(fontSize = 15.sp, fontWeight = androidx.compose.ui.text.font.FontWeight.Bold), color = pal.text)
            Spacer(Modifier.padding(start = 10.dp))
            Text(count, style = TextStyle(fontSize = 14.sp), color = pal.text2)
        }
        androidx.compose.foundation.lazy.LazyRow(contentPadding = PaddingValues(horizontal = 10.dp), content = content)
    }
}
