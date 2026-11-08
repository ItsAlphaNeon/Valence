package app.valence.ui.screens

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.Check
import androidx.compose.material.icons.rounded.KeyboardArrowDown
import androidx.compose.material.icons.rounded.KeyboardArrowUp
import androidx.compose.material3.Checkbox
import androidx.compose.material3.Icon
import androidx.compose.material3.Slider
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.valence.data.Prefs
import app.valence.ui.LocalUi
import app.valence.ui.Overlay
import app.valence.ui.Tab
import app.valence.ui.components.DialogButtons
import app.valence.ui.components.DialogTitle
import app.valence.ui.components.HDivider
import app.valence.ui.components.IconAction
import app.valence.ui.components.MDialog
import app.valence.ui.components.RadioItem
import app.valence.ui.components.Screen
import app.valence.ui.components.SectionLabel
import app.valence.ui.components.TopBar
import app.valence.ui.theme.ACCENTS
import app.valence.ui.theme.LocalPalette
import app.valence.ui.theme.parseAccent
import app.valence.ui.theme.toHex
import java.text.DateFormat
import java.util.Date
import kotlin.math.roundToInt

private data class Choice(val value: String, val label: String)

private val THEMES = listOf(Choice("light", "Light theme"), Choice("dark", "Dark theme"), Choice("black", "Black (AMOLED)"), Choice("system", "Follow system's light/dark theme"))
private val TAP = listOf(
    Choice("named", "Play in a queue named after the list"),
    Choice("replace", "Replace the current queue"),
    Choice("next", "Play after current song"),
    Choice("add", "Add to the end of the queue"),
)
private val GAIN = listOf(Choice("auto", "Auto (album gain inside albums)"), Choice("track", "Track gain"), Choice("album", "Album gain"), Choice("off", "Off"))
private val ART_TAP = listOf(Choice("lyrics", "Show lyrics"), Choice("play", "Play or pause"), Choice("nothing", "Do nothing"))

@Composable
private fun SettingRow(title: String, summary: String? = null, onClick: (() -> Unit)? = null, trailing: (@Composable () -> Unit)? = null) {
    val pal = LocalPalette.current
    Row(
        Modifier
            .fillMaxWidth()
            .heightIn(min = 60.dp)
            .then(if (onClick != null) Modifier.clickable(onClick = onClick) else Modifier)
            .padding(start = 20.dp, end = 12.dp, top = 8.dp, bottom = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            Text(title, style = TextStyle(fontSize = 17.sp), color = pal.text)
            if (summary != null) Text(summary, style = TextStyle(fontSize = 14.sp), color = pal.text2)
        }
        trailing?.invoke()
    }
}

@Composable
private fun ChoiceRow(title: String, choices: List<Choice>, selected: String, onSelect: (String) -> Unit) {
    var open by remember { mutableStateOf(false) }
    SettingRow(title, choices.firstOrNull { it.value == selected }?.label ?: selected, onClick = { open = true })
    if (open) MDialog({ open = false }) {
        Column {
            DialogTitle(title)
            for (c in choices) RadioItem(c.label, c.value == selected) { onSelect(c.value); open = false }
            DialogButtons("Cancel" to { open = false })
        }
    }
}

@Composable
private fun SwitchRow(title: String, pref: Prefs.Pref<Boolean>, summary: String? = null) {
    val on by pref.flow.collectAsState()
    SettingRow(title, summary, onClick = { pref.value = !on }) { Switch(on, onCheckedChange = null) }
}

@Composable
private fun SliderRow(title: String, value: Float, range: ClosedFloatingPointRange<Float>, steps: Int, label: (Float) -> String, onDone: (Float) -> Unit) {
    val pal = LocalPalette.current
    var v by remember(value) { mutableFloatStateOf(value) }
    Column(Modifier.padding(start = 20.dp, end = 16.dp, top = 8.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(title, style = TextStyle(fontSize = 17.sp), color = pal.text, modifier = Modifier.weight(1f))
            Text(label(v), style = TextStyle(fontSize = 14.sp), color = pal.text2)
        }
        Slider(v, onValueChange = { v = it }, valueRange = range, steps = steps, onValueChangeFinished = { onDone(v) })
    }
}

@Composable
fun SettingsScreen() {
    val ui = LocalUi.current
    val app = ui.app
    val p = app.prefs
    val pal = LocalPalette.current
    val ctx = LocalContext.current
    val root by p.musicRoot.flow.collectAsState()
    val theme by p.theme.flow.collectAsState()
    val accent by p.accent.flow.collectAsState()
    val tabs by p.tabs.flow.collectAsState()
    val tap by p.tapBehavior.flow.collectAsState()
    val artTap by p.artTap.flow.collectAsState()
    val gain by p.replayGain.flow.collectAsState()
    val preamp by p.preampDb.flow.collectAsState()
    val fade by p.fadeMs.flow.collectAsState()
    val maxQueues by p.maxQueues.flow.collectAsState()
    val lyricsSize by p.lyricsSize.flow.collectAsState()
    val eqOn by p.eqEnabled.flow.collectAsState()
    val receiverId by p.castReceiverId.flow.collectAsState()
    val scan by app.scanner.state.collectAsState()
    val sync by app.sync.state.collectAsState()
    val lastScan by p.lastScanAt.flow.collectAsState()
    val fmt = remember { DateFormat.getDateTimeInstance(DateFormat.MEDIUM, DateFormat.SHORT) }
    var folderError by remember { mutableStateOf<String?>(null) }
    var pickingAccent by remember { mutableStateOf(false) }
    var arranging by remember { mutableStateOf(false) }
    var editingReceiver by remember { mutableStateOf(false) }
    val pickFolder = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocumentTree()) { uri ->
        if (uri == null) return@rememberLauncherForActivityResult
        val path = treeUriToPath(uri)
        if (path == null) folderError = "Pick a folder on this phone's storage or SD card."
        else if (path != root) {
            p.musicRoot.value = path
            app.refresh(force = true)
        }
    }

    Screen {
        Column(Modifier.fillMaxSize().navigationBarsPadding()) {
            TopBar("Settings", onBack = { ui.back() })
            HDivider()
            LazyColumn(contentPadding = PaddingValues(bottom = 24.dp)) {
                item { SectionLabel("Interface") }
                item { ChoiceRow("Theme", THEMES, theme) { p.theme.value = it } }
                item {
                    SettingRow("Accent color", null, onClick = { pickingAccent = true }) {
                        Box(Modifier.padding(end = 8.dp).size(28.dp).clip(CircleShape).background(parseAccent(accent)))
                    }
                }
                item { SettingRow("Arrange tabs", "Arrange tabs, or enable/disable them", onClick = { arranging = true }) }
                item { ChoiceRow("When I tap on album art", ART_TAP, artTap) { p.artTap.value = it } }
                item {
                    SliderRow("Lyrics text size", lyricsSize.toFloat(), 14f..36f, 10, { "${it.roundToInt()} sp" }) { p.lyricsSize.value = it.roundToInt() }
                }
                item { SwitchRow("Keep screen on in Now playing", p.keepScreenOn) }

                item { SectionLabel("Song library") }
                item { SettingRow("Music folder", root.ifEmpty { "Not set" }, onClick = { pickFolder.launch(null) }) }
                item {
                    SettingRow(
                        "Scan",
                        when {
                            scan.running -> if (scan.total > 0) "${scan.message} ${scan.done} of ${scan.total}" else scan.message
                            scan.message.isNotEmpty() -> scan.message
                            lastScan > 0 -> "Last change found ${fmt.format(Date(lastScan))}"
                            else -> "Checks the folder for new, changed and removed songs"
                        },
                        onClick = { if (!scan.running) app.refresh(force = true) },
                    )
                }

                item { SectionLabel("Audio") }
                item { ChoiceRow("Tapping a song", TAP, tap) { p.tapBehavior.value = it } }
                item { SettingRow("Equalizer", if (eqOn) "On" else "Off", onClick = { ui.show(Overlay.Equalizer) }) }
                item { ChoiceRow("ReplayGain", GAIN, gain) { p.replayGain.value = it } }
                item {
                    SliderRow("ReplayGain preamp", preamp, -12f..12f, 23, { "%+.0f dB".format(it) }) { p.preampDb.value = it.roundToInt().toFloat() }
                }
                item {
                    SliderRow("Fade on play and pause", fade.toFloat(), 0f..1000f, 9, { if (it < 1) "Off" else "${it.roundToInt()} ms" }) { p.fadeMs.value = (it / 100).roundToInt() * 100 }
                }
                item { SwitchRow("Skip silence", p.skipSilence) }
                item { SwitchRow("Remember position in each queue", p.rememberPosition) }
                item {
                    SliderRow("Maximum queues", maxQueues.toFloat(), 2f..20f, 17, { it.roundToInt().toString() }) { p.maxQueues.value = it.roundToInt() }
                }

                item { SectionLabel("Headset, Bluetooth and speakers") }
                item { SwitchRow("Pause when headphones disconnect", p.pauseOnDisconnect) }
                item { SwitchRow("Resume when headphones reconnect", p.resumeOnConnect, "Only if they disconnected during playback") }

                item { SectionLabel("Casting") }
                item {
                    SettingRow(
                        "TV app ID",
                        receiverId.ifEmpty { "Not set: the TV shows Google's stock screen" },
                        onClick = { editingReceiver = true },
                    )
                }

                item { SectionLabel("Sync") }
                item {
                    SettingRow(
                        "Plays, favorites and playlists",
                        buildString {
                            append(
                                when {
                                    sync.busy -> "Reading other devices' history…"
                                    sync.error != null -> "Last read failed: ${sync.error}"
                                    sync.lastIngestAt > 0 -> "Up to date as of ${fmt.format(Date(sync.lastIngestAt))}"
                                    else -> "Not read yet"
                                },
                            )
                            if (sync.devices > 0) append(" · ${sync.devices} device${if (sync.devices == 1) "" else "s"}")
                            append("\nShared through the .valence folder in your music folder. Syncthing on this phone must not ignore /.valence.")
                        },
                        onClick = { app.refresh(force = true) },
                    )
                }
                item {
                    Column(Modifier.padding(horizontal = 20.dp, vertical = 8.dp)) {
                        Text("This phone's ID", style = TextStyle(fontSize = 17.sp), color = pal.text)
                        SelectionContainer { Text(app.sync.deviceId, style = TextStyle(fontSize = 14.sp, fontFamily = FontFamily.Monospace), color = pal.text2) }
                    }
                }

                item { SectionLabel("About") }
                item {
                    val version = remember { runCatching { ctx.packageManager.getPackageInfo(ctx.packageName, 0).versionName }.getOrNull() ?: "" }
                    SettingRow("Valence $version", "Plays the music Syncthing keeps in sync. Never changes your music files.")
                }
            }
        }
    }
    if (pickingAccent) AccentDialog(accent, { p.accent.value = it }) { pickingAccent = false }
    if (arranging) TabsDialog(tabs, { p.tabs.value = it }) { arranging = false }
    if (editingReceiver) TextDialog(
        "TV app ID", receiverId, "Save",
        note = "The app ID of Valence's TV screen, from Google's Cast console. Leave it empty for Google's stock screen.",
        allowEmpty = true,
        onDismiss = { editingReceiver = false },
    ) {
        app.cast.setReceiverId(it)
        editingReceiver = false
    }
    folderError?.let { msg ->
        MDialog({ folderError = null }) {
            Column {
                DialogTitle("Can't use that folder")
                Text(msg, Modifier.padding(horizontal = 22.dp), style = TextStyle(fontSize = 15.sp), color = pal.text2)
                DialogButtons("OK" to { folderError = null })
            }
        }
    }
}

@Composable
private fun AccentDialog(current: String, onPick: (String) -> Unit, onDismiss: () -> Unit) {
    val pal = LocalPalette.current
    val sel = parseAccent(current)
    MDialog(onDismiss) {
        Column {
            DialogTitle("Accent color")
            FlowRow(Modifier.padding(horizontal = 18.dp, vertical = 8.dp), horizontalArrangement = Arrangement.spacedBy(14.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
                for (c in ACCENTS) {
                    Box(
                        Modifier.size(44.dp).clip(CircleShape).background(c)
                            .then(if (c == sel) Modifier.border(3.dp, pal.text, CircleShape) else Modifier)
                            .clickable { onPick(c.toHex()) },
                        contentAlignment = Alignment.Center,
                    ) { if (c == sel) Icon(Icons.Rounded.Check, null, tint = androidx.compose.ui.graphics.Color(0xFF111111)) }
                }
            }
            DialogButtons("Done" to onDismiss)
        }
    }
}

/** Musicolet's "Arrange tabs": tick the tabs you want and move them up or down. */
@Composable
private fun TabsDialog(current: String, onSave: (String) -> Unit, onDismiss: () -> Unit) {
    val pal = LocalPalette.current
    val enabled = remember { Tab.parse(current).toMutableSet() }
    val order = remember { mutableStateListOf<Tab>().apply { addAll(Tab.parse(current)); addAll(Tab.entries.filter { it !in this }) } }
    var on by remember { mutableStateOf(enabled.toSet()) }
    MDialog(onDismiss) {
        Column {
            DialogTitle("Arrange tabs")
            Column(Modifier.heightIn(max = 520.dp).verticalScroll(rememberScrollState())) {
                order.forEachIndexed { i, t ->
                    Row(Modifier.fillMaxWidth().height(52.dp).padding(start = 8.dp, end = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                        Checkbox(t in on, onCheckedChange = { c -> if (t != Tab.Player) on = if (c) on + t else on - t }, enabled = t != Tab.Player)
                        Icon(t.icon, null, Modifier.size(22.dp), tint = pal.text2)
                        Spacer(Modifier.width(14.dp))
                        Text(t.label, style = TextStyle(fontSize = 16.sp), color = pal.text, modifier = Modifier.weight(1f))
                        IconAction(Icons.Rounded.KeyboardArrowUp, "Move up", { if (i > 0) order.add(i - 1, order.removeAt(i)) }, tint = pal.text2, enabled = i > 0)
                        IconAction(Icons.Rounded.KeyboardArrowDown, "Move down", { if (i < order.lastIndex) order.add(i + 1, order.removeAt(i)) }, tint = pal.text2, enabled = i < order.lastIndex)
                    }
                }
            }
            DialogButtons("Cancel" to onDismiss, "Save" to {
                onSave(order.filter { it in on }.joinToString(",") { it.key })
                onDismiss()
            })
        }
    }
}

/** System equalizer and bass boost on Valence's audio session, saved in settings. */
@Composable
fun EqualizerScreen() {
    val ui = LocalUi.current
    val pb = ui.playback
    val p = ui.app.prefs
    val pal = LocalPalette.current
    @Suppress("UNUSED_VARIABLE") val version by pb.effectsVersion.collectAsState()
    val enabled by p.eqEnabled.flow.collectAsState()
    val preset by p.eqPreset.flow.collectAsState()
    val bands by p.eqBands.flow.collectAsState()
    val bass by p.bassBoost.flow.collectAsState()
    val eq = pb.equalizer
    Screen {
        Column(Modifier.fillMaxSize().navigationBarsPadding()) {
            TopBar("Equalizer", onBack = { ui.back() }) {
                Switch(enabled, onCheckedChange = { p.eqEnabled.value = it; pb.applyEffects() }, modifier = Modifier.padding(end = 12.dp))
            }
            HDivider()
            Column(Modifier.verticalScroll(rememberScrollState())) {
                if (eq == null) {
                    Text(
                        "This phone's audio system didn't offer an equalizer for Valence. Play a song and come back.",
                        Modifier.padding(20.dp), style = TextStyle(fontSize = 15.sp), color = pal.text2,
                    )
                    return@Column
                }
                val presets = remember(eq) { runCatching { (0 until eq.numberOfPresets).map { eq.getPresetName(it.toShort()) } }.getOrDefault(emptyList()) }
                val choices = listOf(Choice("-1", "Custom")) + presets.mapIndexed { i, n -> Choice(i.toString(), n) }
                ChoiceRow("Preset", choices, preset.toString()) { p.eqPreset.value = it.toInt(); pb.applyEffects() }
                val n = runCatching { eq.numberOfBands.toInt() }.getOrDefault(0)
                val range = runCatching { eq.bandLevelRange }.getOrNull() ?: shortArrayOf(-1500, 1500)
                val saved = remember(bands) { runCatching { org.json.JSONArray(bands) }.getOrNull() }
                for (b in 0 until n) {
                    val level = when {
                        preset >= 0 -> runCatching { eq.getBandLevel(b.toShort()).toInt() }.getOrDefault(0)
                        saved != null && b < saved.length() -> saved.getInt(b)
                        else -> 0
                    }
                    val hz = runCatching { eq.getCenterFreq(b.toShort()) / 1000 }.getOrDefault(0)
                    SliderRow(
                        if (hz >= 1000) "%.1f kHz".format(hz / 1000.0).replace(".0 ", " ") else "$hz Hz",
                        level.toFloat(), range[0].toFloat()..range[1].toFloat(), 0, { "%+.1f dB".format(it / 100f) },
                    ) { v ->
                        // Other bands keep what's shown: the preset's levels when leaving a preset, else the saved ones.
                        val current = (0 until n).map { i ->
                            when {
                                i == b -> v.roundToInt()
                                preset >= 0 -> runCatching { eq.getBandLevel(i.toShort()).toInt() }.getOrDefault(0)
                                else -> saved?.optInt(i, 0) ?: 0
                            }
                        }
                        p.eqBands.value = org.json.JSONArray(current).toString()
                        p.eqPreset.value = -1
                        pb.applyEffects()
                    }
                }
                if (pb.bassBoost?.strengthSupported == true) {
                    HDivider(Modifier.padding(vertical = 8.dp))
                    SliderRow("Bass boost", bass.toFloat(), 0f..1000f, 9, { if (it < 1) "Off" else "${(it / 10).roundToInt()}%" }) {
                        p.bassBoost.value = it.roundToInt()
                        pb.applyEffects()
                    }
                }
            }
        }
    }
}
