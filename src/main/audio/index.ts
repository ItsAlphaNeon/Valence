// Playback backend entry points (stub; implemented by the audio module).
import type { AppContext } from '../context'

/** Must run before app 'ready' (privileged schemes). */
export function registerAudioSchemes(): void {}

export function registerAudio(_ctx: AppContext): void {}
