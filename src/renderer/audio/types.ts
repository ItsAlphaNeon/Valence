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
  kind: 'album' | 'playlist' | 'search' | 'artist' | 'library' | 'other'
  id?: string
  title?: string
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
