package app.valence.ui.components

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.selection.selectable
import androidx.compose.animation.core.animateDpAsState
import androidx.compose.ui.semantics.Role
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.ArrowBack
import androidx.compose.material.icons.automirrored.rounded.Sort
import androidx.compose.material.icons.rounded.Close
import androidx.compose.material.icons.rounded.DragHandle
import androidx.compose.material.icons.rounded.MusicNote
import androidx.compose.material.icons.rounded.Search
import androidx.compose.material.icons.rounded.Settings
import androidx.compose.material.icons.rounded.Shuffle
import androidx.compose.material.icons.rounded.Timer
import androidx.compose.material3.Icon
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Text
import androidx.compose.material3.ripple
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.RectangleShape
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import app.valence.art.TrackArt
import app.valence.data.Track
import app.valence.ui.theme.LocalPalette
import coil3.compose.AsyncImage
import java.util.Locale

// ---- Formatting ----------------------------------------------------------------------------------

fun formatDuration(ms: Long): String {
    if (ms <= 0) return "0:00"
    val s = ms / 1000
    val h = s / 3600
    val m = (s % 3600) / 60
    val sec = s % 60
    return if (h > 0) String.format(Locale.ROOT, "%d:%02d:%02d", h, m, sec) else String.format(Locale.ROOT, "%d:%02d", m, sec)
}

fun formatTotal(ms: Long): String = formatDuration(ms)

fun songs(n: Int) = if (n == 1) "1 song" else "$n songs"

/** Second line of a song row: the game for rips, else the artist. */
fun Track.line2(): String = if (isRip) ripGame?.takeIf { it.isNotBlank() } ?: artist else artist

/** Third line: the album. */
fun Track.line3(): String = album.ifBlank { if (isRip) artist else "" }

fun Track.subtitle(): String = listOf(line2(), line3()).filter { it.isNotBlank() }.joinToString(" · ")

// ---- Text styles (shared instances, so rows don't build new ones) ---------------------------------

val RowTitle = TextStyle(fontSize = 18.sp, lineHeight = 22.sp)
val RowSub = TextStyle(fontSize = 14.sp, lineHeight = 17.sp)
val RowSingle = TextStyle(fontSize = 17.sp, lineHeight = 22.sp)
val BarTitle = TextStyle(fontSize = 20.sp, lineHeight = 26.sp, fontWeight = FontWeight.Bold)
val Small = TextStyle(fontSize = 14.sp, lineHeight = 18.sp)

// ---- Art -----------------------------------------------------------------------------------------

/** Album art from a track's file ([thumb] = the small cached copy lists use). */
@Composable
fun Thumb(trackId: Long?, modifier: Modifier = Modifier, shape: Shape = RectangleShape, icon: ImageVector = Icons.Rounded.MusicNote, iconSize: Dp = 22.dp, thumb: Boolean = true) {
    val pal = LocalPalette.current
    Box(modifier.clip(shape).background(pal.artBg), contentAlignment = Alignment.Center) {
        if (trackId == null) Icon(icon, null, Modifier.size(iconSize), tint = pal.text3)
        else AsyncImage(model = TrackArt(trackId, thumb), contentDescription = null, contentScale = ContentScale.Crop, modifier = Modifier.matchParentSize())
    }
}

// ---- Small controls ------------------------------------------------------------------------------

/** An icon you can tap, without Material's button machinery (cheap enough for every list row). */
@Composable
fun IconAction(icon: ImageVector, description: String?, onClick: () -> Unit, modifier: Modifier = Modifier, tint: Color = LocalPalette.current.text, size: Dp = 24.dp, box: Dp = 48.dp, enabled: Boolean = true) {
    Box(
        modifier
            .size(box)
            .clickable(remember { MutableInteractionSource() }, ripple(bounded = false, radius = box / 2), enabled = enabled, onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Icon(icon, description, Modifier.size(size), tint = if (enabled) tint else tint.copy(alpha = 0.38f))
    }
}

/** Musicolet's options button: a filled rounded square with three dots. */
@Composable
fun OptionsButton(onClick: () -> Unit, modifier: Modifier = Modifier, color: Color = LocalPalette.current.text, box: Dp = 48.dp) {
    val dots = LocalPalette.current.bg
    Box(
        modifier
            .size(box)
            .clickable(remember { MutableInteractionSource() }, ripple(bounded = false, radius = box / 2), onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Canvas(Modifier.size(21.dp)) {
            drawRoundRect(color, cornerRadius = CornerRadius(size.width * 0.24f))
            val r = size.width * 0.085f
            val cy = size.height / 2
            for (i in -1..1) drawCircle(dots, r, Offset(size.width / 2 + i * size.width * 0.25f, cy))
        }
    }
}

@Composable
fun HDivider(modifier: Modifier = Modifier) {
    Box(modifier.fillMaxWidth().height(1.dp).background(LocalPalette.current.divider))
}

/** "56 songs  ⏱ 3:04:52" */
@Composable
fun CountLine(count: Int, durationMs: Long, modifier: Modifier = Modifier, noun: (Int) -> String = ::songs) {
    val pal = LocalPalette.current
    Row(modifier, verticalAlignment = Alignment.CenterVertically) {
        Text(noun(count), style = Small, color = pal.text2)
        if (durationMs > 0) {
            Spacer(Modifier.width(12.dp))
            Icon(Icons.Rounded.Timer, null, Modifier.size(15.dp), tint = pal.text2)
            Spacer(Modifier.width(4.dp))
            Text(formatDuration(durationMs), style = Small, color = pal.text2)
        }
    }
}

/** Outlined pill (Artists / Album-Artists / Composers). */
@Composable
fun Chip(text: String, selected: Boolean, onClick: () -> Unit, modifier: Modifier = Modifier) {
    val pal = LocalPalette.current
    Box(
        modifier
            .height(36.dp)
            .clip(RoundedCornerShape(50))
            .border(BorderStroke(1.dp, if (selected) pal.accent else pal.outline), RoundedCornerShape(50))
            .clickable(onClick = onClick)
            .padding(horizontal = 14.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(text, style = TextStyle(fontSize = 15.sp), color = if (selected) pal.accent else pal.text2, maxLines = 1)
    }
}

/** One side of a [SegmentedSwitch]; [count] shows dimmed after the label once known. */
data class SwitchOption(val icon: ImageVector, val label: String, val count: Int? = null)

/**
 * A full-width switch with a sliding accent thumb (Favorites: Music | SiivaGunner). Filled rather
 * than outlined like [Chip], so it reads as "which collection" instead of another filter.
 */
@Composable
fun SegmentedSwitch(options: List<SwitchOption>, selected: Int, onSelect: (Int) -> Unit, modifier: Modifier = Modifier) {
    val pal = LocalPalette.current
    val shape = RoundedCornerShape(50)
    BoxWithConstraints(
        modifier.fillMaxWidth().height(46.dp).clip(shape).background(pal.bar).border(1.dp, pal.outline, shape).padding(3.dp),
    ) {
        val w = maxWidth / options.size
        val x by animateDpAsState(w * selected, label = "switchThumb")
        Box(Modifier.offset(x = x).width(w).fillMaxHeight().clip(shape).background(pal.accent))
        Row(Modifier.fillMaxSize()) {
            options.forEachIndexed { i, o ->
                val on = i == selected
                val color = if (on) pal.onAccent else pal.text2
                Row(
                    Modifier.weight(1f).fillMaxHeight().clip(shape).selectable(selected = on, role = Role.Tab, onClick = { onSelect(i) }),
                    horizontalArrangement = Arrangement.Center,
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Icon(o.icon, null, Modifier.size(18.dp), tint = color)
                    Spacer(Modifier.width(8.dp))
                    Text(o.label, style = TextStyle(fontSize = 15.sp, fontWeight = FontWeight.SemiBold), color = color, maxLines = 1)
                    if (o.count != null) {
                        Spacer(Modifier.width(6.dp))
                        Text(o.count.toString(), style = TextStyle(fontSize = 13.sp, fontWeight = FontWeight.Medium), color = color.copy(alpha = 0.7f), maxLines = 1)
                    }
                }
            }
        }
    }
}

@Composable
fun ChipRow(content: @Composable RowScope.() -> Unit) {
    Row(
        Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(start = 8.dp, end = 8.dp, top = 8.dp, bottom = 4.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        content = content,
    )
}

/** Accent label over a group ("Your playlists"). */
@Composable
fun SectionLabel(text: String, modifier: Modifier = Modifier) {
    Text(
        text,
        modifier.padding(start = 16.dp, end = 16.dp, top = 14.dp, bottom = 6.dp),
        style = TextStyle(fontSize = 14.sp, fontWeight = FontWeight.Bold),
        color = LocalPalette.current.accent,
    )
}

/** Outlined text button ("+ New Playlist"). */
@Composable
fun OutlinedAction(text: String, onClick: () -> Unit, modifier: Modifier = Modifier, icon: ImageVector? = null) {
    val pal = LocalPalette.current
    Row(
        modifier
            .height(40.dp)
            .clip(RoundedCornerShape(4.dp))
            .border(1.dp, pal.outline, RoundedCornerShape(4.dp))
            .clickable(onClick = onClick)
            .padding(horizontal = 16.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (icon != null) {
            Icon(icon, null, Modifier.size(22.dp), tint = pal.accent)
            Spacer(Modifier.width(14.dp))
        }
        Text(text, style = TextStyle(fontSize = 15.sp, fontWeight = FontWeight.Medium, letterSpacing = 0.6.sp), color = pal.text)
    }
}

@Composable
fun EmptyState(icon: ImageVector, title: String, body: String? = null, modifier: Modifier = Modifier, action: (@Composable () -> Unit)? = null) {
    val pal = LocalPalette.current
    Column(modifier.fillMaxSize().padding(32.dp), verticalArrangement = Arrangement.Center, horizontalAlignment = Alignment.CenterHorizontally) {
        Icon(icon, null, Modifier.size(52.dp), tint = pal.text3)
        Spacer(Modifier.height(12.dp))
        Text(title, style = TextStyle(fontSize = 17.sp, fontWeight = FontWeight.Medium), color = pal.text)
        if (body != null) {
            Spacer(Modifier.height(6.dp))
            Text(body, style = Small, color = pal.text2, textAlign = TextAlign.Center)
        }
        if (action != null) { Spacer(Modifier.height(16.dp)); action() }
    }
}

// ---- Rows ----------------------------------------------------------------------------------------

/**
 * Musicolet's song row: square thumbnail, title over two lines of detail, the length at the bottom
 * right and the options button. [highlight] draws the playing song's accent outline (queues).
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
fun SongRow(
    track: Track,
    onClick: () -> Unit,
    onMenu: () -> Unit,
    modifier: Modifier = Modifier,
    playing: Boolean = false,
    highlight: Boolean = false,
    line2: String = track.line2(),
    line3: String? = track.line3(),
    trailingText: String = formatDuration(track.durationMs),
    leading: (@Composable () -> Unit)? = null,
    endInset: Dp = 16.dp,
) {
    val pal = LocalPalette.current
    val fg = if (playing) pal.accent else pal.text
    val threeLines = line3 != null
    Row(
        modifier
            .fillMaxWidth()
            .padding(end = endInset)
            .height(if (threeLines) 74.dp else 62.dp)
            .then(
                // Drawn, not padded: the playing row's content lines up with the others.
                if (highlight) Modifier.drawBehind {
                    val inset = 3.dp.toPx()
                    drawRoundRect(
                        pal.accent, Offset(inset, inset), Size(size.width - 2 * inset, size.height - 2 * inset),
                        CornerRadius(6.dp.toPx()), style = Stroke(1.dp.toPx()),
                    )
                } else Modifier,
            )
            .combinedClickable(onClick = onClick, onLongClick = onMenu),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (leading != null) leading() else Spacer(Modifier.width(10.dp))
        Thumb(if (track.hasArt) track.id else null, Modifier.size(if (threeLines) 50.dp else 42.dp))
        Column(Modifier.weight(1f).padding(start = 10.dp)) {
            Text(track.title, style = RowTitle, color = fg, maxLines = 1, overflow = TextOverflow.Ellipsis)
            if (threeLines) {
                Text(line2, style = RowSub, color = fg, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(line3!!, style = RowSub, color = fg, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                    Text(trailingText, style = RowSub, color = fg, modifier = Modifier.padding(start = 8.dp))
                }
            } else {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(line2, style = RowSub, color = fg, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                    Text(trailingText, style = RowSub, color = fg, modifier = Modifier.padding(start = 8.dp))
                }
            }
        }
        OptionsButton(onMenu, color = if (playing) pal.accent else pal.text)
    }
}

/** Drag handle at the start of a queue row. */
@Composable
fun DragHandle(modifier: Modifier = Modifier, tint: Color = LocalPalette.current.text) {
    Box(modifier.width(46.dp).fillMaxHeight(), contentAlignment = Alignment.Center) {
        Icon(Icons.Rounded.DragHandle, "Hold and drag to change order", Modifier.size(24.dp), tint = tint)
    }
}

/** A one-line row (artists, games, genres) or an icon row (folders, playlists). */
@OptIn(ExperimentalFoundationApi::class)
@Composable
fun PlainRow(
    title: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    subtitle: String? = null,
    icon: ImageVector? = null,
    artTrackId: Long? = null,
    showArt: Boolean = false,
    accent: Boolean = false,
    onLongClick: (() -> Unit)? = null,
    trailing: (@Composable () -> Unit)? = null,
) {
    val pal = LocalPalette.current
    Row(
        modifier
            .fillMaxWidth()
            .height(if (subtitle != null || showArt) 60.dp else 48.dp)
            .combinedClickable(onClick = onClick, onLongClick = onLongClick)
            .padding(start = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        when {
            showArt -> { Thumb(artTrackId, Modifier.size(44.dp), icon = icon ?: Icons.Rounded.MusicNote); Spacer(Modifier.width(14.dp)) }
            icon != null -> { Box(Modifier.width(40.dp), contentAlignment = Alignment.Center) { Icon(icon, null, Modifier.size(28.dp), tint = pal.text) }; Spacer(Modifier.width(18.dp)) }
        }
        Column(Modifier.weight(1f).padding(end = 8.dp)) {
            Text(title, style = RowSingle, color = if (accent) pal.accent else pal.text, maxLines = 1, overflow = TextOverflow.Ellipsis)
            if (subtitle != null) Text(subtitle, style = RowSub, color = pal.text2, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        trailing?.invoke()
    }
}

// ---- Bars ----------------------------------------------------------------------------------------

/** Detail page top bar: back, bold title, and actions. */
@Composable
fun TopBar(title: String, onBack: (() -> Unit)?, modifier: Modifier = Modifier, actions: @Composable RowScope.() -> Unit = {}) {
    val pal = LocalPalette.current
    Row(modifier.fillMaxWidth().statusBarsPadding().height(52.dp), verticalAlignment = Alignment.CenterVertically) {
        if (onBack != null) IconAction(Icons.AutoMirrored.Rounded.ArrowBack, "Back", onBack, tint = pal.text)
        else Spacer(Modifier.width(16.dp))
        Text(title, style = BarTitle, color = pal.text, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f).padding(start = 4.dp))
        actions()
    }
}

/**
 * Musicolet's list header: "Search an album…" (tap to filter the list in place), sort and the
 * tab's settings. [filter] is the text typed so far ("" when closed).
 */
@Composable
fun SearchHintBar(
    hint: String,
    filter: String,
    onFilter: (String) -> Unit,
    modifier: Modifier = Modifier,
    onSort: (() -> Unit)? = null,
    onSettings: (() -> Unit)? = null,
) {
    val pal = LocalPalette.current
    var editing by remember { mutableStateOf(filter.isNotEmpty()) }
    Column(modifier.fillMaxWidth()) {
        Row(Modifier.fillMaxWidth().height(48.dp), verticalAlignment = Alignment.CenterVertically) {
            if (!editing) {
                Row(Modifier.weight(1f).height(48.dp).clickable { editing = true }, verticalAlignment = Alignment.CenterVertically) {
                    Spacer(Modifier.width(16.dp))
                    Icon(Icons.Rounded.Search, null, Modifier.size(24.dp), tint = pal.text2)
                    Spacer(Modifier.width(16.dp))
                    Text(hint, style = TextStyle(fontSize = 16.sp), color = pal.text2, maxLines = 1)
                }
            } else {
                val focus = remember { FocusRequester() }
                LaunchedEffect(Unit) { focus.requestFocus() }
                Spacer(Modifier.width(16.dp))
                Icon(Icons.Rounded.Search, null, Modifier.size(24.dp), tint = pal.accent)
                Spacer(Modifier.width(16.dp))
                Box(Modifier.weight(1f)) {
                    if (filter.isEmpty()) Text(hint, style = TextStyle(fontSize = 16.sp), color = pal.text3, maxLines = 1)
                    BasicTextField(
                        filter, onFilter,
                        singleLine = true,
                        textStyle = TextStyle(fontSize = 16.sp, color = pal.text),
                        cursorBrush = SolidColor(pal.accent),
                        keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
                        modifier = Modifier.fillMaxWidth().focusRequester(focus),
                    )
                }
                IconAction(Icons.Rounded.Close, "Close", { onFilter(""); editing = false }, tint = pal.text2)
            }
            if (onSort != null) IconAction(Icons.AutoMirrored.Rounded.Sort, "Sort", onSort, tint = pal.text2)
            if (onSettings != null) IconAction(Icons.Rounded.Settings, "Settings", onSettings, tint = pal.text2)
        }
        HDivider()
    }
}

/** The right-aligned shuffle · sort · options row above a song list. */
@Composable
fun ListActions(onShuffle: () -> Unit, onMenu: () -> Unit, modifier: Modifier = Modifier, onSort: (() -> Unit)? = null, start: @Composable RowScope.() -> Unit = {}) {
    val pal = LocalPalette.current
    Row(modifier.fillMaxWidth().height(50.dp), verticalAlignment = Alignment.CenterVertically) {
        start()
        Spacer(Modifier.weight(1f))
        IconAction(Icons.Rounded.Shuffle, "Shuffle listed songs", onShuffle, tint = pal.text)
        if (onSort != null) IconAction(Icons.AutoMirrored.Rounded.Sort, "Sort listed songs", onSort, tint = pal.text)
        OptionsButton(onMenu, Modifier.padding(end = 2.dp))
    }
}

// ---- Dialogs -------------------------------------------------------------------------------------

/** Musicolet's centred grey dialog. */
@Composable
fun MDialog(onDismiss: () -> Unit, modifier: Modifier = Modifier, content: @Composable () -> Unit) {
    val pal = LocalPalette.current
    Dialog(onDismiss, DialogProperties(usePlatformDefaultWidth = false)) {
        Box(
            modifier
                .padding(horizontal = 26.dp, vertical = 24.dp)
                .widthIn(max = 520.dp)
                .fillMaxWidth()
                .clip(RoundedCornerShape(8.dp))
                .background(pal.dialog)
                .padding(vertical = 6.dp),
        ) { content() }
    }
}

@Composable
fun DialogTitle(text: String, modifier: Modifier = Modifier, icon: ImageVector? = null, trailing: (@Composable () -> Unit)? = null) {
    val pal = LocalPalette.current
    Row(modifier.fillMaxWidth().padding(start = 12.dp, end = 4.dp).height(52.dp), verticalAlignment = Alignment.CenterVertically) {
        if (icon != null) {
            Spacer(Modifier.width(12.dp))
            Icon(icon, null, Modifier.size(24.dp), tint = pal.text)
            Spacer(Modifier.width(18.dp))
        }
        Text(text, style = BarTitle, color = pal.text, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
        if (trailing != null) {
            Box(Modifier.padding(horizontal = 6.dp).width(1.dp).height(28.dp).background(pal.divider))
            trailing()
        }
    }
}

@Composable
fun DialogItem(icon: ImageVector?, text: String, onClick: () -> Unit, modifier: Modifier = Modifier, enabled: Boolean = true, trailing: (@Composable () -> Unit)? = null) {
    val pal = LocalPalette.current
    Row(
        modifier.fillMaxWidth().height(48.dp).clickable(enabled = enabled, onClick = onClick).padding(start = 22.dp, end = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (icon != null) {
            Icon(icon, null, Modifier.size(24.dp), tint = pal.text2)
            Spacer(Modifier.width(26.dp))
        }
        Text(text, style = TextStyle(fontSize = 16.sp), color = if (enabled) pal.text else pal.text3, modifier = Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis)
        trailing?.invoke()
    }
}

@Composable
fun DialogSeparator() {
    Box(Modifier.padding(horizontal = 22.dp, vertical = 6.dp).fillMaxWidth().height(1.dp).background(LocalPalette.current.divider))
}

@Composable
fun RadioItem(text: String, selected: Boolean, onClick: () -> Unit) {
    val pal = LocalPalette.current
    Row(Modifier.fillMaxWidth().height(48.dp).clickable(onClick = onClick).padding(start = 12.dp, end = 16.dp), verticalAlignment = Alignment.CenterVertically) {
        RadioButton(selected, onClick = null)
        Spacer(Modifier.width(14.dp))
        Text(text, style = TextStyle(fontSize = 16.sp), color = pal.text)
    }
}

/** Text buttons at the bottom right of a dialog (Musicolet's are all caps, accent coloured). */
@Composable
fun DialogButtons(vararg buttons: Pair<String, () -> Unit>) {
    val pal = LocalPalette.current
    Row(Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 4.dp), horizontalArrangement = Arrangement.End) {
        for ((label, action) in buttons) {
            Box(Modifier.height(44.dp).clip(RoundedCornerShape(4.dp)).clickable(onClick = action).padding(horizontal = 14.dp), contentAlignment = Alignment.Center) {
                Text(label.uppercase(Locale.getDefault()), style = TextStyle(fontSize = 15.sp, fontWeight = FontWeight.Medium, letterSpacing = 0.8.sp), color = pal.accent)
            }
        }
    }
}

data class SortOption(val key: String, val label: String)

/** "Sort by…" as Musicolet asks it: a dialog of choices. */
@Composable
fun SortDialog(title: String, options: List<SortOption>, selected: String, onSelect: (String) -> Unit, onDismiss: () -> Unit) {
    MDialog(onDismiss) {
        Column {
            DialogTitle(title)
            for (o in options) RadioItem(o.label, o.key == selected) { onSelect(o.key); onDismiss() }
            DialogButtons("Cancel" to onDismiss)
        }
    }
}

/** The overlay box used by full-screen pages, so nothing under them takes touches. */
@Composable
fun Screen(modifier: Modifier = Modifier, content: @Composable BoxScope.() -> Unit) {
    val pal = LocalPalette.current
    Box(
        modifier
            .fillMaxSize()
            .background(pal.bg)
            .clickable(remember { MutableInteractionSource() }, indication = null) {},
        content = content,
    )
}

/** First letter for the fast-scroll bubble ("#" for digits and symbols). */
fun indexLetter(s: String): String {
    val c = s.trimStart().firstOrNull() ?: return ""
    return if (c.isLetter()) c.uppercaseChar().toString() else "#"
}
