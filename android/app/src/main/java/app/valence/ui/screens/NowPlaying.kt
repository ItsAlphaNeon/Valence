package app.valence.ui.screens

import android.content.Context
import android.media.AudioManager
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.basicMarquee
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.detectHorizontalDragGestures
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.gestures.waitForUpOrCancellation
import androidx.compose.foundation.indication
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.PressInteraction
import androidx.compose.foundation.layout.Arrangement
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
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.PlaylistAdd
import androidx.compose.material.icons.automirrored.rounded.VolumeUp
import androidx.compose.material.icons.rounded.BarChart
import androidx.compose.material.icons.rounded.Cast
import androidx.compose.material.icons.rounded.CastConnected
import androidx.compose.material.icons.rounded.Favorite
import androidx.compose.material.icons.rounded.FavoriteBorder
import androidx.compose.material.icons.rounded.Info
import androidx.compose.material.icons.rounded.Lyrics
import androidx.compose.material.icons.rounded.MusicNote
import androidx.compose.material.icons.rounded.Pause
import androidx.compose.material.icons.rounded.PlayArrow
import androidx.compose.material.icons.rounded.Repeat
import androidx.compose.material.icons.rounded.RepeatOne
import androidx.compose.material.icons.rounded.Shuffle
import androidx.compose.material.icons.rounded.SkipNext
import androidx.compose.material.icons.rounded.SkipPrevious
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.material3.ripple
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.State
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.media3.common.Player
import app.valence.art.TrackArt
import app.valence.core.parseLrc
import app.valence.data.Track
import app.valence.tags.TagReader
import app.valence.ui.LocalUi
import app.valence.ui.MenuTarget
import app.valence.ui.Overlay
import app.valence.ui.Tab
import app.valence.ui.components.IconAction
import app.valence.ui.components.OptionsButton
import app.valence.ui.components.formatDuration
import coil3.compose.AsyncImage
import coil3.memory.MemoryCache
import coil3.request.ImageRequest
import coil3.request.crossfade
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlin.math.abs

private val Dim = Color.White.copy(alpha = 0.78f)
private val Faint = Color.White.copy(alpha = 0.45f)

/** Playback position, refreshed 4×/s while playing (and [active]); read it in draw code where possible. */
@Composable
private fun rememberPosition(active: Boolean): State<Long> {
    val pb = LocalUi.current.playback
    val playing by pb.isPlaying.collectAsState()
    val current by pb.current.collectAsState()
    return produceState(pb.positionMs, playing, current?.id, active) {
        value = pb.positionMs
        while (isActive && playing && active) {
            delay(250)
            value = pb.positionMs
        }
    }
}

/** Musicolet's Now playing tab. Drawn over the blurred cover the shell paints behind it. */
@Composable
fun PlayerPage() {
    val ui = LocalUi.current
    val pb = ui.playback
    val track by pb.current.collectAsState()
    val active = ui.currentTab == Tab.Player
    val keepOn by ui.app.prefs.keepScreenOn.flow.collectAsState()
    val view = LocalView.current
    LaunchedEffect(keepOn, active) { view.keepScreenOn = keepOn && active }
    val t = track
    if (t == null) {
        Column(Modifier.fillMaxSize().statusBarsPadding().padding(32.dp), verticalArrangement = Arrangement.Center, horizontalAlignment = Alignment.CenterHorizontally) {
            Icon(Icons.Rounded.MusicNote, null, Modifier.size(64.dp), tint = Faint)
            Spacer(Modifier.height(12.dp))
            Text("Nothing playing", style = TextStyle(fontSize = 20.sp, fontWeight = FontWeight.Bold), color = Color.White)
            Spacer(Modifier.height(6.dp))
            Text("Pick a song in Albums, Artists, Folders or Playlists.", style = TextStyle(fontSize = 15.sp), color = Dim, textAlign = TextAlign.Center)
        }
        return
    }
    val artTap by ui.app.prefs.artTap.flow.collectAsState()
    var lyrics by rememberSaveable { mutableStateOf(false) }
    val position = rememberPosition(active)
    Column(Modifier.fillMaxSize().statusBarsPadding()) {
        Box(Modifier.weight(1f).fillMaxWidth().padding(start = 24.dp, end = 24.dp, top = 10.dp, bottom = 6.dp), contentAlignment = Alignment.Center) {
            if (lyrics) LyricsView(t, position, Modifier.fillMaxSize()) { lyrics = false }
            else BigArt(t) {
                when (artTap) {
                    "lyrics" -> lyrics = true
                    "play" -> pb.toggle()
                }
            }
        }
        TitleBlock(t)
        QuickRow(t)
        SeekRow(position)
        Controls()
        Spacer(Modifier.height(10.dp))
    }
}

@Composable
private fun BigArt(t: Track, onTap: () -> Unit) {
    val pb = LocalUi.current.playback
    val ctx = LocalContext.current
    val offset = remember { Animatable(0f) }
    val scope = rememberCoroutineScope()
    // Show the last cover until the new one is decoded, then crossfade (no flash of grey).
    var lastKey by remember { mutableStateOf<MemoryCache.Key?>(null) }
    val request = remember(t.id, t.hasArt) {
        if (!t.hasArt) null else ImageRequest.Builder(ctx).data(TrackArt(t.id)).placeholderMemoryCacheKey(lastKey).crossfade(220).build()
    }
    Box(
        Modifier
            .aspectRatio(1f)
            .graphicsLayer {
                translationX = offset.value
                alpha = 1f - (abs(offset.value) / (size.width.coerceAtLeast(1f))) * 0.7f
            }
            .pointerInput(Unit) {
                detectHorizontalDragGestures(
                    onDragEnd = {
                        val w = size.width.toFloat()
                        val x = offset.value
                        scope.launch {
                            when {
                                x < -w * 0.22f -> { pb.next(); offset.snapTo(w * 0.35f); offset.animateTo(0f, tween(180)) }
                                x > w * 0.22f -> { pb.previous(); offset.snapTo(-w * 0.35f); offset.animateTo(0f, tween(180)) }
                                else -> offset.animateTo(0f, tween(160))
                            }
                        }
                    },
                    onDragCancel = { scope.launch { offset.animateTo(0f, tween(160)) } },
                ) { change, dx ->
                    change.consume()
                    scope.launch { offset.snapTo(offset.value + dx) }
                }
            }
            .pointerInput(onTap) { detectTapGestures(onTap = { onTap() }) }
            .clip(RoundedCornerShape(2.dp))
            .background(Color.Black.copy(alpha = 0.25f)),
        contentAlignment = Alignment.Center,
    ) {
        if (request == null) Icon(Icons.Rounded.MusicNote, null, Modifier.size(96.dp), tint = Faint)
        else AsyncImage(
            request, contentDescription = "Album art", contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize(),
            onSuccess = { lastKey = it.result.memoryCacheKey },
        )
    }
}

@Composable
private fun TitleBlock(t: Track) {
    val ui = LocalUi.current
    val artistLine = if (t.isRip) t.ripGame?.takeIf { it.isNotBlank() } ?: t.artist else t.artist
    Column(Modifier.fillMaxWidth().padding(horizontal = 12.dp), horizontalAlignment = Alignment.CenterHorizontally) {
        Text(
            t.title, style = TextStyle(fontSize = 22.sp, fontWeight = FontWeight.Bold), color = Color.White, maxLines = 1,
            modifier = Modifier.basicMarquee(iterations = Int.MAX_VALUE, initialDelayMillis = 2000),
        )
        Text(
            artistLine, style = TextStyle(fontSize = 17.sp), color = Dim, maxLines = 1, overflow = TextOverflow.Ellipsis,
            modifier = Modifier.clickable { if (t.isRip && !t.ripGame.isNullOrBlank()) ui.game(t.ripGame) else ui.artist(t.artist, "track") }.padding(vertical = 3.dp),
        )
        if (t.album.isNotBlank()) Text(
            t.album, style = TextStyle(fontSize = 17.sp), color = Dim, maxLines = 1, overflow = TextOverflow.Ellipsis,
            modifier = Modifier.clickable { ui.album(t.albumId) }.padding(vertical = 3.dp),
        )
    }
}

@Composable
private fun QuickRow(t: Track) {
    val ui = LocalUi.current
    val pb = ui.playback
    val fresh by remember(t.id) { ui.library.watchTrack(t.id) }.collectAsState(t)
    val liked = fresh?.liked ?: t.liked
    val repeat by pb.repeat.collectAsState()
    val shuffle by pb.shuffle.collectAsState()
    val canCast by ui.app.cast.available.collectAsState()
    val tv by ui.app.cast.tvName.collectAsState()
    Row(Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
        IconAction(if (liked) Icons.Rounded.Favorite else Icons.Rounded.FavoriteBorder, if (liked) "Remove from favorites" else "Add to favorites", { ui.app.sync.setTrackLiked(t, !liked) }, tint = if (liked) Color.White else Dim)
        IconAction(Icons.Rounded.Info, "Song info", { ui.info = t }, tint = Dim)
        IconAction(Icons.AutoMirrored.Rounded.PlaylistAdd, "Add to playlists", { ui.addToPlaylist = listOf(t) }, tint = Dim)
        OptionsButton({ ui.menu = MenuTarget.Song(t, queueIndex = pb.index.value) }, color = Dim)
        Spacer(Modifier.weight(1f))
        if (canCast) IconAction(
            if (tv != null) Icons.Rounded.CastConnected else Icons.Rounded.Cast,
            if (tv != null) "Casting to $tv" else "Cast to a TV",
            { ui.castDialog = true },
            tint = if (tv != null) Color.White else Dim,
        )
        IconAction(
            if (repeat == Player.REPEAT_MODE_ONE) Icons.Rounded.RepeatOne else Icons.Rounded.Repeat,
            when (repeat) { Player.REPEAT_MODE_ONE -> "Repeat song"; Player.REPEAT_MODE_ALL -> "Repeat queue"; else -> "No repeat" },
            pb::cycleRepeat,
            tint = if (repeat == Player.REPEAT_MODE_OFF) Faint else Dim,
        )
        IconAction(Icons.Rounded.Shuffle, if (shuffle) "Shuffle on" else "Shuffle off", pb::toggleShuffle, tint = if (shuffle) Dim else Faint)
    }
}

@Composable
private fun SeekRow(position: State<Long>) {
    val pb = LocalUi.current.playback
    val current by pb.current.collectAsState()
    var seeking by remember { mutableStateOf<Float?>(null) }
    var remaining by rememberSaveable { mutableStateOf(false) }
    val dur = pb.durationMs.takeIf { it > 0 } ?: current?.durationMs ?: 0L
    val shownSec by remember(dur) { derivedStateOf { (seeking?.let { (it * dur).toLong() } ?: position.value) / 1000 } }
    val time = TextStyle(fontSize = 15.sp, textAlign = TextAlign.Center)
    Row(Modifier.fillMaxWidth().padding(horizontal = 4.dp).height(48.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(
            if (remaining) "-" + formatDuration((dur - shownSec * 1000).coerceAtLeast(0)) else formatDuration(shownSec * 1000),
            style = time, color = Color.White, maxLines = 1,
            modifier = Modifier.width(60.dp).clickable { remaining = !remaining },
        )
        Box(
            Modifier
                .weight(1f)
                .height(40.dp)
                .pointerInput(dur) {
                    detectTapGestures { o -> if (dur > 0) pb.seekTo(((o.x / size.width).coerceIn(0f, 1f) * dur).toLong()) }
                }
                .pointerInput(dur) {
                    detectHorizontalDragGestures(
                        onDragStart = { o -> seeking = (o.x / size.width).coerceIn(0f, 1f) },
                        onDragEnd = { seeking?.let { if (dur > 0) pb.seekTo((it * dur).toLong()) }; seeking = null },
                        onDragCancel = { seeking = null },
                    ) { change, _ ->
                        change.consume()
                        seeking = (change.position.x / size.width).coerceIn(0f, 1f)
                    }
                }
                .drawBehind {
                    // Drawn, not composed: the 4×/s position updates only redraw this strip.
                    val f = seeking ?: if (dur > 0) (position.value.toFloat() / dur).coerceIn(0f, 1f) else 0f
                    val h = 3.dp.toPx()
                    val r = 9.dp.toPx()
                    val y = size.height / 2
                    val left = r
                    val w = size.width - 2 * r
                    drawRoundRect(Color.White.copy(alpha = 0.28f), Offset(left, y - h / 2), Size(w, h), CornerRadius(h / 2))
                    drawRoundRect(Color.White.copy(alpha = 0.9f), Offset(left, y - h / 2), Size(w * f, h), CornerRadius(h / 2))
                    drawCircle(Color.White, r, Offset(left + w * f, y))
                },
        )
        Text(formatDuration(dur), style = time, color = Color.White, maxLines = 1, modifier = Modifier.width(60.dp))
    }
}

@Composable
private fun Controls() {
    val ui = LocalUi.current
    val pb = ui.playback
    val ctx = LocalContext.current
    val playing by pb.isPlaying.collectAsState()
    val tv by ui.app.cast.tvName.collectAsState()
    val casting = tv != null
    val tvLyrics by ui.app.prefs.castLyrics.flow.collectAsState()
    Row(Modifier.fillMaxWidth().padding(horizontal = 8.dp).height(84.dp), horizontalArrangement = Arrangement.SpaceEvenly, verticalAlignment = Alignment.CenterVertically) {
        IconAction(Icons.AutoMirrored.Rounded.VolumeUp, if (casting) "TV volume" else "Volume", {
            if (casting) ui.castDialog = true
            else (ctx.getSystemService(Context.AUDIO_SERVICE) as AudioManager).adjustStreamVolume(AudioManager.STREAM_MUSIC, AudioManager.ADJUST_SAME, AudioManager.FLAG_SHOW_UI)
        }, tint = Dim, size = 22.dp)
        HoldButton(Icons.Rounded.SkipPrevious, "Previous song (hold to rewind)", 46.dp, onTap = pb::previous, onHold = { pb.seekTo((pb.positionMs - 5000).coerceAtLeast(0)) })
        HoldButton(if (playing) Icons.Rounded.Pause else Icons.Rounded.PlayArrow, if (playing) "Pause (hold to stop)" else "Play", 72.dp, onTap = pb::toggle, onHoldStart = {
            if (pb.isPlaying.value) pb.toggle()
            pb.seekTo(0)
        })
        HoldButton(Icons.Rounded.SkipNext, "Next song (hold to fast-forward)", 46.dp, onTap = pb::next, onHold = { pb.seekTo(pb.positionMs + 5000) })
        // The equalizer can't reach the TV. Its place goes to the one thing to change there.
        if (casting) IconAction(Icons.Rounded.Lyrics, if (tvLyrics) "Hide lyrics on the TV" else "Show lyrics on the TV", {
            // Google's stock screen can't show them, and the dialog says how to get Valence's.
            if (ui.app.cast.usesStockScreen) ui.castDialog = true else ui.app.prefs.castLyrics.value = !tvLyrics
        }, tint = if (tvLyrics && !ui.app.cast.usesStockScreen) Color.White else Faint, size = 22.dp)
        else IconAction(Icons.Rounded.BarChart, "Equalizer", { ui.show(Overlay.Equalizer) }, tint = Dim, size = 22.dp)
    }
}

/** Tap = [onTap]; hold = [onHoldStart] once, then [onHold] every 200 ms until released (Musicolet's rewind / fast-forward). */
@Composable
private fun HoldButton(icon: ImageVector, description: String, size: Dp, onTap: () -> Unit, onHold: (() -> Unit)? = null, onHoldStart: (() -> Unit)? = null) {
    val scope = rememberCoroutineScope()
    val source = remember { MutableInteractionSource() }
    Box(
        Modifier
            .size(size + 20.dp)
            .indication(source, ripple(bounded = false, radius = (size + 20.dp) / 2))
            .pointerInput(onTap, onHold, onHoldStart) {
                awaitEachGesture {
                    val down = awaitFirstDown()
                    val press = PressInteraction.Press(down.position)
                    scope.launch { source.emit(press) }
                    val up = withTimeoutOrNull(viewConfiguration.longPressTimeoutMillis) { waitForUpOrCancellation() }
                    if (up != null) {
                        scope.launch { source.emit(PressInteraction.Release(press)) }
                        onTap()
                    } else {
                        onHoldStart?.invoke()
                        var job: Job? = null
                        if (onHold != null) job = scope.launch { while (isActive) { onHold(); delay(200) } }
                        waitForUpOrCancellation()
                        job?.cancel()
                        scope.launch { source.emit(PressInteraction.Release(press)) }
                    }
                }
            },
        contentAlignment = Alignment.Center,
    ) {
        Icon(icon, description, Modifier.size(size), tint = Color.White)
    }
}

// ---- Lyrics ------------------------------------------------------------------------------------

@Composable
fun LyricsView(t: Track, position: State<Long>, modifier: Modifier = Modifier, onClose: () -> Unit) {
    val ui = LocalUi.current
    val pb = ui.playback
    val size by ui.app.prefs.lyricsSize.flow.collectAsState()
    val text by produceState<String?>(null, t.id) {
        value = withContext(Dispatchers.IO) { runCatching { TagReader.read(ui.library.fileOf(t)).tags.lyrics }.getOrNull() } ?: ""
    }
    val lyrics = text ?: return
    val close = Modifier.pointerInput(Unit) { detectTapGestures(onDoubleTap = { onClose() }, onLongPress = { onClose() }) }
    if (lyrics.isBlank()) {
        Box(modifier.clickable(onClick = onClose), contentAlignment = Alignment.Center) {
            Text("No lyrics in this song's tags", color = Dim, textAlign = TextAlign.Center, style = TextStyle(fontSize = 16.sp))
        }
        return
    }
    val synced = remember(lyrics) { parseLrc(lyrics) }
    if (synced == null) {
        Text(
            lyrics, modifier.then(close).verticalScroll(rememberScrollState()),
            style = TextStyle(fontSize = (size - 4).sp, lineHeight = (size + 4).sp, textAlign = TextAlign.Center), color = Color.White,
        )
        return
    }
    val current by remember(synced) { derivedStateOf { synced.indexOfLast { it.timeMs <= position.value + 150 } } }
    val state = rememberLazyListState()
    LaunchedEffect(current) {
        if (current >= 0 && !state.isScrollInProgress) state.animateScrollToItem((current - 2).coerceAtLeast(0))
    }
    LazyColumn(modifier.then(close), state = state, contentPadding = PaddingValues(vertical = 60.dp)) {
        itemsIndexed(synced) { i, line ->
            val on = i == current
            Text(
                line.text.ifBlank { "♪" },
                style = TextStyle(fontSize = size.sp, lineHeight = (size + 8).sp, fontWeight = if (on) FontWeight.Bold else FontWeight.Medium, textAlign = TextAlign.Center),
                color = if (on) Color.White else Color.White.copy(alpha = if (abs(i - current) <= 3) 0.6f else 0.38f),
                modifier = Modifier.fillMaxWidth().clickable { pb.seekTo(line.timeMs) }.padding(vertical = 8.dp),
            )
        }
    }
}
