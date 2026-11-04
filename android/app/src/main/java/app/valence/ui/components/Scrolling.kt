package app.valence.ui.components

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectDragGestures
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.gestures.scrollBy
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.grid.LazyGridState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.Stable
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlin.math.roundToInt

/**
 * Musicolet-style fast scroller: a thumb on the right edge you can drag through a long list, with a
 * bubble showing where you are (first letter, year...). Shown while scrolling or dragging.
 */
@Composable
fun BoxScope.FastScroller(
    state: LazyListState,
    count: Int,
    label: (Int) -> String,
    topPadding: Int = 0,
) {
    FastScrollerImpl(
        count = count,
        first = { state.firstVisibleItemIndex },
        visible = { state.layoutInfo.visibleItemsInfo.size },
        scrolling = { state.isScrollInProgress },
        scrollTo = { state.scrollToItem(it) },
        label = label,
        topPadding = topPadding,
    )
}

@Composable
fun BoxScope.FastScroller(state: LazyGridState, count: Int, label: (Int) -> String) {
    FastScrollerImpl(
        count = count,
        first = { state.firstVisibleItemIndex },
        visible = { state.layoutInfo.visibleItemsInfo.size },
        scrolling = { state.isScrollInProgress },
        scrollTo = { state.scrollToItem(it) },
        label = label,
        topPadding = 0,
    )
}

@Composable
private fun BoxScope.FastScrollerImpl(
    count: Int,
    first: () -> Int,
    visible: () -> Int,
    scrolling: () -> Boolean,
    scrollTo: suspend (Int) -> Unit,
    label: (Int) -> String,
    topPadding: Int,
) {
    if (count < 40) return
    val scope = rememberCoroutineScope()
    var height by remember { mutableIntStateOf(1) }
    var dragging by remember { mutableStateOf(false) }
    var dragY by remember { mutableFloatStateOf(0f) }
    var shown by remember { mutableStateOf(false) }
    val isScrolling by remember { derivedStateOf { scrolling() } }
    LaunchedEffect(isScrolling, dragging) {
        if (isScrolling || dragging) shown = true else { delay(1200); shown = false }
    }
    val density = LocalDensity.current
    val thumbH = with(density) { 44.dp.toPx() }
    val fraction by remember(count) {
        derivedStateOf {
            val span = (count - visible()).coerceAtLeast(1)
            (first().toFloat() / span).coerceIn(0f, 1f)
        }
    }
    val y = if (dragging) dragY else fraction * (height - thumbH)
    val targetIndex = ((y / (height - thumbH).coerceAtLeast(1f)) * (count - 1)).roundToInt().coerceIn(0, count - 1)
    val input = Modifier
        .pointerInput(count) {
            detectDragGestures(
                onDragStart = { o -> dragging = true; dragY = (o.y - thumbH / 2).coerceIn(0f, height - thumbH) },
                onDragEnd = { dragging = false },
                onDragCancel = { dragging = false },
            ) { change, amount ->
                change.consume()
                dragY = (dragY + amount.y).coerceIn(0f, height - thumbH)
                val idx = ((dragY / (height - thumbH).coerceAtLeast(1f)) * (count - 1)).roundToInt()
                scope.launch { scrollTo(idx) }
            }
        }
        .pointerInput(count) {
            detectTapGestures { o ->
                val yy = (o.y - thumbH / 2).coerceIn(0f, height - thumbH)
                scope.launch { scrollTo(((yy / (height - thumbH).coerceAtLeast(1f)) * (count - 1)).roundToInt()) }
            }
        }

    Box(
        Modifier
            .align(Alignment.TopEnd)
            .padding(top = with(density) { topPadding.toDp() })
            .fillMaxHeight()
            .width(28.dp)
            .onSizeChanged { height = it.height }
            // The strip sits on top of the rows' menu buttons, so it only takes touches while the thumb shows.
            .then(if (shown || dragging) input else Modifier),
    ) {
        AnimatedVisibility(shown, enter = fadeIn(), exit = fadeOut()) {
            Box(Modifier.offset { IntOffset(0, y.roundToInt()) }.padding(end = 4.dp).size(width = 6.dp, height = 44.dp).clip(RoundedCornerShape(3.dp)).background(MaterialTheme.colorScheme.primary))
        }
    }
    if (dragging) {
        val text = label(targetIndex)
        if (text.isNotEmpty()) Box(
            Modifier
                .align(Alignment.TopEnd)
                .offset { IntOffset(-with(density) { 44.dp.roundToPx() }, (y + topPadding - thumbH / 2).roundToInt()) }
                .clip(RoundedCornerShape(16.dp))
                .background(MaterialTheme.colorScheme.primaryContainer)
                .padding(horizontal = 18.dp, vertical = 10.dp),
        ) {
            Text(text, style = MaterialTheme.typography.headlineSmall, color = MaterialTheme.colorScheme.onPrimaryContainer)
        }
    }
}

/** First letter for the fast-scroll bubble ("#" for digits and symbols). */
fun indexLetter(s: String): String {
    val c = s.trimStart().firstOrNull() ?: return ""
    return if (c.isLetter()) c.uppercaseChar().toString() else "#"
}

/**
 * Drag-to-reorder for a LazyColumn: long-press (or drag the handle) to pick an item up; it swaps
 * with neighbours as it passes them and the list scrolls at the edges.
 */
@Stable
class ReorderState(val list: LazyListState, private val onMove: (Int, Int) -> Unit) {
    var dragging by mutableIntStateOf(-1)
        private set
    var offset by mutableFloatStateOf(0f)
        private set

    fun start(index: Int) {
        dragging = index
        offset = 0f
    }

    fun drag(dy: Float) {
        if (dragging < 0) return
        offset += dy
        val items = list.layoutInfo.visibleItemsInfo
        val cur = items.firstOrNull { it.index == dragging } ?: return
        val center = cur.offset + offset + cur.size / 2f
        val target = items.firstOrNull { it.index != dragging && center > it.offset && center < it.offset + it.size } ?: return
        if (target.key is String && (target.key as String).startsWith("h:")) return // headers don't move
        onMove(dragging, target.index)
        offset += cur.offset - target.offset
        dragging = target.index
    }

    fun end() {
        dragging = -1
        offset = 0f
    }

    /** Scroll speed (px/frame) while the dragged item is near the top or bottom edge. */
    fun edgeSpeed(): Float {
        if (dragging < 0) return 0f
        val info = list.layoutInfo
        val cur = info.visibleItemsInfo.firstOrNull { it.index == dragging } ?: return 0f
        val top = cur.offset + offset
        val bottom = top + cur.size
        val edge = 120f
        return when {
            top < info.viewportStartOffset + edge -> -((info.viewportStartOffset + edge - top) / 6f).coerceAtMost(30f)
            bottom > info.viewportEndOffset - edge -> ((bottom - (info.viewportEndOffset - edge)) / 6f).coerceAtMost(30f)
            else -> 0f
        }
    }
}

@Composable
fun rememberReorderState(list: LazyListState, onMove: (Int, Int) -> Unit): ReorderState {
    val state = remember(list) { ReorderState(list, onMove) }
    LaunchedEffect(state) {
        while (isActive) {
            val v = state.edgeSpeed()
            if (v != 0f) {
                val consumed = state.list.scrollBy(v)
                state.drag(consumed)
            }
            delay(16)
        }
    }
    return state
}

fun Modifier.reorderHandle(state: ReorderState, index: () -> Int): Modifier = pointerInput(state) {
    detectDragGestures(
        onDragStart = { state.start(index()) },
        onDragEnd = { state.end() },
        onDragCancel = { state.end() },
    ) { change, amount ->
        change.consume()
        state.drag(amount.y)
    }
}
