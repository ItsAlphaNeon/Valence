package app.valence.ui.screens

import android.content.pm.PackageManager
import android.os.Build
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.VolumeDown
import androidx.compose.material.icons.automirrored.rounded.VolumeUp
import androidx.compose.material.icons.rounded.Cast
import androidx.compose.material.icons.rounded.CastConnected
import androidx.compose.material.icons.rounded.Tv
import androidx.compose.material3.Icon
import androidx.compose.material3.Slider
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.valence.cast.CastManager
import app.valence.ui.LocalUi
import app.valence.ui.components.DialogButtons
import app.valence.ui.components.DialogItem
import app.valence.ui.components.DialogTitle
import app.valence.ui.components.MDialog
import app.valence.ui.theme.LocalPalette
import kotlinx.coroutines.delay

private const val LOCAL_NETWORK = "android.permission.ACCESS_LOCAL_NETWORK"

/** Picks a TV; once casting, its volume, the lyrics switch, and the way to stop. */
@Composable
fun CastDialog(onDismiss: () -> Unit) {
    val cast = LocalUi.current.app.cast
    val tv by cast.tvName.collectAsState()
    val current = tv
    if (current == null) PickTv(cast, onDismiss) else Casting(cast, current, onDismiss)
}

@Composable
private fun PickTv(cast: CastManager, onDismiss: () -> Unit) {
    val pal = LocalPalette.current
    val ctx = LocalContext.current
    val devices by cast.devices.collectAsState()
    val connecting by cast.connecting.collectAsState()
    val error by cast.error.collectAsState()
    var waited by remember { mutableStateOf(false) }

    // From Android 17, an app must ask before anything on the local network can reach it. Without this
    // the TV would connect and then time out fetching the music.
    var denied by remember { mutableStateOf(false) }
    val ask = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { denied = !it }
    LaunchedEffect(Unit) {
        if (Build.VERSION.SDK_INT >= 37 && ctx.checkSelfPermission(LOCAL_NETWORK) != PackageManager.PERMISSION_GRANTED) ask.launch(LOCAL_NETWORK)
    }
    DisposableEffect(Unit) {
        cast.startScan()
        onDispose { cast.stopScan() }
    }
    LaunchedEffect(Unit) {
        delay(8_000)
        waited = true
    }

    MDialog(onDismiss) {
        Column {
            DialogTitle("Cast to a TV", icon = Icons.Rounded.Cast)
            val note = when {
                connecting != null -> "Connecting to $connecting…"
                denied -> "Valence needs the local network permission so the TV can play from this phone. You can turn it on in the app's settings."
                error != null -> error
                devices.isNotEmpty() -> null
                waited -> "No TVs found. Check that the TV is on and on the same Wi-Fi as this phone."
                else -> "Looking for TVs on your Wi-Fi…"
            }
            if (note != null) Text(note, Modifier.padding(horizontal = 22.dp, vertical = 6.dp), style = TextStyle(fontSize = 15.sp), color = pal.text2)
            Column(Modifier.verticalScroll(rememberScrollState())) {
                for (d in devices) DialogItem(Icons.Rounded.Tv, d.name, { cast.connect(d) }, enabled = connecting == null && !denied)
            }
            DialogButtons("Close" to onDismiss)
        }
    }
}

@Composable
private fun Casting(cast: CastManager, name: String, onDismiss: () -> Unit) {
    val pal = LocalPalette.current
    val prefs = LocalUi.current.app.prefs
    val volume by cast.volume.collectAsState()
    val lyrics by prefs.castLyrics.flow.collectAsState()
    val stock = cast.usesStockScreen
    MDialog(onDismiss) {
        Column {
            DialogTitle(name, icon = Icons.Rounded.CastConnected)
            Row(Modifier.fillMaxWidth().padding(horizontal = 22.dp), verticalAlignment = Alignment.CenterVertically) {
                Icon(Icons.AutoMirrored.Rounded.VolumeDown, null, Modifier.size(24.dp), tint = pal.text2)
                Spacer(Modifier.width(8.dp))
                Slider(volume, { cast.setVolume(it) }, Modifier.weight(1f))
                Spacer(Modifier.width(8.dp))
                Icon(Icons.AutoMirrored.Rounded.VolumeUp, null, Modifier.size(24.dp), tint = pal.text2)
            }
            if (stock) {
                Text(
                    "The TV is showing Google's stock screen. Add the TV app ID in Settings to get Valence's screen, with lyrics.",
                    Modifier.padding(horizontal = 22.dp, vertical = 8.dp),
                    style = TextStyle(fontSize = 14.sp), color = pal.text2,
                )
            } else {
                Row(
                    Modifier.fillMaxWidth().height(52.dp).clickable { prefs.castLyrics.value = !lyrics }.padding(horizontal = 22.dp),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text("Show lyrics on the TV", style = TextStyle(fontSize = 16.sp), color = pal.text)
                    Switch(lyrics, onCheckedChange = null)
                }
            }
            DialogButtons("Stop casting" to { cast.stop(); onDismiss() }, "Close" to onDismiss)
        }
    }
}
