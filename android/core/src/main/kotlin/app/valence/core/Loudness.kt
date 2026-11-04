package app.valence.core

import kotlin.math.pow

/** ReplayGain the desktop's way (src/renderer/audio/policy.ts rgGain, preamp from graph.ts). */
object Loudness {
    const val OFF = "off"
    const val TRACK = "track"
    const val ALBUM = "album"
    const val AUTO = "auto"

    fun dbToGain(db: Double): Double = 10.0.pow(db / 20)

    /**
     * Linear gain factor: [rgGain] times the preamp ([preampDb] clamped to -12..12 dB, applied even
     * when [mode] is "off", like the desktop's separate preamp stage). The desktop puts a limiter
     * after a positive preamp; this factor does not include one.
     */
    fun gain(trackGain: Double?, trackPeak: Double?, albumGain: Double?, albumPeak: Double?, mode: String, albumContext: Boolean, preampDb: Double): Double =
        rgGain(trackGain, trackPeak, albumGain, albumPeak, mode, albumContext) * preampGain(preampDb)

    /** The desktop's rgGain: gain clamped to +-24 dB, then limited so peak * gain never exceeds 1. */
    fun rgGain(trackGain: Double?, trackPeak: Double?, albumGain: Double?, albumPeak: Double?, mode: String, albumContext: Boolean): Double {
        if (mode == OFF) return 1.0
        val album = mode == ALBUM || (mode == AUTO && albumContext)
        val gain = if (album) albumGain ?: trackGain else trackGain ?: albumGain
        val peak = if (album) albumPeak ?: trackPeak else trackPeak ?: albumPeak
        if (gain == null || gain.isNaN() || gain.isInfinite()) return 1.0
        var g = dbToGain(gain.coerceIn(-24.0, 24.0))
        if (peak != null && peak > 0) g = minOf(g, 1 / peak)
        return g
    }

    fun preampGain(preampDb: Double): Double = if (preampDb.isNaN() || preampDb.isInfinite()) 1.0 else dbToGain(preampDb.coerceIn(-12.0, 12.0))

    /**
     * The desktop's "album context" for auto mode: playing from an album, or (not shuffling) the
     * next or previous track is from the same album.
     */
    fun albumContext(sourceIsAlbum: Boolean, albumKey: String?, shuffle: Boolean, nextAlbumKey: String?, previousAlbumKey: String?): Boolean =
        sourceIsAlbum || (!albumKey.isNullOrEmpty() && !shuffle && (nextAlbumKey == albumKey || previousAlbumKey == albumKey))
}
