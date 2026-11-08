package app.valence.ui.components

import androidx.compose.animation.core.animate
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.awaitHorizontalTouchSlopOrCancellation
import androidx.compose.foundation.gestures.horizontalDrag
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.RemoveCircleOutline
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.input.pointer.positionChange
import androidx.compose.ui.input.pointer.util.VelocityTracker
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.valence.ui.theme.LocalPalette
import kotlinx.coroutines.launch
import kotlin.math.roundToInt

private val RemoveRed = Color(0xFFC62828)

/**
 * A row that slides away to the right to be removed (the queue's swipe-to-remove).
 * Only a rightward swipe is taken: a leftward one is left alone, so it still turns the tab pages.
 */
@Composable
fun SwipeToRemove(onRemove: () -> Unit, modifier: Modifier = Modifier, enabled: Boolean = true, content: @Composable () -> Unit) {
    var dx by remember { mutableFloatStateOf(0f) }
    val scope = rememberCoroutineScope()
    val remove by rememberUpdatedState(onRemove)
    val haptics = LocalHapticFeedback.current
    val bg = LocalPalette.current.bg
    Box(modifier.clipToBounds()) {
        if (dx > 0f) {
            Row(Modifier.matchParentSize().background(RemoveRed).padding(start = 20.dp), verticalAlignment = Alignment.CenterVertically) {
                Icon(Icons.Rounded.RemoveCircleOutline, null, Modifier.size(22.dp), tint = Color.White)
                Spacer(Modifier.width(10.dp))
                Text("Remove from queue", style = TextStyle(fontSize = 15.sp, fontWeight = FontWeight.Medium), color = Color.White)
            }
        }
        Box(
            Modifier
                .offset { IntOffset(dx.roundToInt(), 0) }
                .then(if (dx > 0f) Modifier.background(bg) else Modifier)
                .pointerInput(enabled) {
                    if (!enabled) return@pointerInput
                    awaitEachGesture {
                        val down = awaitFirstDown(requireUnconsumed = false)
                        var x = 0f
                        val start = awaitHorizontalTouchSlopOrCancellation(down.id) { change, over ->
                            // Leftward: not ours (the pager or nothing takes it).
                            if (over > 0f) { change.consume(); x = over }
                        } ?: return@awaitEachGesture
                        val tracker = VelocityTracker()
                        tracker.addPosition(start.uptimeMillis, start.position)
                        dx = x
                        val done = horizontalDrag(start.id) { change ->
                            x = (x + change.positionChange().x).coerceAtLeast(0f)
                            tracker.addPosition(change.uptimeMillis, change.position)
                            change.consume()
                            dx = x
                        }
                        val width = size.width.toFloat()
                        val v = tracker.calculateVelocity().x
                        val gone = done && (x > width * 0.4f || (v > 1200f && x > width * 0.12f))
                        scope.launch {
                            if (gone) {
                                haptics.performHapticFeedback(HapticFeedbackType.LongPress)
                                animate(dx, width, animationSpec = tween(150)) { value, _ -> dx = value }
                                remove()
                                // The row may be reused by the next copy of the same song.
                                dx = 0f
                            } else {
                                animate(dx, 0f, animationSpec = spring()) { value, _ -> dx = value }
                            }
                        }
                    }
                },
        ) { content() }
    }
}
