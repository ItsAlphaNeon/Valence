package app.valence.ui

import android.graphics.BitmapFactory
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutVertically
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.QueueMusic
import androidx.compose.material.icons.rounded.LibraryMusic
import androidx.compose.material.icons.rounded.SportsEsports
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.navigation.NavGraph.Companion.findStartDestination
import androidx.navigation.NavHostController
import androidx.navigation.NavType
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import androidx.navigation.navArgument
import app.valence.ValenceApp
import app.valence.art.ArtStore
import app.valence.ui.screens.AddToPlaylistDialog
import app.valence.ui.screens.AlbumScreen
import app.valence.ui.screens.ArtistScreen
import app.valence.ui.screens.AutoListScreen
import app.valence.ui.screens.EqualizerScreen
import app.valence.ui.screens.FolderScreen
import app.valence.ui.screens.GameScreen
import app.valence.ui.screens.GenreScreen
import app.valence.ui.screens.LibraryScreen
import app.valence.ui.screens.MenuHost
import app.valence.ui.screens.MiniPlayer
import app.valence.ui.screens.NowPlayingScreen
import app.valence.ui.screens.PlaylistScreen
import app.valence.ui.screens.PlaylistsScreen
import app.valence.ui.screens.QueueScreen
import app.valence.ui.screens.RipsScreen
import app.valence.ui.screens.SearchScreen
import app.valence.ui.screens.SettingsScreen
import app.valence.ui.screens.PlaylistDialogs
import app.valence.ui.screens.SongInfoDialog
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlin.math.max
import kotlin.math.min

private data class Tab(val route: String, val label: String, val icon: ImageVector)

/** The two halves the desktop keeps apart (the library and the SiivaGunner rips), plus playlists. */
private val TABS = listOf(
    Tab("library", "Library", Icons.Rounded.LibraryMusic),
    Tab("rips", "SiivaGunner", Icons.Rounded.SportsEsports),
    Tab("playlists", "Playlists", Icons.AutoMirrored.Rounded.QueueMusic),
)

@Composable
fun ValenceRoot(app: ValenceApp, openPlayer: Int) {
    val nav = rememberNavController()
    val ui = remember(nav) { UiActions(app, nav) }
    LaunchedEffect(openPlayer) { if (openPlayer > 0 && app.playback.current.value != null) ui.playerOpen = true }
    CompositionLocalProvider(LocalUi provides ui) {
        val current by app.playback.current.collectAsState()
        val stack by nav.currentBackStack.collectAsState()
        val selected = stack.lastOrNull { e -> TABS.any { it.route == e.destination.route } }?.destination?.route ?: TABS[0].route
        val snackbar = remember { SnackbarHostState() }
        val error by app.playback.error.collectAsState()
        LaunchedEffect(error) {
            error?.let {
                snackbar.showSnackbar(it)
                app.playback.clearError()
            }
        }
        Box(Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background)) {
            Scaffold(
                contentWindowInsets = WindowInsets(0),
                snackbarHost = { SnackbarHost(snackbar) },
                bottomBar = {
                    Column(Modifier.fillMaxWidth()) {
                        if (current != null) MiniPlayer()
                        NavigationBar {
                            for (t in TABS) NavigationBarItem(
                                selected = selected == t.route,
                                onClick = { selectTab(nav, t.route, selected == t.route) },
                                icon = { Icon(t.icon, null) },
                                label = { Text(t.label) },
                            )
                        }
                    }
                },
            ) { padding ->
                val bottom = PaddingValues(bottom = padding.calculateBottomPadding())
                Routes(nav, bottom)
            }
            AnimatedVisibility(
                ui.playerOpen && current != null,
                enter = slideInVertically(tween(280)) { it } + fadeIn(),
                exit = slideOutVertically(tween(240)) { it } + fadeOut(),
            ) { NowPlayingScreen() }
            AnimatedVisibility(
                ui.queueOpen,
                enter = slideInVertically(tween(260)) { it },
                exit = slideOutVertically(tween(220)) { it },
            ) { QueueScreen() }
            MenuHost()
            AddToPlaylistDialog()
            SongInfoDialog()
            PlaylistDialogs()
        }
    }
}

private fun selectTab(nav: NavHostController, route: String, reselect: Boolean) {
    if (reselect) {
        // Tapping the current tab again goes back to its top.
        nav.popBackStack(route, inclusive = false)
        return
    }
    nav.navigate(route) {
        popUpTo(nav.graph.findStartDestination().id) { saveState = true }
        launchSingleTop = true
        restoreState = true
    }
}

@Composable
private fun Routes(nav: NavHostController, bottom: PaddingValues) {
    NavHost(nav, startDestination = "library", modifier = Modifier.fillMaxSize()) {
        composable("library") { LibraryScreen(bottom) }
        composable("rips") { RipsScreen(bottom) }
        composable("playlists") { PlaylistsScreen(bottom) }
        composable("search") { SearchScreen(bottom) }
        composable("settings") { SettingsScreen(bottom) }
        composable("equalizer") { EqualizerScreen(bottom) }
        composable("album/{id}", listOf(navArgument("id") { type = NavType.LongType })) { AlbumScreen(it.arguments!!.getLong("id"), bottom) }
        composable("artist/{name}") { ArtistScreen(it.arguments?.getString("name").orEmpty(), bottom) }
        composable("genre/{name}") { GenreScreen(it.arguments?.getString("name").orEmpty(), bottom) }
        composable("game/{name}") { GameScreen(it.arguments?.getString("name").orEmpty(), bottom) }
        composable("folder/{path}") { FolderScreen(it.arguments?.getString("path").orEmpty().let { p -> if (p == "/") "" else p }, bottom) }
        composable("playlist/{id}") { PlaylistScreen(it.arguments?.getString("id").orEmpty(), bottom) }
        composable("auto/{name}") { AutoListScreen(it.arguments?.getString("name").orEmpty(), bottom) }
    }
}

/** A vivid color from the playing song's cover, for tinting the theme (null when there's no art). */
@Composable
fun rememberArtColor(trackId: Long?): Color? {
    val c by produceState<Color?>(null, trackId) {
        value = trackId?.let { id -> withContext(Dispatchers.IO) { runCatching { accentOf(id) }.getOrNull() } }
    }
    return c
}

private fun accentOf(trackId: Long): Color? {
    val (bytes, _) = ArtStore.bytes(trackId) ?: return null
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
    var sample = 1
    while (max(bounds.outWidth, bounds.outHeight) / (sample * 2) >= 48) sample *= 2
    val bmp = BitmapFactory.decodeByteArray(bytes, 0, bytes.size, BitmapFactory.Options().apply { inSampleSize = sample }) ?: return null
    // Score each pixel by saturation and mid lightness; average the best ones by hue bucket.
    val buckets = Array(12) { FloatArray(4) } // weight, r, g, b
    val hsv = FloatArray(3)
    for (y in 0 until bmp.height step max(1, bmp.height / 48)) for (x in 0 until bmp.width step max(1, bmp.width / 48)) {
        val px = bmp.getPixel(x, y)
        android.graphics.Color.colorToHSV(px, hsv)
        val w = hsv[1] * (1f - kotlin.math.abs(hsv[2] - 0.6f)) // saturated, not too dark or bright
        if (w <= 0.15f) continue
        val b = buckets[min(11, (hsv[0] / 30f).toInt())]
        b[0] += w
        b[1] += w * android.graphics.Color.red(px)
        b[2] += w * android.graphics.Color.green(px)
        b[3] += w * android.graphics.Color.blue(px)
    }
    bmp.recycle()
    val best = buckets.maxBy { it[0] }
    if (best[0] < 1f) return null
    return Color(best[1] / best[0] / 255f, best[2] / best[0] / 255f, best[3] / best[0] / 255f)
}
