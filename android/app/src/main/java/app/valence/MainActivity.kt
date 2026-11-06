package app.valence

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.view.KeyEvent
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LifecycleEventEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.valence.ui.ValenceRoot
import app.valence.ui.screens.Onboarding
import app.valence.ui.screens.hasStorageAccess
import app.valence.ui.theme.ValenceTheme

class MainActivity : ComponentActivity() {
    /** Bumped whenever an intent asks for the player (notification tap), so the UI opens it. */
    private var openPlayer by mutableIntStateOf(0)

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        val app = application as ValenceApp
        if (intent?.getBooleanExtra(EXTRA_OPEN_PLAYER, false) == true) openPlayer++
        app.cast.startUp()
        setContent {
            val theme by app.prefs.theme.flow.collectAsStateWithLifecycle()
            val accent by app.prefs.accent.flow.collectAsStateWithLifecycle()
            val root by app.prefs.musicRoot.flow.collectAsStateWithLifecycle()
            var access by remember { mutableStateOf(hasStorageAccess(this)) }
            LifecycleEventEffect(Lifecycle.Event.ON_RESUME) {
                access = hasStorageAccess(this@MainActivity)
                if (access) app.refresh()
            }
            ValenceTheme(theme, accent) {
                if (!access || root.isEmpty()) {
                    Onboarding(
                        access, root,
                        onRequestAccess = { access = hasStorageAccess(this) },
                        onRoot = {
                            app.prefs.musicRoot.value = it
                            app.refresh(force = true)
                        },
                    )
                } else {
                    LaunchedEffect(Unit) { askForNotifications() }
                    ValenceRoot(app, openPlayer)
                }
            }
        }
    }

    /** Android 13+ hides the playback notification (and its controls) without this. Asked once. */
    private fun askForNotifications() {
        if (Build.VERSION.SDK_INT < 33) return
        if (checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) return
        val sp = getSharedPreferences("valence", MODE_PRIVATE)
        if (sp.getBoolean("askedNotifications", false)) return
        sp.edit().putBoolean("askedNotifications", true).apply()
        requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 1)
    }

    override fun dispatchKeyEvent(event: KeyEvent): Boolean =
        (application as ValenceApp).cast.handleVolumeKey(event) || super.dispatchKeyEvent(event)

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        if (intent.getBooleanExtra(EXTRA_OPEN_PLAYER, false)) openPlayer++
    }

    companion object {
        const val EXTRA_OPEN_PLAYER = "app.valence.OPEN_PLAYER"
    }
}
