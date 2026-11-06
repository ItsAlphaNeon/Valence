package app.valence.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
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
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.QueueMusic
import androidx.compose.material.icons.automirrored.rounded.Sort
import androidx.compose.material.icons.rounded.ArrowDropDown
import androidx.compose.material.icons.rounded.Close
import androidx.compose.material.icons.rounded.Edit
import androidx.compose.material.icons.rounded.PlayArrow
import androidx.compose.material.icons.rounded.Save
import androidx.compose.material.icons.rounded.Timer
import androidx.compose.material3.Icon
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.zIndex
import app.valence.data.Track
import app.valence.playback.QueueSummary
import app.valence.ui.LocalUi
import app.valence.ui.Tab
import app.valence.ui.MenuTarget
import app.valence.ui.components.DialogButtons
import app.valence.ui.components.DialogTitle
import app.valence.ui.components.DragHandle
import app.valence.ui.components.EmptyState
import app.valence.ui.components.FastScroller
import app.valence.ui.components.HDivider
import app.valence.ui.components.IconAction
import app.valence.ui.components.MDialog
import app.valence.ui.components.OptionsButton
import app.valence.ui.components.ScrollStrip
import app.valence.ui.components.SongRow
import app.valence.ui.components.SortDialog
import app.valence.ui.components.formatDuration
import app.valence.ui.components.reorderHandle
import app.valence.ui.components.rememberReorderState
import app.valence.ui.theme.LocalPalette
import kotlin.coroutines.resume
import kotlin.coroutines.suspendCoroutine

/** Musicolet's Queues tab: pick a queue at the top, its songs below (drag the handles to reorder). */
@Composable
fun QueuesPage() {
    val ui = LocalUi.current
    val pb = ui.playback
    val pal = LocalPalette.current
    val queue by pb.queue.collectAsState()
    val index by pb.index.collectAsState()
    val queues by pb.queues.collectAsState()
    val playing by pb.isPlaying.collectAsState()
    var viewing by rememberSaveable { mutableStateOf<Long?>(null) }
    // Tapping the Queues tab while on it goes back to the playing queue (this tab's first page).
    val reselect = ui.reselects[Tab.Queues] ?: 0
    val seenReselect = remember { reselect }
    LaunchedEffect(reselect) { if (reselect != seenReselect) viewing = null }
    var picking by remember { mutableStateOf(false) }
    var sorting by remember { mutableStateOf(false) }
    val active = queues.firstOrNull { it.active }
    val shown = queues.firstOrNull { it.id == viewing } ?: active
    val isActive = shown != null && shown.id == active?.id
    val other by produceState<List<Track>?>(null, shown?.id, isActive, shown?.count) {
        value = if (shown == null || isActive) null else suspendCoroutine { c -> pb.queueTracks(shown.id) { c.resume(it) } }
    }
    val list = if (isActive) queue else other.orEmpty()
    val number = shown?.let { q -> queues.indexOfFirst { it.id == q.id } + 1 } ?: 0
    val name = shown?.name?.ifBlank { "Queue" } ?: "Queue"

    Column(Modifier.fillMaxSize().background(pal.bg).statusBarsPadding()) {
        Row(Modifier.fillMaxWidth().height(58.dp).padding(start = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            Row(
                Modifier
                    .weight(1f)
                    .height(46.dp)
                    .clip(RoundedCornerShape(8.dp))
                    .border(1.dp, pal.outline, RoundedCornerShape(8.dp))
                    .clickable(enabled = queues.isNotEmpty()) { picking = true }
                    .padding(start = 12.dp, end = 6.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    if (shown == null) "No queue" else "$number. $name",
                    style = TextStyle(fontSize = 18.sp, fontWeight = FontWeight.Bold), color = pal.text,
                    maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f),
                )
                Icon(Icons.Rounded.ArrowDropDown, null, Modifier.size(28.dp), tint = pal.text)
            }
            IconAction(Icons.Rounded.Close, "Remove selected queue", { shown?.let { pb.deleteQueue(it.id); viewing = null } }, enabled = shown != null)
        }
        Row(Modifier.fillMaxWidth().height(50.dp), verticalAlignment = Alignment.CenterVertically) {
            IconAction(Icons.Rounded.PlayArrow, "Resume selected queue", {
                when {
                    shown == null -> {}
                    !isActive -> { pb.switchQueue(shown.id, shown.index); viewing = null }
                    !playing -> pb.toggle()
                }
            }, enabled = shown != null)
            IconAction(Icons.AutoMirrored.Rounded.Sort, "Sort songs in selected queue", { sorting = true }, enabled = isActive && list.size > 1)
            Column(Modifier.weight(1f), horizontalAlignment = Alignment.CenterHorizontally) {
                val at = if (isActive) index else (shown?.index ?: 0)
                Text(if (list.isEmpty()) "0 / 0" else "${at + 1} / ${list.size}", style = TextStyle(fontSize = 15.sp, fontWeight = FontWeight.Bold), color = pal.text)
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Icon(Icons.Rounded.Timer, null, Modifier.size(13.dp), tint = pal.text2)
                    Spacer(Modifier.width(3.dp))
                    Text(formatDuration(list.drop(at).sumOf { it.durationMs }), style = TextStyle(fontSize = 13.sp), color = pal.text2)
                }
            }
            IconAction(Icons.Rounded.Save, "Save selected queue as a playlist", { if (list.isNotEmpty()) ui.addToPlaylist = list }, enabled = list.isNotEmpty())
            OptionsButton({ if (list.isNotEmpty()) ui.menu = MenuTarget.Songs(name, list) })
        }
        HDivider()
        if (shown == null || list.isEmpty()) {
            if (shown == null || (isActive || other != null)) EmptyState(Icons.AutoMirrored.Rounded.QueueMusic, "Queue is empty", "Tap a song anywhere to start a queue named after its list.")
            return@Column
        }
        QueueList(shown, list, isActive, if (isActive) index else shown.index) { viewing = null }
    }
    if (picking) QueuePicker(queues, shown?.id, onPick = { viewing = it; picking = false }) { picking = false }
    if (sorting) SortDialog("Sort songs in queue by…", SONG_SORTS, "", { key ->
        val sorted = sortTracks(queue.withIndex().map { it.value }, key)
        // Map back to positions (songs can repeat in a queue).
        val left = queue.withIndex().groupBy({ it.value.id }, { it.index }).mapValues { ArrayDeque(it.value) }
        pb.sortQueue(sorted.map { left.getValue(it.id).removeFirst() })
    }) { sorting = false }
}

@Composable
private fun QueueList(q: QueueSummary, list: List<Track>, isActive: Boolean, current: Int, onSwitched: () -> Unit) {
    val ui = LocalUi.current
    val pb = ui.playback
    // Keys survive moves: a song's id plus which copy of it this is.
    val keys = remember(list) {
        val seen = HashMap<Long, Int>()
        list.map { t -> val n = (seen[t.id] ?: 0) + 1; seen[t.id] = n; "${t.id}#$n" }
    }
    Box(Modifier.fillMaxSize()) {
        val state = ui.listState("queue:${q.id}")
        LaunchedEffect(q.id) { if (current > 2 && state.firstVisibleItemIndex == 0) state.scrollToItem(current - 2) }
        val reorder = rememberReorderState(state) { from, to -> pb.move(from, to) }
        LazyColumn(state = state, contentPadding = PaddingValues(top = 4.dp, bottom = 8.dp)) {
            itemsIndexed(list, key = { i, _ -> keys.getOrElse(i) { "x$i" } }, contentType = { _, _ -> "song" }) { i, t ->
                val dragging = reorder.dragging == i
                SongRow(
                    t,
                    onClick = { if (isActive) pb.playAt(i) else { pb.switchQueue(q.id, i); onSwitched() } },
                    onMenu = { ui.menu = MenuTarget.Song(t, list, q.name, queueIndex = if (isActive) i else null) },
                    modifier = Modifier
                        .zIndex(if (dragging) 1f else 0f)
                        .graphicsLayer { translationY = if (dragging) reorder.offset else 0f }
                        .then(if (dragging) Modifier.shadow(8.dp).background(LocalPalette.current.bar) else Modifier),
                    playing = i == current,
                    highlight = i == current,
                    leading = { DragHandle(if (isActive) Modifier.reorderHandle(reorder) { i } else Modifier, tint = if (i == current) LocalPalette.current.accent else LocalPalette.current.text) },
                )
            }
        }
        FastScroller(state)
    }
}

@Composable
private fun QueuePicker(queues: List<QueueSummary>, selected: Long?, onPick: (Long) -> Unit, onDismiss: () -> Unit) {
    val pb = LocalUi.current.playback
    val pal = LocalPalette.current
    var renaming by remember { mutableStateOf<QueueSummary?>(null) }
    MDialog(onDismiss) {
        Column {
            DialogTitle("Queues", icon = Icons.AutoMirrored.Rounded.QueueMusic)
            queues.forEachIndexed { i, q ->
                Row(Modifier.fillMaxWidth().height(52.dp).clickable { onPick(q.id) }.padding(start = 8.dp, end = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                    RadioButton(q.id == selected, onClick = { onPick(q.id) })
                    Text("${i + 1}", style = TextStyle(fontSize = 15.sp), color = pal.text2, modifier = Modifier.width(26.dp))
                    if (q.active) Icon(Icons.Rounded.PlayArrow, "Playing queue", Modifier.size(20.dp), tint = pal.accent) else Spacer(Modifier.width(20.dp))
                    Spacer(Modifier.width(6.dp))
                    Text(q.name.ifBlank { "Queue" }, style = TextStyle(fontSize = 16.sp), color = pal.text, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                    IconAction(Icons.Rounded.Edit, "Rename this queue", { renaming = q }, tint = pal.text2)
                    IconAction(Icons.Rounded.Close, "Remove this queue", { pb.deleteQueue(q.id) }, tint = pal.text2)
                }
            }
            DialogButtons("Close" to onDismiss)
        }
    }
    renaming?.let { q -> TextDialog("Rename queue", q.name, "Rename", onDismiss = { renaming = null }) { pb.renameQueue(q.id, it); renaming = null } }
}

/** A one-field dialog (rename a queue or playlist, name a new playlist). */
@Composable
fun TextDialog(title: String, initial: String, action: String, note: String? = null, allowEmpty: Boolean = false, onDismiss: () -> Unit, onDone: (String) -> Unit) {
    val pal = LocalPalette.current
    var text by rememberSaveable { mutableStateOf(initial) }
    MDialog(onDismiss) {
        Column {
            DialogTitle(title)
            if (note != null) Text(note, Modifier.padding(horizontal = 16.dp), style = TextStyle(fontSize = 14.sp), color = pal.text2)
            val focus = remember { FocusRequester() }
            LaunchedEffect(Unit) { focus.requestFocus() }
            BasicTextField(
                text, { text = it }, singleLine = true,
                textStyle = TextStyle(fontSize = 17.sp, color = pal.text), cursorBrush = SolidColor(pal.accent),
                modifier = Modifier.padding(horizontal = 16.dp, vertical = 12.dp).fillMaxWidth().focusRequester(focus),
                decorationBox = { inner ->
                    Column {
                        inner()
                        Spacer(Modifier.height(6.dp))
                        Box(Modifier.fillMaxWidth().height(2.dp).background(pal.accent))
                    }
                },
            )
            DialogButtons("Cancel" to onDismiss, action to { if (allowEmpty || text.isNotBlank()) onDone(text.trim()) })
        }
    }
}
