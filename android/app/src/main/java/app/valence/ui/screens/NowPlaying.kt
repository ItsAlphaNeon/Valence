package app.valence.ui.screens

import androidx.activity.compose.BackHandler
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.background
import androidx.compose.foundation.basicMarquee
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectHorizontalDragGestures
import androidx.compose.foundation.gestures.detectVerticalDragGestures
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
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.QueueMusic
import androidx.compose.material.icons.rounded.Bedtime
import androidx.compose.material.icons.rounded.BedtimeOff
import androidx.compose.material.icons.rounded.Favorite
import androidx.compose.material.icons.rounded.FavoriteBorder
import androidx.compose.material.icons.rounded.KeyboardArrowDown
import androidx.compose.material.icons.rounded.Lyrics
import androidx.compose.material.icons.rounded.MoreVert
import androidx.compose.material.icons.rounded.Pause
import androidx.compose.material.icons.rounded.PlayArrow
import androidx.compose.material.icons.rounded.Repeat
import androidx.compose.material.icons.rounded.RepeatOne
import androidx.compose.material.icons.rounded.Shuffle
import androidx.compose.material.icons.rounded.SkipNext
import androidx.compose.material.icons.rounded.SkipPrevious
import androidx.compose.material.icons.rounded.Speed
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.FilledIconButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.IconButtonDefaults
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Slider
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.media3.common.Player
import app.valence.data.Track
import app.valence.tags.TagReader
import app.valence.ui.LocalUi
import app.valence.ui.MenuTarget
import app.valence.ui.components.Art
import app.valence.ui.components.formatDuration
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.withContext
import java.text.DateFormat
import java.util.Date
import kotlin.math.abs
import kotlin.math.roundToInt

@Composable
private fun rememberPosition(): Long {
    val pb = LocalUi.current.playback
    val playing by pb.isPlaying.collectAsState()
    val current by pb.current.collectAsState()
    val pos by produceState(pb.positionMs, playing, current) {
        value = pb.positionMs
        while (isActive) {
            delay(if (playing) 200 else 1000)
            value = pb.positionMs
        }
    }
    return pos
}

/** Horizontal swipe = next / previous song (on the mini player and the big art). */
private fun Modifier.swipeToSkip(onNext: () -> Unit, onPrevious: () -> Unit, onDrag: (Float) -> Unit = {}) = pointerInput(Unit) {
    var total = 0f
    detectHorizontalDragGestures(
        onDragStart = { total = 0f },
        onDragEnd = {
            if (total < -120) onNext() else if (total > 120) onPrevious()
            total = 0f; onDrag(0f)
        },
        onDragCancel = { total = 0f; onDrag(0f) },
    ) { change, amount ->
        change.consume()
        total += amount
        onDrag(total)
    }
}

@Composable
fun MiniPlayer(modifier: Modifier = Modifier) {
    val ui = LocalUi.current
    val pb = ui.playback
    val track by pb.current.collectAsState()
    val playing by pb.isPlaying.collectAsState()
    val t = track ?: return
    val pos = rememberPosition()
    var drag by remember { mutableFloatStateOf(0f) }
    Surface(
        modifier
            .fillMaxWidth()
            .padding(horizontal = 8.dp)
            .clip(RoundedCornerShape(12.dp))
            .clickable { ui.playerOpen = true }
            .pointerInput(Unit) { detectVerticalDragGestures { _, dy -> if (dy < -12) ui.playerOpen = true } },
        color = MaterialTheme.colorScheme.surfaceContainerHigh,
        tonalElevation = 2.dp,
    ) {
        Column {
            Row(
                Modifier.padding(6.dp).swipeToSkip(pb::next, pb::previous) { drag = it }.offset { IntOffset((drag / 3).roundToInt(), 0) },
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Art(if (t.hasArt) t.id else null, Modifier.size(44.dp), RoundedCornerShape(8.dp))
                Spacer(Modifier.width(12.dp))
                Column(Modifier.weight(1f)) {
                    Text(t.title, maxLines = 1, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.bodyLarge, fontWeight = FontWeight.SemiBold)
                    Text(if (t.isRip) (t.ripGame ?: t.artist) else t.artist, maxLines = 1, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                IconButton(onClick = pb::toggle) { Icon(if (playing) Icons.Rounded.Pause else Icons.Rounded.PlayArrow, if (playing) "Pause" else "Play", Modifier.size(30.dp)) }
                IconButton(onClick = pb::next) { Icon(Icons.Rounded.SkipNext, "Next") }
            }
            val d = pb.durationMs
            LinearProgressIndicator(
                progress = { if (d > 0) (pos.toFloat() / d).coerceIn(0f, 1f) else 0f },
                modifier = Modifier.fillMaxWidth().height(2.dp).padding(horizontal = 12.dp),
                drawStopIndicator = {},
                gapSize = 0.dp,
            )
        }
    }
}

@Composable
fun NowPlayingScreen() {
    val ui = LocalUi.current
    val pb = ui.playback
    val track by pb.current.collectAsState()
    val t = track
    BackHandler { ui.playerOpen = false }
    if (t == null) {
        LaunchedEffect(Unit) { ui.playerOpen = false }
        return
    }
    val keepOn by ui.app.prefs.keepScreenOn.flow.collectAsState()
    val view = LocalView.current
    LaunchedEffect(keepOn) { view.keepScreenOn = keepOn }
    var lyrics by remember { mutableStateOf(false) }
    var dragDown by remember { mutableFloatStateOf(0f) }
    val scheme = MaterialTheme.colorScheme
    Box(
        Modifier
            .fillMaxSize()
            .offset { IntOffset(0, dragDown.roundToInt().coerceAtLeast(0)) }
            .background(Brush.verticalGradient(listOf(scheme.primaryContainer, scheme.background, scheme.background)))
            .pointerInput(Unit) {
                detectVerticalDragGestures(
                    onDragEnd = { if (dragDown > 300) ui.playerOpen = false; dragDown = 0f },
                    onDragCancel = { dragDown = 0f },
                ) { change, dy -> change.consume(); dragDown += dy }
            },
    ) {
        Column(Modifier.fillMaxSize().statusBarsPadding().navigationBarsPadding()) {
            Row(Modifier.fillMaxWidth().padding(horizontal = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                IconButton(onClick = { ui.playerOpen = false }) { Icon(Icons.Rounded.KeyboardArrowDown, "Close", Modifier.size(30.dp)) }
                Column(Modifier.weight(1f), horizontalAlignment = Alignment.CenterHorizontally) {
                    val queues by pb.queues.collectAsState()
                    val active = queues.firstOrNull { it.active }
                    Text("PLAYING FROM", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    Text(active?.name?.ifBlank { null } ?: "Queue", style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
                IconButton(onClick = { ui.menu = MenuTarget.Song(t, queueIndex = pb.index.value) }) { Icon(Icons.Rounded.MoreVert, "More") }
            }
            Box(Modifier.weight(1f).fillMaxWidth().padding(horizontal = 24.dp, vertical = 12.dp), contentAlignment = Alignment.Center) {
                AnimatedContent(lyrics, transitionSpec = { fadeIn() togetherWith fadeOut() }, label = "lyrics") { showLyrics ->
                    if (showLyrics) LyricsView(t, Modifier.fillMaxSize())
                    else {
                        var drag by remember { mutableFloatStateOf(0f) }
                        val scale by animateFloatAsState(if (pb.isPlaying.collectAsState().value) 1f else 0.92f, label = "artScale")
                        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                            Art(
                                if (t.hasArt) t.id else null,
                                Modifier
                                    .fillMaxWidth()
                                    .aspectRatio(1f)
                                    .offset { IntOffset((drag / 2).roundToInt(), 0) }
                                    .let { m -> m.then(Modifier.padding(((1 - scale) * 120).dp)) }
                                    .swipeToSkip(pb::next, pb::previous) { drag = it },
                                RoundedCornerShape(14.dp),
                                iconSize = 96.dp,
                            )
                        }
                    }
                }
            }
            TrackTitle(t)
            SeekBar()
            Controls()
            BottomActions(lyrics, onLyrics = { lyrics = !lyrics })
        }
    }
}

@Composable
private fun TrackTitle(t: Track) {
    val ui = LocalUi.current
    val fresh by remember(t.id) { ui.library.watchTrack(t.id) }.collectAsState(t)
    val liked = fresh?.liked ?: t.liked
    Row(Modifier.fillMaxWidth().padding(horizontal = 24.dp), verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f)) {
            Text(t.title, style = MaterialTheme.typography.headlineSmall, maxLines = 1, modifier = Modifier.basicMarquee())
            Text(
                if (t.isRip) listOfNotNull(t.ripGame, t.album.takeIf { it.isNotBlank() }).joinToString(" · ").ifEmpty { t.artist } else t.artist,
                style = MaterialTheme.typography.titleMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis,
                modifier = Modifier.clickable { if (t.isRip && t.ripGame != null) ui.game(t.ripGame) else ui.artist(t.albumArtist) },
            )
        }
        IconButton(onClick = { ui.app.sync.setTrackLiked(t, !liked) }) {
            Icon(if (liked) Icons.Rounded.Favorite else Icons.Rounded.FavoriteBorder, if (liked) "Unlike" else "Like", Modifier.size(28.dp), tint = if (liked) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

@Composable
private fun SeekBar() {
    val pb = LocalUi.current.playback
    val pos = rememberPosition()
    val dur = pb.durationMs
    var seeking by remember { mutableStateOf<Float?>(null) }
    Column(Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 4.dp)) {
        Slider(
            value = seeking ?: if (dur > 0) (pos.toFloat() / dur).coerceIn(0f, 1f) else 0f,
            onValueChange = { seeking = it },
            onValueChangeFinished = { seeking?.let { pb.seekTo((it * dur).toLong()) }; seeking = null },
        )
        Row(Modifier.fillMaxWidth().padding(horizontal = 4.dp)) {
            Text(formatDuration(seeking?.let { (it * dur).toLong() } ?: pos), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Spacer(Modifier.weight(1f))
            Text("-" + formatDuration((dur - (seeking?.let { (it * dur).toLong() } ?: pos)).coerceAtLeast(0)), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

@Composable
private fun Controls() {
    val pb = LocalUi.current.playback
    val playing by pb.isPlaying.collectAsState()
    val repeat by pb.repeat.collectAsState()
    Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp), horizontalArrangement = Arrangement.SpaceEvenly, verticalAlignment = Alignment.CenterVertically) {
        IconButton(onClick = pb::shuffleQueue) { Icon(Icons.Rounded.Shuffle, "Shuffle queue") }
        IconButton(onClick = pb::previous, Modifier.size(56.dp)) { Icon(Icons.Rounded.SkipPrevious, "Previous", Modifier.size(40.dp)) }
        FilledIconButton(onClick = pb::toggle, Modifier.size(76.dp), shape = CircleShape, colors = IconButtonDefaults.filledIconButtonColors()) {
            Icon(if (playing) Icons.Rounded.Pause else Icons.Rounded.PlayArrow, if (playing) "Pause" else "Play", Modifier.size(44.dp))
        }
        IconButton(onClick = pb::next, Modifier.size(56.dp)) { Icon(Icons.Rounded.SkipNext, "Next", Modifier.size(40.dp)) }
        IconButton(onClick = pb::cycleRepeat) {
            Icon(
                if (repeat == Player.REPEAT_MODE_ONE) Icons.Rounded.RepeatOne else Icons.Rounded.Repeat,
                when (repeat) { Player.REPEAT_MODE_ONE -> "Repeat one"; Player.REPEAT_MODE_ALL -> "Repeat all"; else -> "Repeat off" },
                tint = if (repeat == Player.REPEAT_MODE_OFF) MaterialTheme.colorScheme.onSurfaceVariant else MaterialTheme.colorScheme.primary,
            )
        }
    }
}

@Composable
private fun BottomActions(lyrics: Boolean, onLyrics: () -> Unit) {
    val ui = LocalUi.current
    val pb = ui.playback
    val sleepAt by pb.sleepAt.collectAsState()
    val songsLeft by pb.sleepSongs.collectAsState()
    val afterSong = songsLeft > 0
    val speed by pb.speed.collectAsState()
    var sleepDialog by remember { mutableStateOf(false) }
    var speedDialog by remember { mutableStateOf(false) }
    val on = MaterialTheme.colorScheme.primary
    val off = MaterialTheme.colorScheme.onSurfaceVariant
    Row(Modifier.fillMaxWidth().padding(horizontal = 24.dp, vertical = 8.dp), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
        IconButton(onClick = { sleepDialog = true }) {
            Icon(if (sleepAt != null || afterSong) Icons.Rounded.Bedtime else Icons.Rounded.BedtimeOff, "Sleep timer", tint = if (sleepAt != null || afterSong) on else off)
        }
        TextButton(onClick = { speedDialog = true }) {
            Icon(Icons.Rounded.Speed, null, tint = if (speed != 1f) on else off)
            Text(" ${"%.2f".format(speed).trimEnd('0').trimEnd('.')}×", color = if (speed != 1f) on else off)
        }
        IconButton(onClick = onLyrics) { Icon(Icons.Rounded.Lyrics, "Lyrics", tint = if (lyrics) on else off) }
        IconButton(onClick = { ui.queueOpen = true }) { Icon(Icons.AutoMirrored.Rounded.QueueMusic, "Queue") }
    }
    if (sleepDialog) SleepDialog { sleepDialog = false }
    if (speedDialog) SpeedDialog { speedDialog = false }
}

@Composable
private fun SleepDialog(onDismiss: () -> Unit) {
    val pb = LocalUi.current.playback
    val sleepAt by pb.sleepAt.collectAsState()
    val songsLeft by pb.sleepSongs.collectAsState()
    var minutes by remember { mutableFloatStateOf(30f) }
    var finishSong by remember { mutableStateOf(false) }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Sleep timer") },
        text = {
            Column {
                Text(
                    when {
                        sleepAt != null -> "Playback pauses at ${DateFormat.getTimeInstance(DateFormat.SHORT).format(Date(sleepAt!!))}."
                        songsLeft == 1 -> "Playback pauses at the end of this song."
                        songsLeft > 1 -> "Playback pauses after $songsLeft more songs."
                        else -> "Fade out and pause after a while."
                    },
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Spacer(Modifier.height(12.dp))
                Text("After ${minutes.roundToInt()} minutes", style = MaterialTheme.typography.titleMedium)
                Slider(minutes, { minutes = it }, valueRange = 5f..120f, steps = 22)
                Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.clickable { finishSong = !finishSong }) {
                    androidx.compose.material3.Checkbox(finishSong, { finishSong = it })
                    Text("Let the last song finish")
                }
                Spacer(Modifier.height(8.dp))
                Text("After songs", style = MaterialTheme.typography.titleMedium)
                Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                    TextButton(onClick = { pb.sleepAfterCurrent(); onDismiss() }) { Text("This one") }
                    for (n in listOf(3, 5, 10)) TextButton(onClick = { pb.sleepAfterSongs(n); onDismiss() }) { Text("$n") }
                }
            }
        },
        confirmButton = { TextButton(onClick = { pb.sleepIn(minutes.roundToInt(), finishSong); onDismiss() }) { Text("Start") } },
        dismissButton = {
            if (sleepAt != null || songsLeft > 0) TextButton(onClick = { pb.cancelSleep(); onDismiss() }) { Text("Turn off") }
            else TextButton(onClick = onDismiss) { Text("Cancel") }
        },
    )
}

@Composable
private fun SpeedDialog(onDismiss: () -> Unit) {
    val pb = LocalUi.current.playback
    val speed by pb.speed.collectAsState()
    var value by remember { mutableFloatStateOf(speed) }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Playback speed") },
        text = {
            Column {
                Text("${"%.2f".format(value)}×", style = MaterialTheme.typography.titleMedium)
                Slider(value, { value = (it * 20).roundToInt() / 20f; pb.setSpeed(value) }, valueRange = 0.5f..2f)
                Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                    for (s in listOf(0.75f, 1f, 1.25f, 1.5f)) TextButton(onClick = { value = s; pb.setSpeed(s) }) { Text("$s×") }
                }
            }
        },
        confirmButton = { TextButton(onClick = onDismiss) { Text("Done") } },
    )
}

// ---- Lyrics ------------------------------------------------------------------------------------

data class LyricLine(val timeMs: Long, val text: String)

private val LRC_TIME = Regex("\\[(\\d{1,3}):(\\d{2})(?:[.:](\\d{1,3}))?]")
private val WORD_TIME = Regex("<\\d{1,3}:\\d{2}(?:[.:]\\d{1,3})?>")

/** Parses LRC (synced) lyrics; null when the text isn't LRC. */
fun parseLrc(text: String): List<LyricLine>? {
    val out = ArrayList<LyricLine>()
    var offset = 0L
    for (raw in text.lineSequence()) {
        val line = raw.trim()
        Regex("^\\[offset:\\s*([+-]?\\d+)]", RegexOption.IGNORE_CASE).find(line)?.let { offset = it.groupValues[1].toLongOrNull() ?: 0L }
        val stamps = LRC_TIME.findAll(line).toList()
        if (stamps.isEmpty() || stamps.first().range.first != 0) continue
        val words = line.substring(stamps.last().range.last + 1).replace(WORD_TIME, "").trim()
        for (m in stamps) {
            val min = m.groupValues[1].toLong()
            val sec = m.groupValues[2].toLong()
            val frac = m.groupValues[3]
            val ms = when (frac.length) { 0 -> 0L; 1 -> frac.toLong() * 100; 2 -> frac.toLong() * 10; else -> frac.take(3).toLong() }
            out.add(LyricLine(min * 60_000 + sec * 1000 + ms - offset, words))
        }
    }
    return if (out.isEmpty()) null else out.sortedBy { it.timeMs }
}

@Composable
fun LyricsView(t: Track, modifier: Modifier = Modifier) {
    val ui = LocalUi.current
    val pb = ui.playback
    val size by ui.app.prefs.lyricsSize.flow.collectAsState()
    val text by produceState<String?>(null, t.id) {
        value = withContext(Dispatchers.IO) { runCatching { TagReader.read(ui.library.fileOf(t)).tags.lyrics }.getOrNull() } ?: ""
    }
    val lyrics = text ?: return
    if (lyrics.isBlank()) {
        Box(modifier, contentAlignment = Alignment.Center) {
            Text("No lyrics in this song's tags", color = MaterialTheme.colorScheme.onSurfaceVariant, textAlign = TextAlign.Center)
        }
        return
    }
    val synced = remember(lyrics) { parseLrc(lyrics) }
    if (synced == null) {
        Text(lyrics, modifier.verticalScroll(rememberScrollState()), fontSize = (size - 4).sp, lineHeight = (size + 4).sp, textAlign = TextAlign.Center)
        return
    }
    val pos = rememberPosition()
    val current = synced.indexOfLast { it.timeMs <= pos + 150 }
    val state = rememberLazyListState()
    LaunchedEffect(current) {
        if (current >= 0 && !state.isScrollInProgress) state.animateScrollToItem((current - 2).coerceAtLeast(0))
    }
    LazyColumn(modifier, state = state, contentPadding = PaddingValues(vertical = 80.dp)) {
        itemsIndexed(synced) { i, line ->
            val active = i == current
            Text(
                line.text.ifBlank { "♪" },
                fontSize = size.sp,
                lineHeight = (size + 8).sp,
                fontWeight = if (active) FontWeight.Bold else FontWeight.Medium,
                color = if (active) MaterialTheme.colorScheme.onBackground else MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = if (abs(i - current) <= 3) 0.7f else 0.45f),
                modifier = Modifier.fillMaxWidth().clickable { pb.seekTo(line.timeMs) }.padding(vertical = 8.dp),
            )
        }
    }
}

