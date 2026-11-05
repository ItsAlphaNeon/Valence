package app.valence.data

import android.content.Context
import android.content.SharedPreferences
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import java.security.SecureRandom

/** App settings, each readable as a StateFlow so the UI follows changes. Local to this phone. */
class Prefs(context: Context) {
    private val sp: SharedPreferences = context.getSharedPreferences("valence", Context.MODE_PRIVATE)

    inner class Pref<T>(
        private val key: String,
        default: T,
        private val read: SharedPreferences.(String, T) -> T,
        private val write: SharedPreferences.Editor.(String, T) -> Unit,
    ) {
        private val state = MutableStateFlow(sp.read(key, default))
        val flow: StateFlow<T> = state.asStateFlow()
        var value: T
            get() = state.value
            set(v) {
                if (v == state.value) return
                sp.edit().apply { write(key, v) }.apply()
                state.value = v
            }
    }

    private fun string(key: String, default: String) = Pref(key, default, { k, d -> getString(k, d) ?: d }, { k, v -> putString(k, v) })
    private fun bool(key: String, default: Boolean) = Pref(key, default, { k, d -> getBoolean(k, d) }, { k, v -> putBoolean(k, v) })
    private fun int(key: String, default: Int) = Pref(key, default, { k, d -> getInt(k, d) }, { k, v -> putInt(k, v) })
    private fun float(key: String, default: Float) = Pref(key, default, { k, d -> getFloat(k, d) }, { k, v -> putFloat(k, v) })

    /** Absolute path of the synced music folder ("" until chosen). */
    val musicRoot = string("musicRoot", "")

    /** This phone's id in the shared .valence folder; random, 16 hex digits like the desktop's. */
    val deviceId: String
        get() = sp.getString("deviceId", null) ?: newDeviceId().also { sp.edit().putString("deviceId", it).apply() }

    // Appearance
    val theme = string("theme", "dark") // system | light | dark | black
    val accent = string("accent", "#65FFA0")
    /** Enabled tabs, in order (Musicolet's "Arrange tabs"); see ui.Tab. */
    val tabs = string("tabs", "queues,player,albums,artists,rips,playlists")
    val lastTab = string("lastTab", "player")
    val gridAlbums = bool("gridAlbums", true)
    val albumColumns = int("albumColumns", 3)
    val artistMode = string("artistMode", "album") // album | track | composer
    val ripsTab = int("ripsTab", 0)
    /** Tapping the big album art in Now playing: lyrics | play | nothing. */
    val artTap = string("artTap", "lyrics")

    // Library
    val songSort = string("songSort", "title")
    val albumSort = string("albumSort", "artist")
    val artistSort = string("artistSort", "name")
    val ripSort = string("ripSort", "uploaded")
    /** Which favorites the Favorites page shows: main (your music) | rips (SiivaGunner). */
    val favSide = string("favSide", "main")
    val minDurationSec = int("minDurationSec", 0)

    // Playback (read by the playback service)
    val replayGain = string("replayGain", "auto") // off | track | album | auto
    val preampDb = float("preampDb", 0f)
    val pauseOnDisconnect = bool("pauseOnDisconnect", true)
    val resumeOnConnect = bool("resumeOnConnect", false)
    val fadeMs = int("fadeMs", 300)
    val skipSilence = bool("skipSilence", false)
    val tapBehavior = string("tapBehavior", "named") // named | replace | next | add
    /** Shuffle mode (the Now playing toggle); new queues start shuffled while it's on. */
    val shuffle = bool("shuffle", false)
    val rememberPosition = bool("rememberPosition", true)
    val maxQueues = int("maxQueues", 20)
    val eqEnabled = bool("eqEnabled", false)
    val eqPreset = int("eqPreset", -1) // -1 = custom bands
    val eqBands = string("eqBands", "[]") // millibels per band, JSON array
    val bassBoost = int("bassBoost", 0) // 0..1000
    val lyricsSize = int("lyricsSize", 22)
    val keepScreenOn = bool("keepScreenOn", false) // while Now Playing is open
    val lastScanAt = Pref("lastScanAt", 0L, { k, d -> getLong(k, d) }, { k, v -> putLong(k, v) })
    val scanVersion = int("scanVersion", 0)

    companion object {
        fun newDeviceId(): String {
            val b = ByteArray(8).also { SecureRandom().nextBytes(it) }
            return b.joinToString("") { "%02x".format(it) }
        }
    }
}
