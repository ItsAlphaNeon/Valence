package app.valence.ui.components

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
import androidx.compose.foundation.systemGestureExclusion
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.grid.LazyGridState
import androidx.compose.foundation.shape.RoundedCornerShape
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
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.valence.ui.theme.LocalPalette
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlin.math.roundToInt

/** Width of the strip lists leave free on their right for the scroll bar (as Musicolet does). */
val ScrollStrip = 16.dp

private class ScrollSource(
    val total: () -> Int,
    val visible: () -> Int,
    val first: () -> Int,
    val firstOffset: () -> Int,
    val firstSize: () -> Int,
    val canScroll: () -> Boolean,
    val jump: (Int) -> Unit,
)

/**
 * Musicolet's always-visible scroll bar: a thin thumb in a strip on the right. Drag it to fly
 * through the list; a bubble shows where you are. The thumb moves in the draw phase only, so
 * scrolling never recomposes it.
 */
@Composable
fun BoxScope.FastScroller(state: LazyListState, label: (Int) -> String = { "" }) {
    val src = remember(state) {
        ScrollSource(
            total = { state.layoutInfo.totalItemsCount },
            visible = { state.layoutInfo.visibleItemsInfo.size },
            first = { state.firstVisibleItemIndex },
            firstOffset = { state.firstVisibleItemScrollOffset },
            firstSize = { state.layoutInfo.visibleItemsInfo.firstOrNull()?.size ?: 1 },
            canScroll = { state.canScrollForward || state.canScrollBackward },
            jump = { state.requestScrollToItem(it) },
        )
    }
    Scroller(src, label)
}

@Composable
fun BoxScope.FastScroller(state: LazyGridState, columns: Int, label: (Int) -> String = { "" }) {
    val src = remember(state, columns) {
        ScrollSource(
            total = { (state.layoutInfo.totalItemsCount + columns - 1) / columns },
            visible = { (state.layoutInfo.visibleItemsInfo.size + columns - 1) / columns },
            first = { state.firstVisibleItemIndex / columns },
            firstOffset = { state.firstVisibleItemScrollOffset },
            firstSize = { state.layoutInfo.visibleItemsInfo.firstOrNull()?.size?.height ?: 1 },
            canScroll = { state.canScrollForward || state.canScrollBackward },
            jump = { state.requestScrollToItem(it * columns) },
        )
    }
    Scroller(src, { label(it * columns) })
}

@Composable
private fun BoxScope.Scroller(src: ScrollSource, label: (Int) -> String) {
    val show by remember(src) { derivedStateOf { src.canScroll() } }
    if (!show) return
    val pal = LocalPalette.current
    val density = LocalDensity.current
    val thumbH = with(density) { 44.dp.toPx() }
    var height by remember { mutableIntStateOf(1) }
    var dragging by remember { mutableStateOf(false) }
    var dragY by remember { mutableFloatStateOf(0f) }

    fun track() = (height - thumbH).coerceAtLeast(1f)
    fun fraction(): Float {
        val span = (src.total() - src.visible()).coerceAtLeast(1)
        val partial = src.firstOffset().toFloat() / src.firstSize().coerceAtLeast(1)
        return ((src.first() + partial) / span).coerceIn(0f, 1f)
    }
    fun indexAt(y: Float): Int {
        val n = src.total()
        return ((y / track()) * (n - src.visible()).coerceAtLeast(0)).roundToInt().coerceIn(0, (n - 1).coerceAtLeast(0))
    }

    Box(
        Modifier
            .align(Alignment.TopEnd)
            .fillMaxHeight()
            .width(ScrollStrip)
            .onSizeChanged { height = it.height }
            .pointerInput(src) {
                detectDragGestures(
                    onDragStart = { o -> dragging = true; dragY = (o.y - thumbH / 2).coerceIn(0f, track()); src.jump(indexAt(dragY)) },
                    onDragEnd = { dragging = false },
                    onDragCancel = { dragging = false },
                ) { change, amount ->
                    change.consume()
                    dragY = (dragY + amount.y).coerceIn(0f, track())
                    src.jump(indexAt(dragY))
                }
            }
            .pointerInput(src) {
                detectTapGestures { o -> src.jump(indexAt((o.y - thumbH / 2).coerceIn(0f, track()))) }
            },
    ) {
        Box(
            Modifier
                .align(Alignment.TopCenter)
                // Placed (not drawn) where it is, so the system's edge back gesture leaves it alone.
                .offset { IntOffset(0, (if (dragging) dragY else fraction() * track()).roundToInt()) }
                .systemGestureExclusion()
                .size(width = 8.dp, height = 44.dp)
                .clip(RoundedCornerShape(4.dp))
                .background(if (dragging) pal.accent else pal.thumb),
        )
    }
    if (dragging) {
        val text = label(indexAt(dragY))
        if (text.isNotEmpty()) Box(
            Modifier
                .align(Alignment.TopEnd)
                .offset { IntOffset(-with(density) { 40.dp.roundToPx() }, (dragY - thumbH / 2).roundToInt().coerceAtLeast(0)) }
                .size(72.dp)
                .clip(RoundedCornerShape(50))
                .background(pal.accent),
            contentAlignment = Alignment.Center,
        ) {
            Text(text.take(4), style = TextStyle(fontSize = if (text.length > 2) 20.sp else 30.sp, fontWeight = FontWeight.Bold), color = pal.onAccent, maxLines = 1)
        }
    }
}

/**
 * Drag-to-reorder for a LazyColumn: drag a row's handle; it swaps with neighbours as it passes
 * them and the list scrolls at the edges.
 */
@Stable
class ReorderState(val list: LazyListState, private val onMove: (Int, Int) -> Unit, private val onEnd: () -> Unit = {}) {
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
        val was = dragging
        dragging = -1
        offset = 0f
        if (was >= 0) onEnd()
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
fun rememberReorderState(list: LazyListState, onEnd: () -> Unit = {}, onMove: (Int, Int) -> Unit): ReorderState {
    val state = remember(list) { ReorderState(list, onMove, onEnd) }
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
