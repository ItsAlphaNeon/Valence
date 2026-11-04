package app.valence.ui.screens

import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
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
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.ArrowBack
import androidx.compose.material.icons.automirrored.rounded.QueueMusic
import androidx.compose.material.icons.rounded.Album
import androidx.compose.material.icons.rounded.AutoAwesome
import androidx.compose.material.icons.rounded.Favorite
import androidx.compose.material.icons.rounded.FavoriteBorder
import androidx.compose.material.icons.rounded.History
import androidx.compose.material.icons.rounded.MoreVert
import androidx.compose.material.icons.rounded.Person
import androidx.compose.material.icons.rounded.Sell
import androidx.compose.material.icons.rounded.SportsEsports
import androidx.compose.material.icons.rounded.Sync
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import app.valence.data.AutoList
import app.valence.data.Collection
import app.valence.data.Track
import app.valence.ui.LocalUi
import app.valence.ui.MenuTarget
import app.valence.ui.components.AlbumCard
import app.valence.ui.components.Art
import app.valence.ui.components.EmptyState
import app.valence.ui.components.FastScroller
import app.valence.ui.components.PlayShuffleBar
import app.valence.ui.components.SectionTitle
import app.valence.ui.components.TrackRow
import app.valence.ui.components.formatTotal
import app.valence.ui.components.songs
import app.valence.ui.components.subtitle
import app.valence.ui.rememberFlow
import java.text.DateFormat
import java.util.Date

@Composable
fun DetailTopBar(title: String, onMenu: (() -> Unit)? = null, actions: @Composable () -> Unit = {}) {
    val ui = LocalUi.current
    Row(Modifier.fillMaxWidth().statusBarsPadding().padding(horizontal = 4.dp), verticalAlignment = Alignment.CenterVertically) {
        IconButton(onClick = { ui.nav.popBackStack() }) { Icon(Icons.AutoMirrored.Rounded.ArrowBack, "Back") }
        Text(title, style = MaterialTheme.typography.titleLarge, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
        actions()
        if (onMenu != null) IconButton(onClick = onMenu) { Icon(Icons.Rounded.MoreVert, "More") }
    }
}

/** Big art + title block at the top of a detail page. */
@Composable
fun DetailHeader(artTrackId: Long?, title: String, lines: List<String>, onLine: List<(() -> Unit)?> = emptyList(), circle: Boolean = false, icon: androidx.compose.ui.graphics.vector.ImageVector = Icons.Rounded.Album) {
    Column(Modifier.fillMaxWidth().padding(horizontal = 24.dp, vertical = 8.dp), horizontalAlignment = Alignment.CenterHorizontally) {
        Art(artTrackId, Modifier.size(240.dp), if (circle) CircleShape else RoundedCornerShape(12.dp), icon, 64.dp)
        Spacer(Modifier.height(14.dp))
        Text(title, style = MaterialTheme.typography.headlineSmall, textAlign = TextAlign.Center, maxLines = 3, overflow = TextOverflow.Ellipsis)
        lines.forEachIndexed { i, line ->
            val click = onLine.getOrNull(i)
            Text(
                line,
                style = if (i == 0) MaterialTheme.typography.titleMedium else MaterialTheme.typography.bodyMedium,
                color = if (i == 0 && click != null) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant,
                textAlign = TextAlign.Center,
                modifier = Modifier.padding(top = 2.dp).let { if (click != null) it.clickable(onClick = click) else it },
            )
        }
    }
}

@Composable
private fun LikeButton(liked: Boolean, onToggle: () -> Unit) {
    IconButton(onClick = onToggle) {
        Icon(if (liked) Icons.Rounded.Favorite else Icons.Rounded.FavoriteBorder, if (liked) "Unlike" else "Like", tint = if (liked) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

/** A plain list of songs under a header; used by most detail pages. */
@Composable
fun TrackListPage(
    title: String,
    tracks: List<Track>?,
    label: String,
    bottomPadding: PaddingValues,
    header: @Composable () -> Unit = {},
    numbered: Boolean = false,
    showArt: Boolean = true,
    discHeaders: Boolean = false,
    playlistId: String? = null,
    menu: MenuTarget? = null,
    empty: @Composable () -> Unit = { EmptyState(Icons.AutoMirrored.Rounded.QueueMusic, "No songs") },
    actions: @Composable () -> Unit = {},
    subtitle: ((Track) -> String)? = null,
    trailing: ((Track) -> (@Composable () -> Unit)?)? = null,
) {
    val ui = LocalUi.current
    val current by ui.playback.current.collectAsState()
    Column(Modifier.fillMaxSize()) {
        val target = menu ?: tracks?.takeIf { it.isNotEmpty() }?.let { MenuTarget.Songs(label, it) }
        DetailTopBar(title, onMenu = target?.let { { ui.menu = it } }, actions = actions)
        if (tracks == null) return@Column
        if (tracks.isEmpty()) { header(); empty(); return@Column }
        val state = rememberLazyListState()
        val multiDisc = discHeaders && tracks.mapNotNull { it.discNo }.distinct().size > 1
        Box(Modifier.fillMaxSize()) {
            LazyColumn(state = state, contentPadding = bottomPadding) {
                item(key = "h:header") { header() }
                // The header above already says how many songs there are.
                item(key = "h:bar") { PlayShuffleBar(tracks.size, 0, onPlay = { ui.play(tracks, 0, label) }, onShuffle = { ui.shuffle(tracks, label) }, showCount = false) }
                var lastDisc: Int? = null
                tracks.forEachIndexed { i, t ->
                    if (multiDisc && t.discNo != lastDisc) {
                        lastDisc = t.discNo
                        item(key = "h:disc$i") { SectionTitle("Disc ${t.discNo ?: 1}") }
                    }
                    item(key = "t:$i:${t.id}") {
                        TrackRow(
                            t,
                            onClick = { ui.play(tracks, i, label) },
                            playing = current?.id == t.id,
                            showArt = showArt,
                            number = if (numbered) (t.trackNo ?: (i + 1)) else null,
                            subtitle = subtitle?.invoke(t) ?: t.subtitle(),
                            onMenu = { ui.menu = MenuTarget.Song(t, tracks, label, playlistId) },
                            trailing = trailing?.invoke(t),
                        )
                    }
                }
            }
            if (!numbered) FastScroller(state, tracks.size + 2, label = { "" })
        }
    }
}

@Composable
fun AlbumScreen(id: Long, bottomPadding: PaddingValues) {
    val ui = LocalUi.current
    val album by rememberFlow("album:$id", null) { ui.library.album(id) }
    val tracks by rememberFlow("albumTracks:$id", null) { ui.library.albumTracks(id) }
    val a = album
    val list = tracks
    TrackListPage(
        title = "",
        tracks = list,
        label = a?.title ?: "",
        bottomPadding = bottomPadding,
        numbered = a?.hqRip != "YouTube",
        showArt = a?.hqRip == "YouTube", // season albums: every rip has its own thumbnail
        discHeaders = true,
        menu = a?.let { MenuTarget.AlbumMenu(it) },
        actions = { if (a != null) LikeButton(a.liked) { ui.app.sync.setAlbumLiked(a, !a.liked) } },
        header = {
            if (a != null) DetailHeader(
                a.artTrackId, a.title,
                listOfNotNull(a.albumArtist, listOfNotNull(a.year?.toString(), a.genre, songs(a.trackCount), formatTotal(a.durationMs)).joinToString(" · ")),
                onLine = listOf({ ui.artist(a.albumArtist) }, null),
            )
        },
        subtitle = { t -> if (t.isRip) (t.ripGame ?: t.artist) else if (t.artist != a?.albumArtist) t.artist else (t.composer ?: t.artist) },
    )
}

@Composable
fun ArtistScreen(name: String, bottomPadding: PaddingValues) {
    val ui = LocalUi.current
    val artist by rememberFlow("artist:$name", null) { ui.library.artist(name) }
    val albums by rememberFlow("artistAlbums:$name", null) { ui.library.artistAlbums(name) }
    val tracks by rememberFlow("artistTracks:$name", null) { ui.library.artistTracks(name) }
    val ar = artist
    TrackListPage(
        title = "",
        tracks = tracks,
        label = name,
        bottomPadding = bottomPadding,
        actions = { if (ar != null) LikeButton(ar.liked) { ui.app.sync.setArtistLiked(name, !ar.liked) } },
        header = {
            DetailHeader(ar?.artTrackId, name, listOfNotNull(ar?.let { "${if (it.albumCount == 1) "1 album" else "${it.albumCount} albums"} · ${songs(it.trackCount)}" }), circle = true, icon = Icons.Rounded.Person)
            val al = albums.orEmpty()
            if (al.isNotEmpty()) {
                SectionTitle("Albums")
                LazyRow(contentPadding = PaddingValues(horizontal = 10.dp)) {
                    items(al, key = { it.id }) { a ->
                        AlbumCard(a, onClick = { ui.album(a.id) }, onLongClick = { ui.menu = MenuTarget.AlbumMenu(a) }, modifier = Modifier.width(150.dp), subtitle = a.year?.toString() ?: songs(a.trackCount))
                    }
                }
                SectionTitle("Songs")
            }
        },
    )
}

@Composable
fun GenreScreen(name: String, bottomPadding: PaddingValues) {
    val ui = LocalUi.current
    val tracks by rememberFlow("genre:$name", null) { ui.library.genreTracks(name, Collection.All) }
    TrackListPage(name, tracks, name, bottomPadding, header = { DetailHeader(tracks?.firstOrNull { it.hasArt }?.id, name, listOf(songs(tracks?.size ?: 0)), icon = Icons.Rounded.Sell) })
}

@Composable
fun GameScreen(name: String, bottomPadding: PaddingValues) {
    val ui = LocalUi.current
    val tracks by rememberFlow("game:$name", null) { ui.library.gameTracks(name) }
    TrackListPage(
        name, tracks, name, bottomPadding,
        header = { DetailHeader(tracks?.firstOrNull { it.hasArt }?.id, name, listOf(if (tracks?.size == 1) "1 rip" else "${tracks?.size ?: 0} rips"), icon = Icons.Rounded.SportsEsports) },
        subtitle = { t -> t.album.ifBlank { t.artist } },
    )
}

@Composable
fun FolderScreen(path: String, bottomPadding: PaddingValues) {
    val parts = path.split('/').filter { it.isNotEmpty() }
    val ui = LocalUi.current
    Column(Modifier.fillMaxSize()) {
        DetailTopBar(parts.lastOrNull() ?: "Music")
        Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = 16.dp, vertical = 2.dp), horizontalArrangement = Arrangement.spacedBy(4.dp)) {
            Text("Music", color = MaterialTheme.colorScheme.primary, style = MaterialTheme.typography.bodySmall, modifier = Modifier.clickable { ui.folder("") })
            parts.forEachIndexed { i, p ->
                Text("›", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                Text(p, style = MaterialTheme.typography.bodySmall, color = if (i == parts.lastIndex) MaterialTheme.colorScheme.onSurface else MaterialTheme.colorScheme.primary,
                    modifier = Modifier.clickable { ui.folder(parts.take(i + 1).joinToString("/")) })
            }
        }
        FolderList(path, bottomPadding)
    }
}

@Composable
fun PlaylistScreen(id: String, bottomPadding: PaddingValues) {
    val ui = LocalUi.current
    val playlist by rememberFlow("playlist:$id", null) { ui.library.playlist(id) }
    val tracks by rememberFlow("playlistTracks:$id", null) { ui.library.playlistTracks(id) }
    val p = playlist
    val kindLine = when (p?.kind) {
        "smart" -> "Smart playlist"
        "mirror" -> "Mirrored from the desktop · read-only"
        else -> null
    }
    TrackListPage(
        p?.name ?: "", tracks, p?.name ?: "", bottomPadding,
        playlistId = if (p?.editable == true) id else null,
        menu = p?.let { MenuTarget.PlaylistMenu(it, tracks.orEmpty()) },
        header = {
            if (p != null) DetailHeader(
                tracks?.firstOrNull { it.hasArt }?.id, p.name,
                listOfNotNull(songs(tracks?.size ?: 0) + (tracks?.sumOf { it.durationMs }?.let { " · ${formatTotal(it)}" } ?: ""), kindLine,
                    (p.itemCount - (tracks?.size ?: 0)).takeIf { it > 0 && p.kind != "smart" }?.let { "$it not on this phone" }),
                icon = if (p.kind == "smart") Icons.Rounded.AutoAwesome else if (p.kind == "mirror") Icons.Rounded.Sync else Icons.AutoMirrored.Rounded.QueueMusic,
            )
        },
        empty = { EmptyState(Icons.AutoMirrored.Rounded.QueueMusic, "Empty playlist", if (p?.editable == true) "Add songs from any song's menu." else null) },
    )
}

@Composable
fun AutoListScreen(name: String, bottomPadding: PaddingValues) {
    val ui = LocalUi.current
    if (name == "History") return HistoryScreen(bottomPadding)
    val list = runCatching { AutoList.valueOf(name) }.getOrNull() ?: return
    val tracks by rememberFlow("auto:$name", null) { ui.library.autoList(list, Collection.All.takeIf { list == AutoList.Liked } ?: Collection.Main) }
    TrackListPage(
        list.title, tracks, list.title, bottomPadding,
        header = { DetailHeader(tracks?.firstOrNull { it.hasArt }?.id, list.title, listOf(songs(tracks?.size ?: 0)), icon = Icons.AutoMirrored.Rounded.QueueMusic) },
        trailing = if (list == AutoList.MostPlayed) ({ t -> { Text("${t.playCount}×", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(start = 8.dp)) } }) else null,
    )
}

@Composable
fun HistoryScreen(bottomPadding: PaddingValues) {
    val ui = LocalUi.current
    val history by rememberFlow("history", null) { ui.library.history() }
    val current by ui.playback.current.collectAsState()
    val fmt = DateFormat.getDateTimeInstance(DateFormat.MEDIUM, DateFormat.SHORT)
    Column(Modifier.fillMaxSize()) {
        DetailTopBar("History")
        val h = history ?: return@Column
        if (h.isEmpty()) return@Column EmptyState(Icons.Rounded.History, "Nothing played yet", "Plays from all your devices show up here.")
        val tracks = h.map { it.first }
        LazyColumn(contentPadding = bottomPadding) {
            itemsIndexed(h, key = { i, _ -> i }) { i, (t, at) ->
                TrackRow(t, onClick = { ui.play(tracks, i, "History") }, playing = current?.id == t.id, subtitle = "${t.artist} · ${fmt.format(Date(at))}", onMenu = { ui.menu = MenuTarget.Song(t, tracks, "History") })
            }
        }
    }
}

