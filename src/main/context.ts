// Services shared by feature modules (sources, audio, integrations). Implemented in main/app.ts;
// feature modules depend only on these interfaces so they can be unit-tested with fakes.

import type { InLibraryBadge } from '@shared/types'
import type { ProgressFn, SourceRelease } from './import/source-types'

export interface ValenceEnv {
  /** Synced library root (default ~/Music). */
  libraryRoot: string
  /** Local app data (DB, caches). Never synced. */
  dataDir: string
  /** Unsynced lossless archive chosen by the user; null until chosen (files queue in archivePendingDir). */
  archiveDir: string | null
  archivePendingDir: string
  stagingDir: string
  artCacheDir: string
  inboxDir: string
  /** Random per-device id (internal only, never shown as a name). */
  deviceId: string
  appVersion: string
}

export interface SettingsStore {
  get<T>(key: string, fallback: T): T
  set(key: string, value: unknown): void
  onChange(cb: (key: string, value: unknown) => void): () => void
}

export interface SecretStore {
  get(key: string): string | null
  set(key: string, value: string | null): void
}

/** One track as seen by a source, for in-library matching. */
export interface BadgeQueryTrack {
  tidalTrackId?: string
  bandcampTrackId?: string
  isrc?: string
  artist?: string
  albumArtist?: string
  title?: string
  album?: string
  durationMs?: number
}

export interface BadgeQueryAlbum {
  tidalAlbumId?: string
  bandcampAlbumId?: string
  upc?: string
  albumArtist?: string
  title?: string
  trackCount?: number
  /** When known, per-track matching gives exact partial counts. */
  tracks?: BadgeQueryTrack[]
}

export interface LibraryLookup {
  /** For each query track, whether a matching track exists in the library. */
  matchTracks(tracks: BadgeQueryTrack[]): boolean[]
  albumBadge(album: BadgeQueryAlbum): InLibraryBadge
  albumBadges(albums: BadgeQueryAlbum[]): InLibraryBadge[]
}

export interface AcquireContext {
  stagingDir: string
  progress: ProgressFn
  signal: AbortSignal
}

export type Acquirer = (payload: any, ctx: AcquireContext) => Promise<SourceRelease>

export interface EnqueueRequest {
  source: 'tidal' | 'bandcamp' | 'import'
  title: string
  /** Keys used for "already queued/in library" checks, e.g. ["tidal:album:123"]. */
  releaseKeys: string[]
  /** JSON-serializable; handed back to the registered acquirer (jobs survive restarts). */
  payload: unknown
}

export interface ImportQueue {
  registerAcquirer(source: string, fn: Acquirer, opts?: { concurrency?: number }): void
  enqueue(req: EnqueueRequest): string
  /** Release keys currently queued or running (for "Queued/Downloading" badges). */
  activeKeys(): Map<string, 'queued' | 'running'>
  pauseSource(source: string, reason: string): void
  resumeSource(source: string): void
}

export interface Logger {
  info(msg: string, extra?: unknown): void
  warn(msg: string, extra?: unknown): void
  error(msg: string, extra?: unknown): void
}

/** Mirrors a source playlist as a relative .m3u8 in ~/Music/Playlists (resolved against the library). */
export interface PlaylistMirror {
  mirror(req: { name: string; sourceKey: string; tracks: BadgeQueryTrack[] }): void
}

export interface AppContext {
  env: ValenceEnv
  settings: SettingsStore
  secrets: SecretStore
  library: LibraryLookup
  imports: ImportQueue
  playlists: PlaylistMirror
  broadcast(channel: string, ...args: unknown[]): void
  log: Logger
}
