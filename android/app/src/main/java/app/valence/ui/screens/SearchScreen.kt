package app.valence.ui.screens

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.ArrowBack
import androidx.compose.material.icons.rounded.Close
import androidx.compose.material.icons.rounded.Person
import androidx.compose.material.icons.rounded.Search
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextField
import androidx.compose.material3.TextFieldDefaults
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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import app.valence.data.Collection
import app.valence.data.Library
import app.valence.ui.LocalUi
import app.valence.ui.MenuTarget
import app.valence.ui.components.AlbumCard
import app.valence.ui.components.EmptyState
import app.valence.ui.components.ListRow
import app.valence.ui.components.SectionTitle
import app.valence.ui.components.TrackRow
import app.valence.ui.components.songs
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext

@Composable
fun SearchScreen(bottomPadding: PaddingValues) {
    val ui = LocalUi.current
    var query by rememberSaveable { mutableStateOf("") }
    var scope by rememberSaveable { mutableStateOf(Collection.All) }
    var result by remember { mutableStateOf<Library.SearchResult?>(null) }
    val current by ui.playback.current.collectAsState()
    val focus = remember { FocusRequester() }
    LaunchedEffect(Unit) { if (query.isEmpty()) focus.requestFocus() }
    LaunchedEffect(query, scope) {
        if (query.isBlank()) { result = null; return@LaunchedEffect }
        delay(150)
        result = withContext(Dispatchers.IO) { ui.library.search(query, scope) }
    }
    Column(Modifier.fillMaxSize()) {
        Row(Modifier.fillMaxWidth().statusBarsPadding().padding(start = 4.dp, end = 12.dp, top = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            IconButton(onClick = { ui.nav.popBackStack() }) { Icon(Icons.AutoMirrored.Rounded.ArrowBack, "Back") }
            TextField(
                query, { query = it },
                placeholder = { Text("Songs, albums, artists, games") },
                singleLine = true,
                leadingIcon = { Icon(Icons.Rounded.Search, null) },
                trailingIcon = { if (query.isNotEmpty()) IconButton(onClick = { query = "" }) { Icon(Icons.Rounded.Close, "Clear") } },
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
                shape = RoundedCornerShape(28.dp),
                colors = TextFieldDefaults.colors(focusedIndicatorColor = Color.Transparent, unfocusedIndicatorColor = Color.Transparent),
                modifier = Modifier.weight(1f).focusRequester(focus),
            )
        }
        Row(Modifier.padding(horizontal = 16.dp, vertical = 4.dp)) {
            for ((c, label) in listOf(Collection.All to "Everything", Collection.Main to "Library", Collection.Rips to "SiivaGunner")) {
                FilterChip(scope == c, onClick = { scope = c }, label = { Text(label) }, modifier = Modifier.padding(end = 8.dp))
            }
        }
        val r = result
        when {
            r == null -> EmptyState(Icons.Rounded.Search, "Search your library", "Matches titles, artists, albums, composers and games.")
            r.tracks.isEmpty() && r.albums.isEmpty() && r.artists.isEmpty() -> EmptyState(Icons.Rounded.Search, "No matches for “$query”")
            else -> LazyColumn(contentPadding = bottomPadding) {
                if (r.artists.isNotEmpty()) {
                    item { SectionTitle("Artists") }
                    items(r.artists.take(5), key = { "r:" + it.name }) { a ->
                        ListRow(a.name, songs(a.trackCount), onClick = { ui.artist(a.name) }, artTrackId = a.artTrackId, icon = Icons.Rounded.Person, circle = true)
                    }
                }
                if (r.albums.isNotEmpty()) {
                    item { SectionTitle("Albums") }
                    item {
                        LazyRow(contentPadding = PaddingValues(horizontal = 10.dp)) {
                            items(r.albums, key = { it.id }) { a -> AlbumCard(a, onClick = { ui.album(a.id) }, onLongClick = { ui.menu = MenuTarget.AlbumMenu(a) }, modifier = Modifier.width(140.dp)) }
                        }
                    }
                }
                if (r.tracks.isNotEmpty()) {
                    item { SectionTitle("Songs") }
                    itemsIndexed(r.tracks, key = { _, t -> "t:" + t.id }) { i, t ->
                        TrackRow(t, onClick = { ui.play(r.tracks, i, "Search: $query") }, playing = current?.id == t.id, onMenu = { ui.menu = MenuTarget.Song(t, r.tracks, "Search: $query") })
                    }
                }
            }
        }
    }
}

