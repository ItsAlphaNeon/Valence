package app.valence.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.ArrowBack
import androidx.compose.material.icons.rounded.Close
import androidx.compose.material.icons.rounded.Search
import androidx.compose.material.icons.rounded.Shuffle
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
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.valence.data.Collection
import app.valence.data.Db
import app.valence.data.Library
import app.valence.ui.LocalUi
import app.valence.ui.MenuTarget
import app.valence.ui.components.Chip
import app.valence.ui.components.EmptyState
import app.valence.ui.components.IconAction
import app.valence.ui.components.OptionsButton
import app.valence.ui.components.PlainRow
import app.valence.ui.components.Screen
import app.valence.ui.components.ScrollStrip
import app.valence.ui.components.SongRow
import app.valence.ui.theme.LocalPalette
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext

/** Musicolet's search: one box, then matching albums and artists as links, and the songs found. */
@Composable
fun SearchScreen() {
    val ui = LocalUi.current
    val pal = LocalPalette.current
    var query by rememberSaveable { mutableStateOf("") }
    var scope by rememberSaveable { mutableStateOf(Collection.All) }
    var showing by rememberSaveable { mutableStateOf("songs") }
    var result by remember { mutableStateOf<Library.SearchResult?>(null) }
    val current by ui.playback.current.collectAsState()
    val focus = remember { FocusRequester() }
    LaunchedEffect(Unit) { if (query.isEmpty()) focus.requestFocus() }
    // Re-run when the library changes too (a tag edit made from these results, a scan).
    val tracksVersion by ui.app.db.version(Db.Topic.Tracks).collectAsState()
    var lastQuery by remember { mutableStateOf<Pair<String, Collection>?>(null) }
    LaunchedEffect(query, scope, tracksVersion) {
        if (query.isBlank()) { result = null; lastQuery = null; return@LaunchedEffect }
        val fresh = lastQuery != query to scope
        if (fresh) delay(150)
        result = withContext(Dispatchers.IO) { ui.library.search(query, scope) }
        if (fresh) showing = "songs"
        lastQuery = query to scope
    }
    Screen {
        Column(Modifier.fillMaxSize().statusBarsPadding().navigationBarsPadding().imePadding()) {
            Row(Modifier.fillMaxWidth().height(56.dp), verticalAlignment = Alignment.CenterVertically) {
                IconAction(Icons.AutoMirrored.Rounded.ArrowBack, "Back", { ui.back() })
                Box(Modifier.weight(1f).padding(horizontal = 4.dp)) {
                    if (query.isEmpty()) Text("Search by title, album, artist, game", style = TextStyle(fontSize = 17.sp), color = pal.text3)
                    BasicTextField(
                        query, { query = it }, singleLine = true,
                        textStyle = TextStyle(fontSize = 17.sp, color = pal.text), cursorBrush = SolidColor(pal.accent),
                        keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
                        modifier = Modifier.fillMaxWidth().focusRequester(focus),
                    )
                    Box(Modifier.align(Alignment.BottomStart).padding(top = 30.dp).fillMaxWidth().height(2.dp).background(pal.accent))
                }
                IconAction(Icons.Rounded.Close, "Clear", { query = "" })
            }
            Row(Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 4.dp)) {
                for ((c, label) in listOf(Collection.All to "Everything", Collection.Main to "Library", Collection.Rips to "SiivaGunner")) {
                    Chip(label, scope == c, { scope = c }, Modifier.padding(end = 8.dp))
                }
            }
            val r = result
            when {
                r == null -> EmptyState(Icons.Rounded.Search, "Search your music", "Titles, artists, albums, composers and games.")
                r.tracks.isEmpty() && r.albums.isEmpty() && r.artists.isEmpty() -> EmptyState(Icons.Rounded.Search, "Nothing found for “$query”")
                else -> {
                    Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 6.dp)) {
                        @Composable
                        fun link(text: String, key: String) = Text(
                            text,
                            style = TextStyle(fontSize = 15.sp, textDecoration = if (showing == key) null else TextDecoration.Underline, fontWeight = if (showing == key) FontWeight.Bold else null),
                            color = pal.accent,
                            modifier = Modifier.clickable { showing = if (showing == key) "songs" else key }.padding(end = 18.dp, top = 4.dp, bottom = 4.dp),
                        )
                        if (r.albums.isNotEmpty()) link(if (r.albums.size == 1) "1 album" else "${r.albums.size} albums", "albums")
                        if (r.artists.isNotEmpty()) link(if (r.artists.size == 1) "1 artist" else "${r.artists.size} artists", "artists")
                    }
                    when (showing) {
                        "albums" -> LazyVerticalGrid(GridCells.Fixed(3), contentPadding = PaddingValues(4.dp)) {
                            items(r.albums, key = { it.id }) { a -> AlbumCard(a, onClick = { ui.album(a.id) }, onLongClick = { ui.menu = MenuTarget.AlbumMenu(a) }) }
                        }
                        "artists" -> LazyColumn {
                            items(r.artists, key = { it.name }) { a -> PlainRow(a.name, onClick = { ui.artist(a.name) }, subtitle = app.valence.ui.components.songs(a.trackCount), modifier = Modifier.padding(start = 6.dp)) }
                        }
                        else -> Column {
                            Row(Modifier.fillMaxWidth().background(pal.bar).height(52.dp).padding(start = 12.dp), verticalAlignment = Alignment.CenterVertically) {
                                Text(
                                    if (r.tracks.size == 1) "1 audio-file found" else "${r.tracks.size} audio-files found",
                                    style = TextStyle(fontSize = 18.sp, fontWeight = FontWeight.Bold), color = pal.text, modifier = Modifier.weight(1f),
                                )
                                if (r.tracks.isNotEmpty()) {
                                    IconAction(Icons.Rounded.Shuffle, "Shuffle listed songs", { ui.shuffle(r.tracks, "Search: $query") })
                                    OptionsButton({ ui.menu = MenuTarget.Songs("Search: $query", r.tracks) })
                                }
                                Spacer(Modifier.width(4.dp))
                            }
                            LazyColumn(contentPadding = PaddingValues(bottom = 8.dp)) {
                                itemsIndexed(r.tracks, key = { _, t -> t.id }, contentType = { _, _ -> "song" }) { i, t ->
                                    SongRow(
                                        t, onClick = { ui.play(r.tracks, i, "Search: $query") },
                                        onMenu = { ui.menu = MenuTarget.Song(t, r.tracks, "Search: $query") }, playing = current?.id == t.id,
                                    )
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}
