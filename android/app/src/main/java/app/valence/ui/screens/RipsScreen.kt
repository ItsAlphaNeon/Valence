package app.valence.ui.screens

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.pager.HorizontalPager
import androidx.compose.foundation.pager.rememberPagerState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.SportsEsports
import androidx.compose.material3.PrimaryScrollableTabRow
import androidx.compose.material3.Tab
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import app.valence.data.Collection
import app.valence.ui.LocalUi
import app.valence.ui.components.EmptyState
import app.valence.ui.components.ListRow
import app.valence.ui.components.SortButton
import app.valence.ui.components.SortOption
import app.valence.ui.rememberFlow
import kotlinx.coroutines.launch

private val RIP_TABS = listOf("Seasons", "Rip albums", "Games", "Rip songs")
val RIP_SORTS = listOf(
    SortOption("uploaded", "Upload date"), SortOption("title", "Title"), SortOption("game", "Game"),
    SortOption("added", "Date added"), SortOption("plays", "Most played"), SortOption("duration", "Length"),
)

/** The SiivaGunner side of the library, kept apart from the main library as on the desktop. */
@Composable
fun RipsScreen(bottomPadding: PaddingValues) {
    val ui = LocalUi.current
    val prefs = ui.app.prefs
    val pager = rememberPagerState(initialPage = prefs.ripsTab.value.coerceIn(0, RIP_TABS.lastIndex)) { RIP_TABS.size }
    val scope = rememberCoroutineScope()
    LaunchedEffect(pager.currentPage) { prefs.ripsTab.value = pager.currentPage }
    val ripSort by prefs.ripSort.flow.collectAsState()
    val grid by prefs.gridAlbums.flow.collectAsState()

    Column(Modifier.fillMaxSize()) {
        SectionHeader("SiivaGunner") {
            if (pager.currentPage == 3) SortButton(RIP_SORTS, ripSort) { prefs.ripSort.value = it }
        }
        PrimaryScrollableTabRow(selectedTabIndex = pager.currentPage, edgePadding = 8.dp, divider = {}) {
            RIP_TABS.forEachIndexed { i, t -> Tab(pager.currentPage == i, onClick = { scope.launch { pager.animateScrollToPage(i) } }, text = { Text(t) }) }
        }
        ScanBanner()
        HorizontalPager(pager, Modifier.fillMaxSize(), beyondViewportPageCount = 1) { page ->
            when (page) {
                0 -> Seasons(grid, bottomPadding)
                1 -> RipAlbums(grid, bottomPadding)
                2 -> Games(bottomPadding)
                3 -> SongList("songs:rips:$ripSort", Collection.Rips, ripSort, "Rips", bottomPadding, rips = true)
            }
        }
    }
}

@Composable
private fun Seasons(grid: Boolean, bottomPadding: PaddingValues) {
    val ui = LocalUi.current
    val seasons by rememberFlow("seasons", null) { ui.library.seasons(ui.app.sync.seasons()) }
    val list = seasons ?: return
    if (list.isEmpty()) return EmptyState(Icons.Rounded.SportsEsports, "No seasons yet", "Rips tagged as YouTube season albums show up here.")
    AlbumsList("seasons", Collection.Rips, "title", grid, bottomPadding, albums = list)
}

@Composable
private fun RipAlbums(grid: Boolean, bottomPadding: PaddingValues) {
    val ui = LocalUi.current
    val albums by rememberFlow("ripAlbums", null) { ui.library.ripAlbums() }
    val list = albums ?: return
    if (list.isEmpty()) return EmptyState(Icons.Rounded.SportsEsports, "No rip albums", "SiIvaGunner and SGFR albums show up here.")
    AlbumsList("ripAlbums", Collection.Rips, "year", grid, bottomPadding, albums = list)
}

@Composable
private fun Games(bottomPadding: PaddingValues) {
    val ui = LocalUi.current
    val games by rememberFlow("ripGames", null) { ui.library.ripGames() }
    val list = games ?: return
    if (list.isEmpty()) return EmptyState(Icons.Rounded.SportsEsports, "No games", "Rips with a game in their tags are grouped here.")
    LazyColumn(contentPadding = bottomPadding) {
        itemsIndexed(list, key = { _, g -> g.name }) { _, g ->
            ListRow(g.name, if (g.trackCount == 1) "1 rip" else "${g.trackCount} rips", onClick = { ui.game(g.name) }, artTrackId = g.artTrackId, icon = Icons.Rounded.SportsEsports)
        }
    }
}

