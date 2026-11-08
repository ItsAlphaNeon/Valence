package app.valence.ui.screens

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.Undo
import androidx.compose.material.icons.rounded.Edit
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Stable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.valence.data.TagSaver
import app.valence.data.Track
import app.valence.tags.TagEdit
import app.valence.tags.TagField
import app.valence.tags.TagReader
import app.valence.tags.TagWriter
import app.valence.tags.TrackTags
import app.valence.tags.valueOf
import app.valence.ui.LocalUi
import app.valence.ui.Notice
import app.valence.ui.UiActions
import app.valence.ui.components.DialogButtons
import app.valence.ui.components.DialogTitle
import app.valence.ui.components.HDivider
import app.valence.ui.components.IconAction
import app.valence.ui.components.MDialog
import app.valence.ui.components.Screen
import app.valence.ui.components.TopBar
import app.valence.ui.components.songs
import app.valence.ui.theme.LocalPalette
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.util.Locale

/** Most songs the editor takes at once (a big folder or album is fine; the whole library isn't). */
const val TAG_EDIT_MAX = 1000

private val ERROR = Color(0xFFE57373)

/** One field as the editor shows it: [label], and whether it makes sense for many songs at once. */
private class Def(val field: TagField, val label: String, val many: Boolean, val number: Boolean = false)

private val DEFS = listOf(
    Def(TagField.TITLE, "Title", many = false),
    Def(TagField.ARTIST, "Artist", many = true),
    Def(TagField.ALBUM, "Album", many = true),
    Def(TagField.ALBUM_ARTIST, "Album artist", many = true),
    Def(TagField.GENRE, "Genre", many = true),
    Def(TagField.COMPOSER, "Composer", many = true),
    Def(TagField.DATE, "Year", many = true, number = true),
    Def(TagField.TRACK_NO, "Track", many = false, number = true),
    Def(TagField.TRACK_TOTAL, "Of", many = true, number = true),
    Def(TagField.DISC_NO, "Disc", many = true, number = true),
    Def(TagField.DISC_TOTAL, "Of", many = true, number = true),
)

/**
 * A field's edit. With several songs whose values differ it starts empty and stays out of the save
 * until typed into (or a value is picked from [distinct]); then the typed value goes to every song.
 */
@Stable
private class FieldState(val def: Def, values: List<String?>) {
    /** Current values, most common first ("" for songs without one). */
    val distinct: List<Pair<String, Int>> = values.map { it?.trim().orEmpty() }.groupingBy { it }.eachCount()
        .entries.sortedByDescending { it.value }.map { it.key to it.value }
    val mixed = distinct.size > 1
    val initial = if (mixed) "" else distinct.firstOrNull()?.first.orEmpty()
    var text by mutableStateOf(initial)
        private set
    var touched by mutableStateOf(false)
        private set
    val changed: Boolean get() = touched && (mixed || text.trim() != initial)
    val problem: String? get() = if (changed) TagEdit.problem(def.field, text) else null

    fun set(v: String) { text = v; touched = true }
    fun reset() { text = initial; touched = false }
}

private class Loaded(val tracks: List<Track>, val fields: Map<TagField, FieldState>, val skipped: List<Pair<Track, String>>, val folders: Int)

@Composable
fun TagEditorScreen() {
    val tracks = LocalUi.current.tagEditing
    if (tracks.isEmpty()) return
    key(tracks) { Editor(tracks) }
}

@Composable
private fun Editor(tracks: List<Track>) {
    val ui = LocalUi.current
    val pal = LocalPalette.current
    val focus = LocalFocusManager.current
    val keyboard = LocalSoftwareKeyboardController.current
    // Opened from search, the search box still has the keyboard; start with it closed.
    LaunchedEffect(Unit) { focus.clearFocus(force = true); keyboard?.hide() }
    val loaded by produceState<Loaded?>(null) { value = withContext(Dispatchers.IO) { load(ui, tracks) } }
    var confirming by remember { mutableStateOf(false) }
    var discarding by remember { mutableStateOf(false) }
    var saving by remember { mutableStateOf(false) }
    var outcome by remember { mutableStateOf<Pair<List<TagSaver.Failure>, Int>?>(null) }

    val l = loaded
    val changed = l?.fields?.values?.filter { it.changed }.orEmpty()
    val canSave = l != null && changed.isNotEmpty() && changed.all { it.problem == null } && !saving
    val many = (l?.tracks?.size ?: tracks.size) > 1

    fun leave() {
        when {
            saving -> {}
            changed.isNotEmpty() -> discarding = true
            else -> ui.closeTagEditor()
        }
    }
    BackHandler { leave() }

    fun save() {
        val ld = l ?: return
        val edit = runCatching { TagEdit(changed.associate { it.def.field to it.text }) }.getOrNull() ?: return
        focus.clearFocus()
        saving = true
        ui.app.scope.launch {
            val r = ui.app.tagSaver.save(ld.tracks, edit)
            withContext(Dispatchers.Main) {
                if (r.saved.isNotEmpty()) ui.playback.reloadEdited(r.saved.mapTo(HashSet()) { it.id })
                for ((old, new) in r.albumMoves) ui.albumMoved(old, new)
                saving = false
                if (r.failures.isEmpty()) {
                    ui.closeTagEditor()
                    val already = r.unchanged.size
                    ui.notice = Notice(
                        when {
                            r.saved.isEmpty() -> if (already == 1) "Nothing to change: the song already has these tags" else "Nothing to change: the songs already have these tags"
                            already > 0 -> "Tags saved in ${songs(r.saved.size)} · ${songs(already)} already had them"
                            r.saved.size == 1 -> "Tags saved"
                            else -> "Tags saved in ${songs(r.saved.size)}"
                        },
                    )
                } else {
                    outcome = r.failures to r.saved.size
                }
            }
        }
    }

    Screen {
        Column(Modifier.fillMaxSize().navigationBarsPadding().imePadding()) {
            TopBar(if (many) "Edit tags · ${songs(l?.tracks?.size ?: tracks.size)}" else "Edit tags", onBack = { leave() }) {
                SaveAction(canSave) { if (many) confirming = true else save() }
            }
            HDivider()
            when {
                l == null -> Box(Modifier.fillMaxWidth().padding(top = 48.dp), contentAlignment = Alignment.Center) {
                    CircularProgressIndicator(color = pal.accent)
                }
                else -> Column(Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(horizontal = 20.dp)) {
                    Header(l)
                    if (l.tracks.isNotEmpty()) Fields(l)
                    Spacer(Modifier.height(32.dp))
                }
            }
        }
    }

    if (confirming && l != null) {
        MDialog({ confirming = false }) {
            Column {
                DialogTitle("Save tags in ${songs(l.tracks.size)}?")
                Text(
                    "Valence rewrites these files on this phone, and Syncthing then copies them to your other devices. " +
                        "Each file is checked before it replaces the original; one that fails a check is left as it was.",
                    Modifier.padding(horizontal = 22.dp), style = TextStyle(fontSize = 15.sp), color = pal.text2,
                )
                DialogButtons("Cancel" to { confirming = false }, "Save" to { confirming = false; save() })
            }
        }
    }
    if (discarding) {
        MDialog({ discarding = false }) {
            Column {
                DialogTitle("Discard your changes?")
                DialogButtons("Keep editing" to { discarding = false }, "Discard" to { discarding = false; ui.closeTagEditor() })
            }
        }
    }
    if (saving) SavingDialog()
    outcome?.let { (failures, saved) ->
        val close = {
            outcome = null
            // With nothing saved, stay so the edits aren't lost; otherwise the rest is done.
            if (saved > 0) ui.closeTagEditor()
        }
        MDialog(close) {
            Column {
                DialogTitle(if (saved == 0) "Nothing was saved" else "Saved ${songs(saved)}, ${failures.size} left as they were")
                Column(Modifier.heightIn(max = 420.dp).verticalScroll(rememberScrollState()).padding(horizontal = 22.dp)) {
                    for (f in failures) {
                        Text(f.track.title, style = TextStyle(fontSize = 15.sp, fontWeight = FontWeight.Medium), color = pal.text, modifier = Modifier.padding(top = 8.dp))
                        Text(f.reason, style = TextStyle(fontSize = 14.sp), color = pal.text2)
                    }
                }
                DialogButtons("OK" to close)
            }
        }
    }
}

@Composable
private fun SaveAction(enabled: Boolean, onClick: () -> Unit) {
    val pal = LocalPalette.current
    Box(
        Modifier.padding(end = 8.dp).height(40.dp).clip(RoundedCornerShape(4.dp)).clickable(enabled = enabled, onClick = onClick).padding(horizontal = 14.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            "SAVE", style = TextStyle(fontSize = 15.sp, fontWeight = FontWeight.Medium, letterSpacing = 0.8.sp),
            color = if (enabled) pal.accent else pal.text3,
        )
    }
}

@Composable
private fun SavingDialog() {
    val pal = LocalPalette.current
    val p by LocalUi.current.app.tagSaver.progress.collectAsState()
    MDialog({}) {
        Column(Modifier.padding(horizontal = 22.dp, vertical = 12.dp)) {
            Text("Saving tags…", style = TextStyle(fontSize = 19.sp, fontWeight = FontWeight.Medium), color = pal.text)
            Spacer(Modifier.height(16.dp))
            val q = p
            if (q != null && q.total > 1) {
                LinearProgressIndicator(progress = { q.done.toFloat() / q.total }, Modifier.fillMaxWidth(), color = pal.accent, trackColor = pal.outline)
                Text("${q.done} of ${q.total}", Modifier.padding(top = 8.dp), style = TextStyle(fontSize = 14.sp), color = pal.text2)
            } else {
                LinearProgressIndicator(Modifier.fillMaxWidth(), color = pal.accent, trackColor = pal.outline)
            }
            Spacer(Modifier.height(8.dp))
        }
    }
}

@Composable
private fun Header(l: Loaded) {
    val pal = LocalPalette.current
    val small = TextStyle(fontSize = 14.sp)
    Spacer(Modifier.height(12.dp))
    when {
        l.tracks.size == 1 -> {
            val t = l.tracks[0]
            Text(t.relPath, style = small.copy(fontFamily = FontFamily.Monospace, fontSize = 13.sp), color = pal.text2)
        }
        l.tracks.size > 1 -> Text(
            "Fields that differ between the songs are left alone unless you change them. Tap a value under a field to use it for every song.",
            style = small, color = pal.text2,
        )
    }
    if (l.skipped.isNotEmpty()) {
        Spacer(Modifier.height(10.dp))
        Column(Modifier.fillMaxWidth().border(1.dp, pal.outline, RoundedCornerShape(6.dp)).padding(12.dp)) {
            Text(
                if (l.tracks.isEmpty()) "These songs can't be edited here:"
                else "${songs(l.skipped.size).replaceFirstChar { it.uppercase(Locale.ROOT) }} can't be edited here and will be left out:",
                style = small.copy(fontWeight = FontWeight.Medium), color = pal.text,
            )
            for ((t, why) in l.skipped.take(8)) Text("${t.title}: $why", style = small, color = pal.text2, modifier = Modifier.padding(top = 4.dp))
            if (l.skipped.size > 8) Text("and ${l.skipped.size - 8} more", style = small, color = pal.text2, modifier = Modifier.padding(top = 4.dp))
        }
    }
}

@Composable
private fun Fields(l: Loaded) {
    val f = l.fields
    for (d in listOf(TagField.TITLE, TagField.ARTIST, TagField.ALBUM, TagField.ALBUM_ARTIST, TagField.GENRE, TagField.COMPOSER, TagField.DATE)) {
        val s = f[d] ?: continue
        val note = if (d == TagField.ALBUM && l.folders > 1 && s.changed) {
            "These songs are in ${l.folders} folders. Valence groups albums by folder, so each folder stays its own album."
        } else null
        Field(s, l.tracks.size, note = note)
    }
    Row(horizontalArrangement = Arrangement.spacedBy(20.dp)) {
        f[TagField.TRACK_NO]?.let { Field(it, l.tracks.size, Modifier.weight(1f)) }
        f[TagField.TRACK_TOTAL]?.let { Field(it, l.tracks.size, Modifier.weight(1f), label = if (TagField.TRACK_NO in f) "Of" else "Tracks on the album") }
    }
    Row(horizontalArrangement = Arrangement.spacedBy(20.dp)) {
        f[TagField.DISC_NO]?.let { Field(it, l.tracks.size, Modifier.weight(1f)) }
        f[TagField.DISC_TOTAL]?.let { Field(it, l.tracks.size, Modifier.weight(1f)) }
    }
}

@Composable
private fun Field(s: FieldState, count: Int, modifier: Modifier = Modifier, label: String = s.def.label, note: String? = null) {
    val pal = LocalPalette.current
    var focused by remember { mutableStateOf(false) }
    val problem = s.problem
    val line = when {
        problem != null -> ERROR
        focused -> pal.accent
        else -> pal.outline
    }
    Column(modifier.fillMaxWidth().padding(top = 14.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.height(28.dp)) {
            Text(
                label, style = TextStyle(fontSize = 13.sp, fontWeight = FontWeight.Medium),
                color = if (focused) pal.accent else pal.text2, modifier = Modifier.weight(1f),
            )
            if (s.changed) IconAction(Icons.AutoMirrored.Rounded.Undo, "Undo the change to ${label.lowercase(Locale.ROOT)}", { s.reset() }, tint = pal.text2, size = 18.dp, box = 28.dp)
        }
        BasicTextField(
            s.text, { s.set(it) },
            singleLine = true,
            textStyle = TextStyle(fontSize = 17.sp, color = pal.text),
            cursorBrush = SolidColor(pal.accent),
            keyboardOptions = KeyboardOptions(
                capitalization = if (s.def.number) KeyboardCapitalization.None else KeyboardCapitalization.Words,
                keyboardType = if (s.def.number) KeyboardType.Number else KeyboardType.Text,
                imeAction = ImeAction.Next,
            ),
            modifier = Modifier.fillMaxWidth().onFocusChanged { focused = it.isFocused }.semantics { contentDescription = label },
            decorationBox = { inner ->
                Column {
                    Box(Modifier.padding(vertical = 6.dp)) {
                        if (s.text.isEmpty()) {
                            val hint = when {
                                s.mixed && !s.touched -> "Different values (left as they are)"
                                s.touched && s.distinct.any { it.first.isNotEmpty() } -> if (count > 1) "Removed from every song" else "Removed"
                                else -> ""
                            }
                            Text(hint, style = TextStyle(fontSize = 17.sp, fontStyle = FontStyle.Italic), color = pal.text3, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        }
                        inner()
                    }
                    Box(Modifier.fillMaxWidth().height(if (focused || problem != null) 2.dp else 1.dp).background(line))
                }
            },
        )
        when {
            problem != null -> Text(problem, style = TextStyle(fontSize = 13.sp), color = ERROR, modifier = Modifier.padding(top = 4.dp))
            note != null -> Text(note, style = TextStyle(fontSize = 13.sp), color = pal.text2, modifier = Modifier.padding(top = 4.dp))
        }
        // Several songs disagree: offer their values, most common first, so one tap makes them match.
        val picks = s.distinct.filter { it.first.isNotEmpty() }.take(6)
        if (s.mixed && picks.isNotEmpty()) {
            FlowRow(Modifier.padding(top = 8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                for ((v, n) in picks) ValueChip(v, n, selected = s.touched && s.text.trim() == v) { s.set(v) }
            }
        }
    }
}

@Composable
private fun ValueChip(value: String, count: Int, selected: Boolean, onClick: () -> Unit) {
    val pal = LocalPalette.current
    val shape = RoundedCornerShape(50)
    Row(
        Modifier.widthIn(max = 300.dp).height(34.dp).clip(shape).border(1.dp, if (selected) pal.accent else pal.outline, shape)
            .clickable(onClickLabel = "Use for every song", onClick = onClick).padding(horizontal = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(value, style = TextStyle(fontSize = 14.sp), color = if (selected) pal.accent else pal.text, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
        Text("  $count", style = TextStyle(fontSize = 13.sp), color = pal.text3, maxLines = 1)
    }
}

/** Reads every song's current tags from its file (not the index), and sets aside what can't be edited. */
private fun load(ui: UiActions, tracks: List<Track>): Loaded {
    val ok = ArrayList<Track>()
    val tags = ArrayList<TrackTags>()
    val skipped = ArrayList<Pair<Track, String>>()
    for (t in tracks.distinctBy { it.id }.take(TAG_EDIT_MAX)) {
        val file = ui.library.fileOf(t)
        if (!file.isFile) { skipped.add(t to "The file isn't there"); continue }
        val why = TagWriter.unsupportedReason(file)
        if (why != null) { skipped.add(t to why); continue }
        val r = runCatching { TagReader.read(file) }.getOrNull()
        if (r == null) { skipped.add(t to "Its tags can't be read"); continue }
        ok.add(t)
        tags.add(r.tags)
    }
    val many = ok.size > 1
    val fields = LinkedHashMap<TagField, FieldState>()
    for (d in DEFS) if (!many || d.many) fields[d.field] = FieldState(d, tags.map { it.valueOf(d.field) })
    return Loaded(ok, fields, skipped, ok.map { it.relPath.substringBeforeLast('/', "") }.distinct().size)
}

/** "Edit tags" for a menu, when [tracks] is a size the editor takes. */
@Composable
fun EditTagsItem(tracks: List<Track>, close: () -> Unit) {
    val ui = LocalUi.current
    if (tracks.isEmpty() || tracks.size > TAG_EDIT_MAX) return
    app.valence.ui.components.DialogItem(Icons.Rounded.Edit, if (tracks.size == 1) "Edit tags" else "Edit tags of ${songs(tracks.size)}", { close(); ui.editTags(tracks) })
}
