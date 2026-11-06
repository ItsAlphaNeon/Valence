package app.valence.ui

import androidx.activity.compose.BackHandler
import androidx.compose.animation.Crossfade
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.pager.HorizontalPager
import androidx.compose.foundation.pager.PagerState
import androidx.compose.foundation.pager.rememberPagerState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.Alarm
import androidx.compose.material.icons.rounded.BarChart
import androidx.compose.material.icons.rounded.MoreVert
import androidx.compose.material.icons.rounded.Refresh
import androidx.compose.material.icons.rounded.Search
import androidx.compose.material.icons.rounded.Settings
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.Snackbar
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.FilterQuality
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.lerp
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalView
import androidx.core.view.WindowCompat
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.valence.ValenceApp
import app.valence.art.ArtStore
import app.valence.ui.components.IconAction
import app.valence.ui.screens.AddToPlaylistDialog
import app.valence.ui.screens.EqualizerScreen
import app.valence.ui.screens.MenuHost
import app.valence.ui.screens.PlaylistDialogs
import app.valence.ui.screens.SearchScreen
import app.valence.ui.screens.SettingsScreen
import app.valence.ui.screens.CastDialog
import app.valence.ui.screens.SleepDialog
import app.valence.ui.screens.SongInfoDialog
import app.valence.ui.screens.SpeedDialog
import app.valence.ui.screens.TabPage
import app.valence.ui.theme.LocalPalette
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlin.math.abs

@Composable
fun ValenceRoot(app: ValenceApp, openPlayer: Int) {
    val scope = rememberCoroutineScope()
    val ui = remember { UiActions(app, scope) }
    val tabsPref by app.prefs.tabs.flow.collectAsState()
    val tabs = remember(tabsPref) { Tab.parse(tabsPref) }
    CompositionLocalProviderUi(ui) {
        key(tabs) {
            val start = remember { tabs.indexOfFirst { it.key == app.prefs.lastTab.value }.takeIf { it >= 0 } ?: tabs.indexOf(Tab.Player) }
            val pager = rememberPagerState(initialPage = start) { tabs.size }
            ui.pager = pager
            ui.tabs = tabs
            Shell(ui, tabs, pager)
        }
        LaunchedEffect(openPlayer) { if (openPlayer > 0) ui.openPlayer() }
    }
}

@Composable
private fun CompositionLocalProviderUi(ui: UiActions, content: @Composable () -> Unit) =
    androidx.compose.runtime.CompositionLocalProvider(LocalUi provides ui, content = content)

@Composable
private fun Shell(ui: UiActions, tabs: List<Tab>, pager: PagerState) {
    val app = ui.app
    val playerIndex = tabs.indexOf(Tab.Player)
    LaunchedEffect(pager.settledPage) { tabs.getOrNull(pager.settledPage)?.let { app.prefs.lastTab.value = it.key } }

    // How much of the player page is on screen (1 = settled on it): drives the bar's see-through look.
    val nearPlayer = { if (playerIndex < 0) 0f else (1f - abs(pager.currentPage + pager.currentPageOffsetFraction - playerIndex)).coerceIn(0f, 1f) }

    val currentTab = tabs.getOrNull(pager.currentPage)
    val stackDepth = currentTab?.let { ui.stack(it).size } ?: 0
    BackHandler(enabled = ui.overlays.isNotEmpty() || stackDepth > 0) { ui.back() }

    // Light status-bar icons over dark backgrounds (always on the player's darkened cover).
    val dark = LocalPalette.current.dark
    val onPlayer = currentTab == Tab.Player && ui.overlays.isEmpty()
    val view = LocalView.current
    LaunchedEffect(dark, onPlayer) {
        val window = (view.context as? android.app.Activity)?.window ?: return@LaunchedEffect
        WindowCompat.getInsetsController(window, view).apply {
            isAppearanceLightStatusBars = !(dark || onPlayer)
            isAppearanceLightNavigationBars = !(dark || onPlayer)
        }
    }

    val snackbar = remember { SnackbarHostState() }
    val error by app.playback.error.collectAsState()
    LaunchedEffect(error) {
        error?.let {
            snackbar.showSnackbar(it)
            app.playback.clearError()
        }
    }

    Box(Modifier.fillMaxSize().background(LocalPalette.current.bg)) {
        PlayerBackdrop(nearPlayer)
        Column(Modifier.fillMaxSize()) {
            HorizontalPager(
                pager,
                Modifier.weight(1f).fillMaxWidth(),
                beyondViewportPageCount = 1,
                key = { tabs[it].key },
            ) { page -> TabPage(tabs[page]) }
            TabBar(ui, tabs, pager, nearPlayer)
        }
        SnackbarHost(snackbar, Modifier.align(Alignment.BottomCenter).navigationBarsPadding().padding(bottom = 64.dp)) { Snackbar(it) }
        for (o in ui.overlays) key(o) {
            when (o) {
                Overlay.Search -> SearchScreen()
                Overlay.Settings -> SettingsScreen()
                Overlay.Equalizer -> EqualizerScreen()
            }
        }
        MenuHost()
        AddToPlaylistDialog()
        SongInfoDialog()
        PlaylistDialogs()
        if (ui.sleepDialog) SleepDialog { ui.sleepDialog = false }
        if (ui.castDialog) CastDialog { ui.castDialog = false }
        if (ui.speedDialog) SpeedDialog { ui.speedDialog = false }
    }
}

/**
 * The blurred cover behind Now playing. Other tabs are opaque and slide over it; it's only drawn
 * while the player page is (partly) on screen.
 */
@Composable
private fun PlayerBackdrop(nearPlayer: () -> Float) {
    val ui = LocalUi.current
    val pal = LocalPalette.current
    val current by ui.playback.current.collectAsState()
    val id = current?.takeIf { it.hasArt }?.id
    val bitmap by produceState<ImageBitmap?>(null, id) {
        value = id?.let { withContext(Dispatchers.IO) { runCatching { ArtStore.backdrop(it)?.asImageBitmap() }.getOrNull() } }
    }
    Box(Modifier.fillMaxSize().drawWithContent { if (nearPlayer() > 0f) drawContent() }) {
        Crossfade(bitmap, animationSpec = tween(450), label = "backdrop") { b ->
            if (b != null) Image(b, null, Modifier.fillMaxSize(), contentScale = ContentScale.Crop, filterQuality = FilterQuality.High)
            else Box(Modifier.fillMaxSize().background(if (pal.dark) pal.bar else Color(0xFF3A3A3A)))
        }
        Box(Modifier.fillMaxSize().background(Color.Black.copy(alpha = 0.42f)))
    }
}

@Composable
private fun TabBar(ui: UiActions, tabs: List<Tab>, pager: PagerState, nearPlayer: () -> Float) {
    val pal = LocalPalette.current
    val onPlayer = tabs.getOrNull(pager.currentPage) == Tab.Player
    val line = Color.White.copy(alpha = 0.18f)
    Column(
        Modifier
            .fillMaxWidth()
            .drawBehind {
                val t = nearPlayer()
                drawRect(lerp(pal.bar, Color.Transparent, t))
                if (t > 0f) drawRect(line.copy(alpha = line.alpha * t), size = Size(size.width, 1.dp.toPx()))
            }
            .navigationBarsPadding(),
    ) {
        Row(Modifier.fillMaxWidth().height(56.dp), verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.weight(1f).fillMaxHeight()) {
                Row(Modifier.fillMaxSize()) {
                    tabs.forEachIndexed { i, t ->
                        val selected = pager.currentPage == i
                        val tint = when {
                            onPlayer -> if (selected) Color.White else Color.White.copy(alpha = 0.55f)
                            selected -> pal.text
                            else -> pal.text3
                        }
                        IconAction(t.icon, t.label, { ui.tapTab(t) }, Modifier.weight(1f).fillMaxHeight(), tint = tint, size = 26.dp)
                    }
                }
                // The indicator follows the swipe in the draw phase, so paging never recomposes the bar.
                Box(
                    Modifier.fillMaxSize().drawBehind {
                        val w = size.width / tabs.size
                        val x = (pager.currentPage + pager.currentPageOffsetFraction) * w
                        drawRect(lerp(pal.accent, Color.White, nearPlayer()), Offset(x, 0f), Size(w, 3.dp.toPx()))
                    },
                )
            }
            val iconTint = if (onPlayer) Color.White else pal.text
            IconAction(Icons.Rounded.Search, "Search", { ui.show(Overlay.Search) }, tint = iconTint)
            Box {
                IconAction(Icons.Rounded.MoreVert, "Main menu", { ui.mainMenu = true }, tint = iconTint)
                MainMenu(ui)
            }
        }
    }
}

@Composable
private fun MainMenu(ui: UiActions) {
    val pal = LocalPalette.current
    val close = { ui.mainMenu = false }
    DropdownMenu(ui.mainMenu, onDismissRequest = close, containerColor = pal.dialog) {
        @Composable
        fun item(icon: androidx.compose.ui.graphics.vector.ImageVector, text: String, action: () -> Unit) = DropdownMenuItem(
            text = { Text(text, style = TextStyle(fontSize = 16.sp), color = pal.text) },
            leadingIcon = { Icon(icon, null, Modifier.size(24.dp), tint = pal.text2) },
            onClick = { close(); action() },
            modifier = Modifier.padding(end = 24.dp),
        )
        item(Icons.Rounded.BarChart, "Equalizer") { ui.show(Overlay.Equalizer) }
        item(Icons.Rounded.Alarm, "Sleep timer") { ui.sleepDialog = true }
        item(Icons.Rounded.Refresh, "Scan") { ui.app.refresh(force = true) }
        item(Icons.Rounded.Settings, "Settings") { ui.show(Overlay.Settings) }
    }
}
