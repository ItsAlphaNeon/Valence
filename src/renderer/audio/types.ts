// Public, serializable playback types shared by the Player, the UI and the mini-player relay.

export interface ReplayGainInfo {
  trackGain?: number
  trackPeak?: number
  albumGain?: number
  albumPeak?: number
}

export interface PlayItem {
  id: string
  path: string
  title: string
  artist: string
  album: string
  albumKey?: string
  trackNo?: number
  discNo?: number
  durationMs: number
  artUrl?: string
  rg?: ReplayGainInfo
}

export type RepeatMode = 'off' | 'all' | 'one'
export type RgMode = 'off' | 'track' | 'album' | 'auto'
export type EngineKind = 'worklet' | 'element'

export const EQ_PRESET_NAMES = ['Flat', 'Bass Boost', 'Treble Boost', 'Vocal', 'Loudness', 'Electronic', 'Rock', 'Acoustic'] as const
export type EqPresetName = (typeof EQ_PRESET_NAMES)[number] | 'Custom'

export interface EqState {
  enabled: boolean
  preset: EqPresetName
  /** 10 bands (31 Hz .. 16 kHz), dB in [-12, 12]. */
  gains: number[]
}

export interface QueueSource {
  kind: 'album' | 'playlist' | 'search' | 'artist' | 'library' | 'autoplay' | 'other'
  id?: string
  title?: string
}

/** 'time' pauses at endsAt (epoch ms); 'track' at the end of the current track; 'album' when the album changes or the queue context ends. */
export type SleepTimer = { mode: 'off' } | { mode: 'time'; endsAt: number; minutes: number } | { mode: 'track' } | { mode: 'album' }

/** Preferences the host app mirrors into the Player (Player.setPrefs). */
export interface PlaybackPrefs {
  /** Continue with similar tracks when the queue runs out (needs PlayerOptions.autoplay). */
  autoplay: boolean
  /** Fade out over the last 20 s of a timed sleep timer. */
  sleepFade: boolean
  /** Sum both channels to mono. */
  mono: boolean
  /** -1 (left only) .. 0 (center) .. 1 (right only). */
  balance: number
  /** Gain ramp for play/pause/stop and manual track changes; 0 = the engines' short anti-click ramps. */
  fadeMs: number
  /** Previous restarts the current track when more than this far in; 0 = always go back. */
  prevRestartMs: number
}

export interface QueueSnapshot {
  /** User-added items; always play before the context continues. */
  upNext: PlayItem[]
  context: {
    source: QueueSource | null
    /** Upcoming context items in play order (shuffle-aware), capped. */
    upcoming: PlayItem[]
    /** Position of the current context item in play order, -1 when none. */
    position: number
    length: number
  }
  /** Queued to follow when the context runs out (autoplay picks); becomes the context when reached. */
  continuation?: { source: QueueSource | null; upcoming: PlayItem[] } | null
  history: PlayItem[]
}

export interface PlayerState {
  current: PlayItem | null
  positionMs: number
  durationMs: number
  playing: boolean
  buffering: boolean
  volume: number
  muted: boolean
  shuffle: boolean
  repeat: RepeatMode
  queue: QueueSnapshot
  crossfadeSec: number
  rgMode: RgMode
  preampDb: number
  eq: EqState
  outputDeviceId: string
  engine: EngineKind
  sleep: SleepTimer
  /** Pause at the end of the current track (then turns itself off). */
  stopAfterCurrent: boolean
  error: string | null
}

export type PlayerCommand =
  | { type: 'play' }
  | { type: 'pause' }
  | { type: 'toggle' }
  | { type: 'stop' }
  | { type: 'next' }
  | { type: 'prev' }
  | { type: 'seek'; positionMs: number }
  | { type: 'seekBy'; deltaMs: number }
  | { type: 'setVolume'; volume: number }
  | { type: 'setMuted'; muted: boolean }
  | { type: 'setQueue'; items: PlayItem[]; startIndex?: number; source?: QueueSource; startMs?: number; autoplay?: boolean }
  | { type: 'playNext'; items: PlayItem[] }
  | { type: 'addToQueue'; items: PlayItem[] }
  | { type: 'removeUpNext'; index: number }
  | { type: 'moveUpNext'; from: number; to: number }
  | { type: 'clearUpNext' }
  | { type: 'playUpNextAt'; index: number }
  /** Jump within the context; `position` is in play order (see QueueSnapshot.context.position). */
  | { type: 'jumpTo'; position: number }
  | { type: 'setShuffle'; shuffle: boolean }
  | { type: 'setRepeat'; repeat: RepeatMode }
  | { type: 'cycleRepeat' }
  | { type: 'setCrossfade'; sec: number }
  | { type: 'setRgMode'; mode: RgMode }
  | { type: 'setPreamp'; db: number }
  | { type: 'setEq'; eq: Partial<EqState> }
  | { type: 'setEqPreset'; preset: EqPresetName }
  | { type: 'setEqBand'; index: number; gainDb: number }
  | { type: 'setOutputDevice'; deviceId: string }
  | { type: 'setEngine'; engine: EngineKind }
  | { type: 'setSleepTimer'; timer: SleepTimer }
  | { type: 'setStopAfterCurrent'; on: boolean }

export interface PlayLoggedEvent {
  item: PlayItem
  playedMs: number
  /** Reached the natural end of the track. */
  completed: boolean
  /** Epoch ms when this play started. */
  startedAt: number
}

export interface SkipEvent {
  item: PlayItem
  playedMs: number
  startedAt: number
}

export interface OutputDevice {
  deviceId: string
  label: string
}
