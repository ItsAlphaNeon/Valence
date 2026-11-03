// Messages on the `pcm` MessagePort between the main-process decode host and the renderer's
// AudioWorklet (the port is transferred into the worklet, so PCM never touches the page thread).

/** Worklet -> main. */
export type PcmRequest =
  | { type: 'open'; streamId: number; gen: number; path: string; startSec: number; sampleRate: number }
  | { type: 'seek'; streamId: number; gen: number; startSec: number }
  | { type: 'close'; streamId: number }
  /** Frames consumed (played or dropped) since the last ack, for credit-based flow control. */
  | { type: 'ack'; streamId: number; gen: number; frames: number }

/** Main -> worklet. `gen` increments on every seek so stale chunks can be dropped. */
export type PcmEvent =
  | { type: 'format'; streamId: number; gen: number; durationSec: number | null }
  /** Interleaved stereo Float32 at the requested sample rate. */
  | { type: 'pcm'; streamId: number; gen: number; data: Float32Array }
  /** Decoder finished; `frames` = total frames sent in this generation. */
  | { type: 'eof'; streamId: number; gen: number; frames: number }
  | { type: 'error'; streamId: number; gen: number; message: string }

export const PCM_CHUNK_FRAMES = 4096
export const PCM_MAX_BUFFERED_SEC = 8
