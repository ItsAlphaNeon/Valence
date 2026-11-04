package app.valence.ui.screens

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.GridItemSpan
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.itemsIndexed
import androidx.compose.foundation.lazy.grid.rememberLazyGridState
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.pager.HorizontalPager
import androidx.compose.foundation.pager.rememberPagerState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.Album
import androidx.compose.material.icons.rounded.Folder
import androidx.compose.material.icons.rounded.GridView
import androidx.compose.material.icons.rounded.LibraryMusic
import androidx.compose.material.icons.rounded.Person
import androidx.compose.material.icons.rounded.Search
import androidx.compose.material.icons.rounded.Settings
import androidx.compose.material.icons.rounded.Sell
import androidx.compose.material.icons.automirrored.rounded.ViewList
import androidx.compose.material.icons.rounded.Favorite
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.PrimaryScrollableTabRow
import androidx.compose.material3.Tab
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import app.valence.data.Album
import app.valence.data.Collection
import app.valence.ui.LocalUi
import app.valence.ui.MenuTarget
import app.valence.ui.components.AlbumCard
import app.valence.ui.components.EmptyState
import app.valence.ui.components.FastScroller
import app.valence.ui.components.ListRow
import app.valence.ui.components.PlayShuffleBar
import app.valence.ui.components.SortButton
import app.valence.ui.components.SortOption
import app.valence.ui.components.TrackRow
import app.valence.ui.components.indexLetter
import app.valence.ui.components.songs
import app.valence.ui.components.subtitle
import app.valence.ui.rememberFlow
import kotlinx.coroutines.launch

val SONG_SORTS = listOf(
    SortOption("title", "Title"), SortOption("artist", "Artist"), SortOption("album", "Album"), SortOption("year", "Year"),
    SortOption("added", "Date added"), SortOption("plays", "Most played"), SortOption("duration", "Length"),
)
val ALBUM_SORTS = listOf(SortOption("artist", "Artist"), SortOption("title", "Title"), SortOption("year", "Year"), SortOption("added", "Date added"))
val ARTIST_SORTS = listOf(SortOption("name", "Name"), SortOption("tracks", "Most songs"), SortOption("albums", "Most albums"))

/** Top bar shared by the two main sections: a title, search and settings. */
@Composable
fun SectionHeader(title: String, actions: @Composable () -> Unit = {}) {
    val ui = LocalUi.current
    Row(Modifier.fillMaxWidth().statusBarsPadding().padding(start = 16.dp, end = 4.dp, top = 4.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(title, style = MaterialTheme.typography.headlineSmall, modifier = Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis)
        actions()
        IconButton(onClick = { ui.go("search") }) { Icon(Icons.Rounded.Search, "Search") }
        IconButton(onClick = { ui.go("settings") }) { Icon(Icons.Rounded.Settings, "Settings") }
    }
}

@Composable
fun ScanBanner() {
    val ui = LocalUi.current
    val scan by ui.app.scanner.state.collectAsState()
    if (scan.running) {
        Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp)) {
            Text(
                if (scan.total > 0) "${scan.message} ${scan.done} of ${scan.total}" else scan.message,
                style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            if (scan.total > 0) LinearProgressIndicator(progress = { scan.done.toFloat() / scan.total }, modifier = Modifier.fillMaxWidth().padding(top = 4.dp))
            else LinearProgressIndicator(Modifier.fillMaxWidth().padding(top = 4.dp))
        }
    }
}

private val LIBRARY_TABS = listOf("Songs", "Albums", "Artists", "Genres", "Folders")

@Composable
fun LibraryScreen(bottomPadding: PaddingValues) {
    val ui = LocalUi.current
    val prefs = ui.app.prefs
    val pager = rememberPagerState(initialPage = prefs.libraryTab.value.coerceIn(0, LIBRARY_TABS.lastIndex)) { LIBRARY_TABS.size }
    val scope = rememberCoroutineScope()
    LaunchedEffect(pager.currentPage) { prefs.libraryTab.value = pager.currentPage }
    val songSort by prefs.songSort.flow.collectAsState()
    val albumSort by prefs.albumSort.flow.collectAsState()
    val artistSort by prefs.artistSort.flow.collectAsState()
    val grid by prefs.gridAlbums.flow.collectAsState()

    Column(Modifier.fillMaxSize()) {
        SectionHeader("Library") {
            when (pager.currentPage) {
                0 -> SortButton(SONG_SORTS, songSort) { prefs.songSort.value = it }
                1 -> {
                    IconButton(onClick = { prefs.gridAlbums.value = !grid }) { Icon(if (grid) Icons.AutoMirrored.Rounded.ViewList else Icons.Rounded.GridView, "Layout") }
                    SortButton(ALBUM_SORTS, albumSort) { prefs.albumSort.value = it }
                }
                2 -> SortButton(ARTIST_SORTS, artistSort) { prefs.artistSort.value = it }
            }
        }
        PrimaryScrollableTabRow(selectedTabIndex = pager.currentPage, edgePadding = 8.dp, divider = {}) {
            LIBRARY_TABS.forEachIndexed { i, t -> Tab(pager.currentPage == i, onClick = { scope.launch { pager.animateScrollToPage(i) } }, text = { Text(t) }) }
        }
        ScanBanner()
        HorizontalPager(pager, Modifier.fillMaxSize(), beyondViewportPageCount = 1) { page ->
            when (page) {
                0 -> SongList("songs:main:$songSort", Collection.Main, songSort, "Songs", bottomPadding)
                1 -> AlbumsList("albums:main:$albumSort", Collection.Main, albumSort, grid, bottomPadding)
                2 -> ArtistList(Collection.Main, artistSort, bottomPadding)
                3 -> GenreList(Collection.Main, bottomPadding)
                4 -> FolderList("", bottomPadding)
            }
        }
    }
}

@Composable
fun SongList(key: String, collection: Collection, sort: String, label: String, bottomPadding: PaddingValues, rips: Boolean = false) {
    val ui = LocalUi.current
    val tracks by rememberFlow(key, null) { ui.library.songs(collection, sort) }
    val current by ui.playback.current.collectAsState()
    val list = tracks ?: return
    if (list.isEmpty()) return EmptyState(Icons.Rounded.LibraryMusic, "No songs yet", "Songs appear here once Syncthing has synced your music folder.")
    val state = rememberLazyListState()
    Box(Modifier.fillMaxSize()) {
        LazyColumn(state = state, contentPadding = bottomPadding) {
            item(key = "h:bar") { PlayShuffleBar(list.size, 0, onPlay = { ui.play(list, 0, label) }, onShuffle = { ui.shuffle(list, label) }) }
            itemsIndexed(list, key = { _, t -> t.id }) { i, t ->
                TrackRow(
                    t,
                    onClick = { ui.play(list, i, label) },
                    playing = current?.id == t.id,
                    onMenu = { ui.menu = MenuTarget.Song(t, list, label) },
                    subtitle = if (rips && sort == "game") (t.album.ifBlank { t.artist }) else t.subtitle(),
                )
            }
        }
        FastScroller(state, list.size + 1, label = { i ->
            val t = list.getOrNull(i - 1) ?: list.first()
            when (sort) {
                "artist" -> indexLetter(t.artist)
                "album" -> indexLetter(t.album)
                "year" -> t.year?.toString() ?: ""
                "game" -> indexLetter(t.ripGame ?: "")
                "uploaded", "added", "plays", "duration" -> ""
                else -> indexLetter(t.title)
            }
        })
    }
}

@Composable
fun AlbumsList(key: String, collection: Collection, sort: String, grid: Boolean, bottomPadding: PaddingValues, albums: List<Album>? = null) {
    val ui = LocalUi.current
    val loaded by rememberFlow(key, null) { ui.library.albums(collection, sort) }
    val list = albums ?: loaded ?: return
    if (list.isEmpty()) return EmptyState(Icons.Rounded.Album, "No albums yet")
    val label: (Int) -> String = { i ->
        list.getOrNull(i)?.let { a ->
            when (sort) {
                "title" -> indexLetter(a.title)
                "year" -> a.year?.toString() ?: ""
                "added" -> ""
                else -> indexLetter(a.albumArtist)
            }
        } ?: ""
    }
    if (grid) {
        val state = rememberLazyGridState()
        Box(Modifier.fillMaxSize()) {
            LazyVerticalGrid(
                GridCells.Adaptive(150.dp), state = state,
                contentPadding = PaddingValues(start = 10.dp, end = 10.dp, top = 4.dp, bottom = bottomPadding.calculateBottomPadding() + 8.dp),
            ) {
                itemsIndexed(list, key = { _, a -> a.id }) { _, a ->
                    AlbumCard(a, onClick = { ui.album(a.id) }, onLongClick = { ui.menu = MenuTarget.AlbumMenu(a) }, subtitle = albumSubtitle(a, sort))
                }
                item(span = { GridItemSpan(maxLineSpan) }) {}
            }
            FastScroller(state, list.size, label)
        }
    } else {
        val state = rememberLazyListState()
        Box(Modifier.fillMaxSize()) {
            LazyColumn(state = state, contentPadding = bottomPadding) {
                itemsIndexed(list, key = { _, a -> a.id }) { _, a ->
                    ListRow(a.title, albumSubtitle(a, sort) + " · " + songs(a.trackCount), onClick = { ui.album(a.id) }, artTrackId = a.artTrackId, onLongClick = { ui.menu = MenuTarget.AlbumMenu(a) })
                }
            }
            FastScroller(state, list.size, label)
        }
    }
}

private fun albumSubtitle(a: Album, sort: String) = if (sort == "year" && a.year != null) "${a.year} · ${a.albumArtist}" else a.albumArtist

@Composable
fun ArtistList(collection: Collection, sort: String, bottomPadding: PaddingValues) {
    val ui = LocalUi.current
    val artists by rememberFlow("artists:$collection:$sort", null) { ui.library.artists(collection, sort) }
    val list = artists ?: return
    if (list.isEmpty()) return EmptyState(Icons.Rounded.Person, "No artists yet")
    val state = rememberLazyListState()
    Box(Modifier.fillMaxSize()) {
        LazyColumn(state = state, contentPadding = bottomPadding) {
            itemsIndexed(list, key = { _, a -> a.name }) { _, a ->
                ListRow(
                    a.name,
                    "${if (a.albumCount == 1) "1 album" else "${a.albumCount} albums"} · ${songs(a.trackCount)}",
                    onClick = { ui.artist(a.name) },
                    artTrackId = a.artTrackId,
                    icon = Icons.Rounded.Person,
                    circle = true,
                    trailing = if (a.liked) ({ Icon(Icons.Rounded.Favorite, "Liked", Modifier.padding(end = 8.dp), tint = MaterialTheme.colorScheme.primary) }) else null,
                )
            }
        }
        FastScroller(state, list.size, label = { indexLetter(list.getOrNull(it)?.name ?: "") })
    }
}

@Composable
fun GenreList(collection: Collection, bottomPadding: PaddingValues) {
    val ui = LocalUi.current
    val genres by rememberFlow("genres:$collection", null) { ui.library.genres(collection) }
    val list = genres ?: return
    if (list.isEmpty()) return EmptyState(Icons.Rounded.Sell, "No genres")
    LazyColumn(contentPadding = bottomPadding) {
        itemsIndexed(list, key = { _, g -> g.name }) { _, g ->
            ListRow(g.name, songs(g.trackCount), onClick = { ui.genre(g.name) }, artTrackId = g.artTrackId, icon = Icons.Rounded.Sell)
        }
    }
}

/** Folders, as Syncthing lays them out on disk ("" = the music folder). */
@Composable
fun FolderList(path: String, bottomPadding: PaddingValues, header: (@Composable () -> Unit)? = null) {
    val ui = LocalUi.current
    val folders by rememberFlow("folders:$path", null) { ui.library.folders(path) }
    val tracks by rememberFlow("folderTracks:$path", null) { ui.library.folderTracks(path) }
    val current by ui.playback.current.collectAsState()
    val dirs = folders ?: return
    val songs = tracks ?: return
    if (dirs.isEmpty() && songs.isEmpty()) return EmptyState(Icons.Rounded.Folder, "Nothing here")
    val label = path.substringAfterLast('/').ifEmpty { "Music" }
    LazyColumn(contentPadding = bottomPadding) {
        if (header != null) item(key = "h:header") { header() }
        itemsIndexed(dirs, key = { _, f -> "d:" + f.relPath }) { _, f ->
            ListRow(f.name, songs(f.trackCount), onClick = { ui.folder(f.relPath) }, artTrackId = f.artTrackId, icon = Icons.Rounded.Folder)
        }
        if (songs.isNotEmpty()) {
            item(key = "h:bar") { PlayShuffleBar(songs.size, songs.sumOf { it.durationMs }, onPlay = { ui.play(songs, 0, label) }, onShuffle = { ui.shuffle(songs, label) }) }
            itemsIndexed(songs, key = { _, t -> t.id }) { i, t ->
                TrackRow(t, onClick = { ui.play(songs, i, label) }, playing = current?.id == t.id, onMenu = { ui.menu = MenuTarget.Song(t, songs, label) })
            }
        }
    }
}
