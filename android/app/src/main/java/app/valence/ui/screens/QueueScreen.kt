package app.valence.ui.screens

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.QueueMusic
import androidx.compose.material.icons.rounded.ClearAll
import androidx.compose.material.icons.rounded.Close
import androidx.compose.material.icons.rounded.DragHandle
import androidx.compose.material.icons.rounded.KeyboardArrowDown
import androidx.compose.material.icons.rounded.Shuffle
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.SwipeToDismissBox
import androidx.compose.material3.SwipeToDismissBoxValue
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberSwipeToDismissBoxState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.zIndex
import app.valence.playback.QueueSummary
import app.valence.ui.LocalUi
import app.valence.ui.MenuTarget
import app.valence.ui.components.EmptyState
import app.valence.ui.components.TrackRow
import app.valence.ui.components.formatTotal
import app.valence.ui.components.rememberReorderState
import app.valence.ui.components.reorderHandle
import app.valence.ui.components.songs

/** The playing queue (drag to reorder, swipe to remove) and Musicolet-style switching between queues. */
@Composable
fun QueueScreen() {
    val ui = LocalUi.current
    val pb = ui.playback
    val queue by pb.queue.collectAsState()
    val index by pb.index.collectAsState()
    val queues by pb.queues.collectAsState()
    BackHandler { ui.queueOpen = false }
    val list = rememberLazyListState()
    LaunchedEffect(Unit) { if (index > 1) list.scrollToItem(index - 1) }
    val reorder = rememberReorderState(list) { from, to -> pb.move(from, to) }
    Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
        Column(Modifier.fillMaxSize().statusBarsPadding().navigationBarsPadding()) {
            Row(Modifier.fillMaxWidth().padding(horizontal = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                IconButton(onClick = { ui.queueOpen = false }) { Icon(Icons.Rounded.KeyboardArrowDown, "Close", Modifier.size(30.dp)) }
                Column(Modifier.weight(1f)) {
                    Text("Queue", style = MaterialTheme.typography.titleLarge)
                    val left = queue.drop(index + 1).sumOf { it.durationMs }
                    Text("${songs(queue.size)} · ${formatTotal(left)} left", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                IconButton(onClick = pb::shuffleQueue) { Icon(Icons.Rounded.Shuffle, "Shuffle queue") }
                IconButton(onClick = pb::clearUpcoming) { Icon(Icons.Rounded.ClearAll, "Clear upcoming") }
            }
            if (queues.size > 1 || queues.isNotEmpty()) QueueChips(queues)
            if (queue.isEmpty()) {
                EmptyState(Icons.AutoMirrored.Rounded.QueueMusic, "Queue is empty", "Play something from your library.")
                return@Column
            }
            LazyColumn(state = list, contentPadding = PaddingValues(bottom = 24.dp)) {
                itemsIndexed(queue, key = { i, t -> "$i:${t.id}" }) { i, t ->
                    val dragging = reorder.dragging == i
                    val dismiss = rememberSwipeToDismissBoxState()
                    LaunchedEffect(dismiss.currentValue) {
                        if (dismiss.currentValue != SwipeToDismissBoxValue.Settled) {
                            pb.removeAt(i)
                            dismiss.snapTo(SwipeToDismissBoxValue.Settled)
                        }
                    }
                    SwipeToDismissBox(
                        dismiss,
                        enableDismissFromStartToEnd = i != index,
                        enableDismissFromEndToStart = i != index,
                        backgroundContent = { Box(Modifier.fillMaxSize().background(MaterialTheme.colorScheme.errorContainer)) },
                        modifier = Modifier
                            .zIndex(if (dragging) 1f else 0f)
                            .graphicsLayer { translationY = if (dragging) reorder.offset else 0f }
                            .let { if (dragging) it.shadow(8.dp) else it },
                    ) {
                        Surface(color = if (i == index) MaterialTheme.colorScheme.secondaryContainer else MaterialTheme.colorScheme.background) {
                            TrackRow(
                                t,
                                onClick = { pb.playAt(i) },
                                playing = i == index,
                                onMenu = { ui.menu = MenuTarget.Song(t, queueIndex = i) },
                                menuButton = false,
                                trailing = {
                                    Icon(
                                        Icons.Rounded.DragHandle, "Reorder",
                                        Modifier.padding(start = 8.dp).size(40.dp).padding(8.dp).reorderHandle(reorder) { i },
                                        tint = MaterialTheme.colorScheme.onSurfaceVariant,
                                    )
                                },
                            )
                        }
                    }
                }
            }
        }
    }
}


@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun QueueChips(queues: List<QueueSummary>) {
    val pb = LocalUi.current.playback
    var editing by remember { mutableStateOf<QueueSummary?>(null) }
    var menuFor by remember { mutableStateOf<Long?>(null) }
    LazyRow(contentPadding = PaddingValues(horizontal = 12.dp, vertical = 6.dp)) {
        items(queues, key = { it.id }) { q ->
            Box {
                Column(
                    Modifier
                        .padding(end = 8.dp)
                        .clip(RoundedCornerShape(12.dp))
                        .background(if (q.active) MaterialTheme.colorScheme.primaryContainer else MaterialTheme.colorScheme.surfaceContainerHigh)
                        .combinedClickable(onClick = { pb.switchQueue(q.id) }, onLongClick = { menuFor = q.id })
                        .padding(horizontal = 14.dp, vertical = 8.dp)
                        .width(110.dp),
                ) {
                    Text(q.name.ifBlank { "Queue ${q.id}" }, maxLines = 1, overflow = TextOverflow.Ellipsis, fontWeight = FontWeight.SemiBold, style = MaterialTheme.typography.bodyMedium)
                    Text(songs(q.count), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                DropdownMenu(menuFor == q.id, onDismissRequest = { menuFor = null }) {
                    DropdownMenuItem(text = { Text("Rename") }, onClick = { editing = q; menuFor = null })
                    DropdownMenuItem(text = { Text("Delete queue") }, leadingIcon = { Icon(Icons.Rounded.Close, null) }, onClick = { pb.deleteQueue(q.id); menuFor = null })
                }
            }
        }
    }
    editing?.let { q ->
        var name by remember(q.id) { mutableStateOf(q.name) }
        AlertDialog(
            onDismissRequest = { editing = null },
            title = { Text("Rename queue") },
            text = { OutlinedTextField(name, { name = it }, singleLine = true) },
            confirmButton = { TextButton(onClick = { pb.renameQueue(q.id, name.trim()); editing = null }) { Text("Save") } },
            dismissButton = { TextButton(onClick = { editing = null }) { Text("Cancel") } },
        )
    }
}

