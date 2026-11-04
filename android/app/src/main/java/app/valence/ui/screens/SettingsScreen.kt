package app.valence.ui.screens

import android.os.Build
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.ListItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Slider
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import app.valence.data.Prefs
import app.valence.ui.LocalUi
import app.valence.ui.components.SectionTitle
import java.text.DateFormat
import java.util.Date
import kotlin.math.roundToInt

private data class Choice(val value: String, val label: String)

private val THEMES = listOf(Choice("system", "Follow system"), Choice("light", "Light"), Choice("dark", "Dark"), Choice("black", "Black (AMOLED)"))
private val TAP = listOf(
    Choice("named", "Play in a queue named after the list"),
    Choice("replace", "Replace the current queue"),
    Choice("next", "Play next"),
    Choice("add", "Add to the end of the queue"),
)
private val GAIN = listOf(Choice("auto", "Auto (album gain inside albums)"), Choice("track", "Track gain"), Choice("album", "Album gain"), Choice("off", "Off"))

@Composable
private fun ChoiceRow(title: String, choices: List<Choice>, selected: String, onSelect: (String) -> Unit) {
    var open by remember { mutableStateOf(false) }
    ListItem(
        headlineContent = { Text(title) },
        supportingContent = { Text(choices.firstOrNull { it.value == selected }?.label ?: selected) },
        modifier = Modifier.clickable { open = true },
    )
    if (open) AlertDialog(
        onDismissRequest = { open = false },
        title = { Text(title) },
        text = {
            Column {
                for (c in choices) Row(
                    Modifier.fillMaxWidth().selectable(c.value == selected, role = Role.RadioButton) { onSelect(c.value); open = false }.padding(vertical = 10.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    RadioButton(c.value == selected, onClick = null)
                    Spacer(Modifier.width(12.dp))
                    Text(c.label)
                }
            }
        },
        confirmButton = { TextButton(onClick = { open = false }) { Text("Cancel") } },
    )
}

@Composable
private fun SwitchRow(title: String, pref: Prefs.Pref<Boolean>, subtitle: String? = null, enabled: Boolean = true) {
    val on by pref.flow.collectAsState()
    ListItem(
        headlineContent = { Text(title) },
        supportingContent = subtitle?.let { { Text(it) } },
        trailingContent = { Switch(on, onCheckedChange = null, enabled = enabled) },
        modifier = Modifier.clickable(enabled = enabled) { pref.value = !on },
    )
}

@Composable
private fun SliderRow(title: String, value: Float, range: ClosedFloatingPointRange<Float>, steps: Int, label: (Float) -> String, onDone: (Float) -> Unit) {
    var v by remember(value) { mutableFloatStateOf(value) }
    Column(Modifier.padding(horizontal = 16.dp, vertical = 8.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(title, style = MaterialTheme.typography.bodyLarge, modifier = Modifier.weight(1f))
            Text(label(v), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        Slider(v, onValueChange = { v = it }, valueRange = range, steps = steps, onValueChangeFinished = { onDone(v) })
    }
}

@Composable
fun SettingsScreen(bottomPadding: PaddingValues) {
    val ui = LocalUi.current
    val app = ui.app
    val p = app.prefs
    val ctx = LocalContext.current
    val root by p.musicRoot.flow.collectAsState()
    val theme by p.theme.flow.collectAsState()
    val tap by p.tapBehavior.flow.collectAsState()
    val gain by p.replayGain.flow.collectAsState()
    val preamp by p.preampDb.flow.collectAsState()
    val fade by p.fadeMs.flow.collectAsState()
    val maxQueues by p.maxQueues.flow.collectAsState()
    val lyricsSize by p.lyricsSize.flow.collectAsState()
    val scan by app.scanner.state.collectAsState()
    val sync by app.sync.state.collectAsState()
    val lastScan by p.lastScanAt.flow.collectAsState()
    val fmt = remember { DateFormat.getDateTimeInstance(DateFormat.MEDIUM, DateFormat.SHORT) }
    var folderError by remember { mutableStateOf<String?>(null) }
    val pickFolder = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocumentTree()) { uri ->
        if (uri == null) return@rememberLauncherForActivityResult
        val path = treeUriToPath(uri)
        if (path == null) folderError = "Pick a folder on this phone's storage or SD card."
        else if (path != root) {
            p.musicRoot.value = path
            app.refresh(force = true)
        }
    }

    Column(Modifier.fillMaxSize()) {
        DetailTopBar("Settings")
        LazyColumn(contentPadding = bottomPadding) {
            item { SectionTitle("Library") }
            item {
                ListItem(
                    headlineContent = { Text("Music folder") },
                    supportingContent = { Text(root.ifEmpty { "Not set" }) },
                    modifier = Modifier.clickable { pickFolder.launch(null) },
                )
            }
            item {
                ListItem(
                    headlineContent = { Text("Rescan now") },
                    supportingContent = {
                        Text(
                            when {
                                scan.running -> if (scan.total > 0) "${scan.message} ${scan.done} of ${scan.total}" else scan.message
                                scan.message.isNotEmpty() -> scan.message
                                lastScan > 0 -> "Last change found ${fmt.format(Date(lastScan))}"
                                else -> "Checks the folder for new, changed and removed songs"
                            },
                        )
                    },
                    modifier = Modifier.clickable(enabled = !scan.running) { app.refresh(force = true) },
                )
            }

            item { SectionTitle("Playback") }
            item { ChoiceRow("Tapping a song", TAP, tap) { p.tapBehavior.value = it } }
            item { ChoiceRow("ReplayGain", GAIN, gain) { p.replayGain.value = it } }
            item {
                SliderRow("ReplayGain preamp", preamp, -12f..12f, 23, { "%+.0f dB".format(it) }) { p.preampDb.value = it.roundToInt().toFloat() }
            }
            item {
                SliderRow("Fade on play and pause", fade.toFloat(), 0f..1000f, 9, { if (it < 1) "Off" else "${it.roundToInt()} ms" }) { p.fadeMs.value = (it / 100).roundToInt() * 100 }
            }
            item {
                ListItem(
                    headlineContent = { Text("Equalizer") },
                    supportingContent = { Text(if (p.eqEnabled.flow.collectAsState().value) "On" else "Off") },
                    modifier = Modifier.clickable { ui.go("equalizer") },
                )
            }
            item { SwitchRow("Pause when headphones disconnect", p.pauseOnDisconnect) }
            item { SwitchRow("Resume when headphones reconnect", p.resumeOnConnect, "Only if they disconnected during playback") }
            item { SwitchRow("Skip silence", p.skipSilence) }
            item { SwitchRow("Remember position in each queue", p.rememberPosition) }
            item {
                SliderRow("Maximum queues", maxQueues.toFloat(), 2f..20f, 17, { it.roundToInt().toString() }) { p.maxQueues.value = it.roundToInt() }
            }

            item { SectionTitle("Appearance") }
            item { ChoiceRow("Theme", THEMES, theme) { p.theme.value = it } }
            item {
                SwitchRow(
                    "Material You colors", p.dynamicColor,
                    if (Build.VERSION.SDK_INT >= 31) "Use the wallpaper's colors instead of the album art's" else "Needs Android 12",
                    enabled = Build.VERSION.SDK_INT >= 31,
                )
            }
            item { SwitchRow("Tint with album art", p.artTint, "Colors follow the song that's playing") }
            item { SwitchRow("Album grid", p.gridAlbums) }
            item {
                SliderRow("Lyrics text size", lyricsSize.toFloat(), 14f..36f, 10, { "${it.roundToInt()} sp" }) { p.lyricsSize.value = it.roundToInt() }
            }
            item { SwitchRow("Keep screen on in Now Playing", p.keepScreenOn) }

            item { SectionTitle("Sync") }
            item {
                ListItem(
                    headlineContent = { Text("Plays, likes and playlists") },
                    supportingContent = {
                        Text(
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
                        )
                    },
                    modifier = Modifier.clickable { app.refresh(force = true) },
                )
            }
            item {
                ListItem(
                    headlineContent = { Text("This phone's ID") },
                    supportingContent = { SelectionContainer { Text(app.sync.deviceId, fontFamily = FontFamily.Monospace) } },
                )
            }

            item { SectionTitle("About") }
            item {
                val version = remember { runCatching { ctx.packageManager.getPackageInfo(ctx.packageName, 0).versionName }.getOrNull() ?: "" }
                ListItem(
                    headlineContent = { Text("Valence $version") },
                    supportingContent = { Text("Plays the music Syncthing keeps in sync. Never changes your music files.") },
                )
            }
            item { Spacer(Modifier.height(24.dp)) }
        }
    }
    folderError?.let { msg ->
        AlertDialog(
            onDismissRequest = { folderError = null },
            title = { Text("Can't use that folder") },
            text = { Text(msg) },
            confirmButton = { TextButton(onClick = { folderError = null }) { Text("OK") } },
        )
    }
}

/** System equalizer and bass boost on Valence's audio session, saved in settings. */
@Composable
fun EqualizerScreen(bottomPadding: PaddingValues) {
    val ui = LocalUi.current
    val pb = ui.playback
    val p = ui.app.prefs
    @Suppress("UNUSED_VARIABLE") val version by pb.effectsVersion.collectAsState()
    val enabled by p.eqEnabled.flow.collectAsState()
    val preset by p.eqPreset.flow.collectAsState()
    val bands by p.eqBands.flow.collectAsState()
    val bass by p.bassBoost.flow.collectAsState()
    val eq = pb.equalizer
    Column(Modifier.fillMaxSize()) {
        DetailTopBar("Equalizer")
        Column(Modifier.verticalScroll(rememberScrollState()).padding(bottomPadding)) {
            ListItem(
                headlineContent = { Text("Equalizer") },
                trailingContent = { Switch(enabled, onCheckedChange = null) },
                modifier = Modifier.clickable { p.eqEnabled.value = !enabled; pb.applyEffects() },
            )
            HorizontalDivider()
            if (eq == null) {
                Text(
                    "This phone's audio system didn't offer an equalizer for Valence. Play a song and come back.",
                    Modifier.padding(16.dp), color = MaterialTheme.colorScheme.onSurfaceVariant,
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
                HorizontalDivider()
                SliderRow("Bass boost", bass.toFloat(), 0f..1000f, 9, { if (it < 1) "Off" else "${(it / 10).roundToInt()}%" }) {
                    p.bassBoost.value = it.roundToInt()
                    pb.applyEffects()
                }
            }
        }
    }
}
