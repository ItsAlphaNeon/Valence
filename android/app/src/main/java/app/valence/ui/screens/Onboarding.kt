package app.valence.ui.screens

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.DocumentsContract
import android.provider.Settings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.Folder
import androidx.compose.material.icons.rounded.LibraryMusic
import androidx.compose.material3.Button
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import java.io.File

/** Valence reads the music folder directly (fast scans) and writes its own .valence logs, so it needs all-files access. */
fun hasStorageAccess(ctx: Context): Boolean =
    if (Build.VERSION.SDK_INT >= 30) Environment.isExternalStorageManager()
    else ContextCompat.checkSelfPermission(ctx, Manifest.permission.WRITE_EXTERNAL_STORAGE) == PackageManager.PERMISSION_GRANTED

/** "primary:Music" style tree URIs → a filesystem path; null when the folder isn't on local storage. */
fun treeUriToPath(uri: Uri): String? {
    val id = runCatching { DocumentsContract.getTreeDocumentId(uri) }.getOrNull() ?: return null
    val (vol, rel) = id.split(':', limit = 2).let { it[0] to it.getOrElse(1) { "" } }
    val base = if (vol.equals("primary", true)) Environment.getExternalStorageDirectory().path else "/storage/$vol"
    return if (rel.isEmpty()) base else "$base/$rel"
}

/** The folder Valence suggests: the standard Music folder, preferring one that already holds a synced library. */
fun suggestedRoot(): String = File(Environment.getExternalStorageDirectory(), Environment.DIRECTORY_MUSIC).path

@Composable
fun Onboarding(hasAccess: Boolean, root: String, onRequestAccess: () -> Unit, onRoot: (String) -> Unit) {
    val ctx = LocalContext.current
    val pick = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocumentTree()) { uri ->
        uri?.let(::treeUriToPath)?.let(onRoot)
    }
    val legacyPerm = rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { onRequestAccess() }
    Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
        Column(
            Modifier.safeDrawingPadding().padding(28.dp).fillMaxSize(),
            verticalArrangement = Arrangement.Center,
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Icon(Icons.Rounded.LibraryMusic, null, Modifier.size(72.dp), tint = MaterialTheme.colorScheme.primary)
            Spacer(Modifier.height(20.dp))
            Text("Welcome to Valence", style = MaterialTheme.typography.headlineMedium)
            Spacer(Modifier.height(12.dp))
            if (!hasAccess) {
                Text(
                    "Valence plays the music folder Syncthing keeps in sync. To read it quickly, and to share your plays, likes and playlists with your other devices, it needs access to all files.\n\nValence never changes your music files.",
                    textAlign = TextAlign.Center,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Spacer(Modifier.height(28.dp))
                Button(onClick = {
                    if (Build.VERSION.SDK_INT >= 30) {
                        val intent = Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION, Uri.parse("package:${ctx.packageName}"))
                        runCatching { ctx.startActivity(intent) }.onFailure { ctx.startActivity(Intent(Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION)) }
                    } else {
                        legacyPerm.launch(arrayOf(Manifest.permission.READ_EXTERNAL_STORAGE, Manifest.permission.WRITE_EXTERNAL_STORAGE))
                    }
                }, Modifier.fillMaxWidth()) { Text("Allow access") }
            } else {
                Text(
                    "Choose the folder that holds your library, the one Syncthing syncs (it has a hidden .valence folder inside).",
                    textAlign = TextAlign.Center,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Spacer(Modifier.height(28.dp))
                val suggested = suggestedRoot()
                if (root.isEmpty() && File(suggested).isDirectory) {
                    Button(onClick = { onRoot(suggested) }, Modifier.fillMaxWidth()) { Text("Use ${suggested.removePrefix(Environment.getExternalStorageDirectory().path + "/")}") }
                    Spacer(Modifier.height(10.dp))
                }
                OutlinedButton(onClick = { pick.launch(null) }, Modifier.fillMaxWidth()) {
                    Icon(Icons.Rounded.Folder, null)
                    Text("  Choose another folder")
                }
            }
        }
    }
}
