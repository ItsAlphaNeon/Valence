package app.valence.cast

import android.content.Context
import android.net.wifi.WifiManager
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.util.Log
import android.view.KeyEvent
import androidx.mediarouter.media.MediaRouteSelector
import androidx.mediarouter.media.MediaRouter
import app.valence.ValenceApp
import app.valence.core.CastMessages
import app.valence.core.CastServer
import app.valence.data.Track
import app.valence.tags.TagReader
import com.google.android.gms.cast.CastDevice
import com.google.android.gms.cast.CastMediaControlIntent
import com.google.android.gms.cast.CastStatusCodes
import com.google.android.gms.cast.framework.CastContext
import com.google.android.gms.cast.framework.CastOptions
import com.google.android.gms.cast.framework.OptionsProvider
import com.google.android.gms.cast.framework.SessionManagerListener
import com.google.android.gms.cast.framework.SessionProvider
import com.google.android.gms.cast.framework.media.CastMediaOptions
import com.google.android.gms.cast.Cast
import com.google.android.gms.cast.framework.CastSession
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.net.DatagramSocket
import java.net.Inet4Address
import java.net.InetAddress
import java.net.NetworkInterface
import java.util.concurrent.Executors

/** Read by Google's Cast library, named in the manifest. */
class CastOptionsProvider : OptionsProvider {
    override fun getCastOptions(context: Context): CastOptions {
        val id = (context.applicationContext as ValenceApp).prefs.castReceiverId.value
        return CastOptions.Builder()
            .setReceiverApplicationId(CastManager.receiverIdFor(id))
            .setStopReceiverApplicationWhenEndingSession(true)
            .setResumeSavedSession(false)
            // The app's own media session already gives the notification and lock screen controls.
            .setCastMediaOptions(CastMediaOptions.Builder().setMediaSessionEnabled(false).setNotificationOptions(null).build())
            .build()
    }

    override fun getAdditionalSessionProviders(context: Context): List<SessionProvider>? = null
}

/**
 * Casting: finds TVs, keeps the connection to one, and while connected puts [CastQueuePlayer] in
 * place of the phone's own player (see Playback.startRemote). The rest of the app doesn't know the
 * difference. Main thread.
 */
class CastManager(private val app: ValenceApp) {
    data class Device(val id: String, val name: String)

    private val prefs = app.prefs
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val handler = Handler(Looper.getMainLooper())

    private val _available = MutableStateFlow(false)
    /** This phone can cast: it has Google Play services. */
    val available: StateFlow<Boolean> = _available.asStateFlow()

    private val _tvName = MutableStateFlow<String?>(null)
    /** The TV being cast to, or null. */
    val tvName: StateFlow<String?> = _tvName.asStateFlow()

    private val _connecting = MutableStateFlow<String?>(null)
    val connecting: StateFlow<String?> = _connecting.asStateFlow()

    private val _devices = MutableStateFlow<List<Device>>(emptyList())
    /** The TVs found on the network, while [startScan] is on. */
    val devices: StateFlow<List<Device>> = _devices.asStateFlow()

    private val _volume = MutableStateFlow(0.5f)
    val volume: StateFlow<Float> = _volume.asStateFlow()

    private val _error = MutableStateFlow<String?>(null)
    val error: StateFlow<String?> = _error.asStateFlow()

    /** Google's stock screen instead of Valence's own TV page: no app id set yet. */
    val usesStockScreen: Boolean get() = prefs.castReceiverId.value.isBlank()

    private class Attached(
        val link: TvLink,
        val server: CastServer,
        val player: CastQueuePlayer,
        val session: CastSession?,
        val jobs: Job,
    )

    private var context: CastContext? = null
    private var attached: Attached? = null
    /** Goes up on every connect and disconnect, so a slow start can tell it's out of date. */
    private var attempt = 0
    private var lastTrack: Track? = null
    private var lyricsJob: Job? = null

    // ---- Starting up ---------------------------------------------------------------------------

    private var startedUp = false

    /** Connects to Google Play services' Cast. Does nothing much until a TV is picked. */
    fun startUp() {
        if (startedUp) return
        startedUp = true
        runCatching {
            CastContext.getSharedInstance(app, Executors.newSingleThreadExecutor())
                .addOnSuccessListener(handler::post) { ctx ->
                    context = ctx
                    ctx.sessionManager.addSessionManagerListener(sessions, CastSession::class.java)
                    _available.value = true
                }
                .addOnFailureListener(handler::post) { Log.i(TAG, "No Cast on this phone: ${it.message}") }
        }.onFailure { Log.i(TAG, "No Cast on this phone: ${it.message}") }
    }

    /** Changes the TV page. Takes effect on the next connection. */
    fun setReceiverId(id: String) {
        prefs.castReceiverId.value = id.trim()
        runCatching { context?.setReceiverApplicationId(receiverIdFor(id)) }
    }

    // ---- Finding TVs ---------------------------------------------------------------------------

    private var scanning: MediaRouteSelector? = null

    private val routes = object : MediaRouter.Callback() {
        override fun onRouteAdded(router: MediaRouter, route: MediaRouter.RouteInfo) = publishRoutes()
        override fun onRouteRemoved(router: MediaRouter, route: MediaRouter.RouteInfo) = publishRoutes()
        override fun onRouteChanged(router: MediaRouter, route: MediaRouter.RouteInfo) = publishRoutes()
    }

    fun startScan() {
        val selector = context?.mergedSelector ?: return
        if (scanning != null) return
        scanning = selector
        _error.value = null
        MediaRouter.getInstance(app).addCallback(selector, routes, MediaRouter.CALLBACK_FLAG_REQUEST_DISCOVERY or MediaRouter.CALLBACK_FLAG_PERFORM_ACTIVE_SCAN)
        publishRoutes()
    }

    fun stopScan() {
        if (scanning == null) return
        scanning = null
        MediaRouter.getInstance(app).removeCallback(routes)
    }

    private fun publishRoutes() {
        val selector = scanning ?: return
        _devices.value = MediaRouter.getInstance(app).routes
            .filter { !it.isDefault && it.isEnabled && it.matchesSelector(selector) }
            .map { Device(it.id, it.name) }
    }

    fun connect(device: Device) {
        val route = MediaRouter.getInstance(app).routes.firstOrNull { it.id == device.id } ?: return
        _error.value = null
        _connecting.value = device.name
        handler.removeCallbacks(noAnswer)
        handler.postDelayed(noAnswer, CONNECT_WAIT_MS)
        route.select()
    }

    /** Nothing came of picking a TV. Without this the dialog would say "connecting" from now on. */
    private val noAnswer = Runnable {
        _connecting.value = null
        _error.value = "The TV didn't answer."
        runCatching { MediaRouter.getInstance(app).unselect(MediaRouter.UNSELECT_REASON_STOPPED) }
    }

    /** Ends casting: the TV goes back to what it was doing, the phone to this song, paused. */
    fun stop() {
        handler.removeCallbacks(noAnswer)
        _connecting.value = null
        val session = attached?.session
        if (attached != null && session == null) return detach()
        context?.sessionManager?.endCurrentSession(true)
    }

    // ---- The connection ------------------------------------------------------------------------

    private val sessions = object : SessionManagerListener<CastSession> {
        override fun onSessionStarting(session: CastSession) {
            session.castDevice?.friendlyName?.let { _connecting.value = it }
        }

        override fun onSessionStarted(session: CastSession, sessionId: String) = attachSession(session)

        override fun onSessionStartFailed(session: CastSession, error: Int) {
            handler.removeCallbacks(noAnswer)
            _connecting.value = null
            _error.value = startFailure(error)
        }

        override fun onSessionEnding(session: CastSession) = detach()
        override fun onSessionEnded(session: CastSession, error: Int) = detach()
        override fun onSessionResuming(session: CastSession, sessionId: String) = Unit

        override fun onSessionResumed(session: CastSession, wasSuspended: Boolean) {
            tvBack()
            val current = attached
            val client = session.remoteMediaClient
            if (current?.session === session && client != null) {
                (current.link as? SessionLink)?.reconnected(client)
                // These went with the old connection.
                runCatching { session.setMessageReceivedCallbacks(CastMessages.NAMESPACE, messages) }
                sendSettings()
                sendLyrics()
            } else {
                attachSession(session)
            }
        }

        override fun onSessionResumeFailed(session: CastSession, error: Int) = detach()
        override fun onSessionSuspended(session: CastSession, reason: Int) = tvLost()
    }

    /** The connection dropped. Cast tries to bring it back, but not forever. */
    internal fun tvLost() {
        val a = attached ?: return
        Log.i(TAG, "Lost the TV for now")
        a.link.connectionLost()
        handler.removeCallbacks(giveUpOnTv)
        handler.postDelayed(giveUpOnTv, RECONNECT_WAIT_MS)
    }

    internal fun tvBack() = handler.removeCallbacks(giveUpOnTv)

    /** The phone takes over, rather than seeming to play on with nothing listening. */
    private val giveUpOnTv = Runnable {
        Log.w(TAG, "The TV didn't come back")
        detach()
        app.playback.castProblem("Lost the connection to the TV.")
        runCatching { context?.sessionManager?.endCurrentSession(true) }
    }

    private fun startFailure(code: Int): String {
        val name = CastStatusCodes.getStatusCodeString(code)
        return if (usesStockScreen) "The TV didn't connect ($name)."
        else "The TV didn't open Valence's screen ($name). Check the app ID in Settings, and that this TV is registered and was restarted."
    }

    private fun attachSession(session: CastSession) {
        val device: CastDevice? = session.castDevice
        val client = session.remoteMediaClient
        if (device == null || client == null) {
            detach()
            _error.value = "The TV connected but can't play music."
            return
        }
        begin(device.friendlyName, device.inetAddress, session) { songs -> SessionLink(client, songs) }
    }

    /** Sets up everything a connected TV needs and moves playback onto it. */
    fun begin(name: String, tvAddress: InetAddress?, session: CastSession?, makeLink: (TvSongs) -> TvLink) {
        detach()
        val mine = ++attempt
        _connecting.value = name
        scope.launch {
            val server = withContext(Dispatchers.IO) { runCatching { startServer(tvAddress) }.onFailure { Log.w(TAG, "Can't start the server", it) }.getOrNull() }
            if (mine != attempt) {
                withContext(Dispatchers.IO) { server?.stop() }
                return@launch
            }
            if (server == null) {
                _connecting.value = null
                _error.value = "This phone isn't on a network the TV can reach."
                if (session != null) context?.sessionManager?.endCurrentSession(true)
                return@launch
            }
            val link = makeLink(TvSongs(app, server))
            val player = CastQueuePlayer(Looper.getMainLooper(), link, tvVolume)
            link.connect(player.queue)
            val jobs = SupervisorJob(scope.coroutineContext[Job])
            attached = Attached(link, server, player, session, jobs)
            _volume.value = session?.volume?.toFloat() ?: _volume.value
            session?.addCastListener(castEvents)
            if (session != null) runCatching { session.setMessageReceivedCallbacks(CastMessages.NAMESPACE, messages) }
            _connecting.value = null
            _tvName.value = name
            _error.value = null
            app.playback.startRemote(player)
            // Everything from here on is for as long as this TV stays connected.
            CoroutineScope(scope.coroutineContext + jobs).apply {
                launch { app.playback.isPlaying.collect(::holdLocks) }
                launch {
                    app.playback.current.collect {
                        lastTrack = it
                        sendLyrics()
                        if (app.playback.isPlaying.value) holdLocks(true) // the wake lock has a time limit
                    }
                }
                launch { prefs.castLyrics.flow.collect { sendSettings(); sendLyrics() } }
            }
        }
    }

    private fun detach() {
        attempt++
        handler.removeCallbacks(noAnswer)
        handler.removeCallbacks(giveUpOnTv)
        _connecting.value = null
        val a = attached ?: return
        attached = null
        a.jobs.cancel()
        lyricsJob?.cancel()
        holdLocks(false)
        a.session?.let { s ->
            runCatching { s.removeMessageReceivedCallbacks(CastMessages.NAMESPACE) }
            runCatching { s.removeCastListener(castEvents) }
        }
        a.link.disconnect()
        app.playback.stopRemote()
        // After the media session has moved off it, whenever that gets to run.
        handler.post { a.player.release() }
        _tvName.value = null
        scope.launch(Dispatchers.IO) { a.server.stop() }
    }

    private fun startServer(tv: InetAddress?): CastServer? {
        val address = lanAddressFor(tv) ?: return null
        return CastServer(address, audio = { TvSongs.audio(app, it) }, art = { TvSongs.art(it) }).apply { start() }
    }

    /** The phone's address on the network the TV is on. */
    private fun lanAddressFor(tv: InetAddress?): InetAddress? {
        if (tv != null) {
            // Connecting a UDP socket sends nothing: it only asks which way the traffic would go.
            runCatching { DatagramSocket().use { s -> s.connect(tv, 9); s.localAddress } }.getOrNull()
                // A link-local address only means something with its scope, which a URL can't carry.
                ?.takeUnless { it.isAnyLocalAddress || it.isLoopbackAddress || it.isLinkLocalAddress }
                ?.let { return it }
        }
        return runCatching {
            NetworkInterface.getNetworkInterfaces().asSequence()
                .filter { it.isUp && !it.isLoopback }
                .flatMap { it.inetAddresses.asSequence() }
                .firstOrNull { it is Inet4Address && it.isSiteLocalAddress }
        }.getOrNull()
    }

    // ---- Staying awake -------------------------------------------------------------------------

    private var wakeLock: PowerManager.WakeLock? = null
    private var wifiLock: WifiManager.WifiLock? = null

    /** While the TV plays it reads from this phone, screen off or not. */
    private fun holdLocks(hold: Boolean) {
        if (wakeLock == null) {
            wakeLock = app.getSystemService(PowerManager::class.java).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "Valence:cast").apply { setReferenceCounted(false) }
            @Suppress("DEPRECATION")
            wifiLock = app.applicationContext.getSystemService(WifiManager::class.java).createWifiLock(WifiManager.WIFI_MODE_FULL_HIGH_PERF, "Valence:cast").apply { setReferenceCounted(false) }
        }
        if (hold) {
            wakeLock?.acquire(WAKE_LOCK_MAX_MS)
            wifiLock?.acquire()
        } else {
            if (wakeLock?.isHeld == true) wakeLock?.release()
            if (wifiLock?.isHeld == true) wifiLock?.release()
        }
    }

    // ---- The TV's volume -----------------------------------------------------------------------

    private val tvVolume = object : TvVolume {
        override val level: Float get() = _volume.value
        override val muted: Boolean get() = attached?.session?.let { s -> runCatching { s.isMute }.getOrDefault(false) } ?: false
        override fun setLevel(level: Float) = setVolume(level)
        override fun setMuted(muted: Boolean) {
            runCatching { attached?.session?.setMute(muted) }
        }
    }

    private val castEvents = object : Cast.Listener() {
        override fun onVolumeChanged() {
            val a = attached ?: return
            a.session?.let { s -> runCatching { _volume.value = s.volume.toFloat() } }
            a.player.volumeChanged()
        }
    }

    fun setVolume(level: Float) {
        val v = level.coerceIn(0f, 1f)
        _volume.value = v
        val a = attached ?: return
        runCatching { a.session?.volume = v.toDouble() }
        a.player.volumeChanged()
    }

    /** The volume keys, while the app is open: they work the TV. */
    fun handleVolumeKey(event: KeyEvent): Boolean {
        if (attached == null) return false
        val step = when (event.keyCode) {
            KeyEvent.KEYCODE_VOLUME_UP -> 1f
            KeyEvent.KEYCODE_VOLUME_DOWN -> -1f
            else -> return false
        }
        if (event.action == KeyEvent.ACTION_DOWN) setVolume(_volume.value + step / CastQueuePlayer.VOLUME_STEPS)
        return true
    }

    /** The song's ReplayGain changed. */
    fun setGain(gain: Float) {
        attached?.link?.setGain(gain.coerceIn(0f, 1f))
    }

    // ---- Lyrics and settings on the custom channel -----------------------------------------------

    private val messages = Cast.MessageReceivedCallback { _, _, message ->
        if (CastMessages.isHello(message)) {
            sendSettings()
            sendLyrics()
        }
    }

    private fun send(message: String) {
        val session = attached?.session ?: return
        if (usesStockScreen) return
        runCatching { session.sendMessage(CastMessages.NAMESPACE, message) }.onFailure { Log.w(TAG, "Couldn't message the TV: ${it.message}") }
    }

    private fun sendSettings() = send(CastMessages.settings(prefs.castLyrics.value))

    private fun sendLyrics() {
        lyricsJob?.cancel()
        val t = lastTrack ?: return
        if (attached?.session == null || usesStockScreen || !prefs.castLyrics.value) return
        lyricsJob = scope.launch {
            val text = if (t.lyricsKind == 0) null else withContext(Dispatchers.IO) {
                runCatching { TagReader.read(app.library.fileOf(t)).tags.lyrics }.getOrNull()
            }
            CastMessages.lyrics(t.id, text).forEach(::send)
        }
    }

    companion object {
        private const val TAG = "ValenceCast"
        /** A long album's worth at a time: playing renews it, and it's never left on by accident. */
        private const val WAKE_LOCK_MAX_MS = 6 * 60 * 60 * 1000L
        private const val CONNECT_WAIT_MS = 45_000L
        private const val RECONNECT_WAIT_MS = 60_000L

        fun receiverIdFor(id: String): String = id.trim().ifEmpty { CastMediaControlIntent.DEFAULT_MEDIA_RECEIVER_APPLICATION_ID }
    }
}
