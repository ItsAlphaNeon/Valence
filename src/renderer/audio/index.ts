// Public entry for the playback engine.
export * from './types'
export { Player, detectMute, AUTOPLAY_SOURCE, type AutoplayRequest, type PlayerEvents, type PlayerOptions } from './player'
export { attachPlayerRelay, RemotePlayer } from './relay'
export { EQ_FREQS, EQ_PRESETS } from './graph'
export { volumeToGain, rgGain, crossfadeSecFor, isAlbumContinuation, mediaUrl, balanceGains, DEFAULT_PREFS, normalizePrefs, normalizeSleep, SLEEP_OFF, SLEEP_FADE_MS } from './policy'
export type { OutputStrategy } from './media-session'
