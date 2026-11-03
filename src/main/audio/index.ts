// Playback backend: PCM decode host (worklet engine), valence-media:// (element engine), the
// player relay for secondary windows, and audio:env.

import type { AppContext } from '../context'
import { handle } from '../ipc'
import { createAudioAccess, type AudioAccess } from './access'
import { registerDecodeHost } from './decode-host'
import { registerMediaProtocol, registerPrivilegedSchemes } from './media-protocol'
import { registerPlayerRelay } from './relay'

let access: AudioAccess | null = null
const pendingPaths: string[] = []
const pendingRoots: string[] = []

/** Must run before app 'ready' (privileged schemes). */
export function registerAudioSchemes(): void {
  registerPrivilegedSchemes()
}

export function registerAudio(ctx: AppContext): void {
  const env = ctx.env
  access = createAudioAccess(() => [env.libraryRoot, env.archiveDir, env.archivePendingDir, env.stagingDir])
  access.allowPaths(pendingPaths.splice(0))
  for (const r of pendingRoots.splice(0)) access.allowRoot(r)
  registerDecodeHost(ctx, access)
  registerMediaProtocol(access)
  registerPlayerRelay()
  handle('audio:env', () => ({ mute: process.env.VALENCE_MUTE === '1' }))
}

/** Main-process allow-list for playable files outside the library/archive/staging roots. */
export function allowAudioPaths(paths: string[]): void {
  if (access) access.allowPaths(paths)
  else pendingPaths.push(...paths)
}

export function allowAudioRoot(dir: string): void {
  if (access) access.allowRoot(dir)
  else pendingRoots.push(dir)
}
