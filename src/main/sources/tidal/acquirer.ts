// Import-queue acquirer for TIDAL jobs: resolves the album, downloads the wanted tracks one at a
// time with pacing, and returns a SourceRelease. Unavailable/DRM tracks are skipped (noted in
// raw.skipped) unless nothing at all could be fetched.

import type { Acquirer, AcquireContext, LibraryLookup, Logger } from '../../context'
import { SourceError, type SourceRelease, type Transport } from '../../import/source-types'
import type { TidalApi } from './api'
import { downloadStream } from './downloader'
import { decodeManifest } from './manifest'
import { mapRelease, sourceQuality, toBadgeQueryTrack, type AcquiredTrack, type SkippedTrack } from './mapper'
import type { Pacer } from './pacing'
import type { TidalAlbum, TidalLyrics, TidalTrack } from './types'
import { throwIfAborted } from './util'

export type TidalJob = { kind: 'album'; id: string; onlyMissing?: boolean } | { kind: 'track'; id: string }

export interface AcquirerDeps {
  api: TidalApi
  /** Media transport (CDN URLs need no auth). */
  transport: Transport
  pacer: Pacer
  library: () => LibraryLookup
  log?: Logger
  quality?: string
}

const SKIP_KINDS = new Set(['unavailable', 'drm'])

export function parseJob(payload: unknown): TidalJob {
  const p = (payload ?? {}) as Record<string, unknown>
  const id = p.id != null ? String(p.id).trim() : ''
  if (!id) throw new SourceError('TIDAL job without id', 'parse')
  if (p.kind === 'album') return { kind: 'album', id, onlyMissing: !!p.onlyMissing }
  if (p.kind === 'track') return { kind: 'track', id }
  throw new SourceError(`Unknown TIDAL job kind: ${String(p.kind)}`, 'parse')
}

const label = (t: TidalTrack) => `${t.trackNumber ? `${t.trackNumber}. ` : ''}${t.title}`

export function createTidalAcquirer(deps: AcquirerDeps): Acquirer {
  return async (payload, actx) => acquire(parseJob(payload), actx, deps)
}

export async function acquire(job: TidalJob, actx: AcquireContext, deps: AcquirerDeps): Promise<SourceRelease> {
  const { api } = deps
  const { signal } = actx
  actx.progress({ phase: 'resolving', message: `Resolving TIDAL ${job.kind} ${job.id}` })

  let album: TidalAlbum
  let albumTracks: TidalTrack[]
  let wanted: TidalTrack[]
  if (job.kind === 'album') {
    album = await api.album(job.id, signal)
    albumTracks = await api.albumTracks(job.id, signal)
    wanted = albumTracks
    if (job.onlyMissing && wanted.length) {
      const have = deps.library().matchTracks(wanted.map((t) => toBadgeQueryTrack(t, album)))
      wanted = wanted.filter((_, i) => !have[i])
      if (!wanted.length) throw new SourceError('Every track of this album is already in the library', 'unavailable')
    }
  } else {
    const track = await api.track(job.id, signal)
    if (!track.album?.id) throw new SourceError(`TIDAL track ${job.id} has no album`, 'parse')
    album = await api.album(track.album.id, signal)
    // The full listing gives per-disc totals; tolerate its failure.
    albumTracks = await api.albumTracks(track.album.id, signal).catch((e) => {
      if (e instanceof SourceError && (e.kind === 'auth' || e.kind === 'abuse' || e.kind === 'cancelled')) throw e
      deps.log?.warn(`TIDAL album ${track.album!.id} track listing failed`, (e as Error).message)
      return [track]
    })
    wanted = [albumTracks.find((t) => String(t.id) === String(track.id)) ?? track]
  }
  if (!wanted.length) throw new SourceError(`TIDAL album ${album.id} has no tracks`, 'unavailable')

  const acquired: AcquiredTrack[] = []
  const skipped: SkippedTrack[] = []
  const total = wanted.length
  for (let i = 0; i < total; i++) {
    const t = wanted[i]
    throwIfAborted(signal)
    if (t.streamReady === false || t.allowStreaming === false) {
      skipped.push({ id: String(t.id), title: t.title, reason: 'unavailable', message: 'Not streamable in this region/account' })
      continue
    }
    await deps.pacer.wait(signal, (ms, reason) =>
      actx.progress({
        phase: 'waiting',
        message: reason === 'break' ? `Taking a ${Math.round(ms / 1000)} s break` : `Next track in ${Math.round(ms / 1000)} s`,
        trackIndex: i,
        trackCount: total,
        fraction: i / total,
      }),
    )
    actx.progress({ phase: 'downloading', message: label(t), trackIndex: i, trackCount: total, fraction: i / total })
    try {
      const info = await api.playbackInfo(t.id, deps.quality ?? 'LOSSLESS', signal)
      const manifest = decodeManifest(info.manifestMimeType, info.manifest)
      const lyrics: TidalLyrics | null = await api.lyrics(t.id, signal).catch((e) => {
        if (e instanceof SourceError && (e.kind === 'auth' || e.kind === 'abuse' || e.kind === 'cancelled')) throw e
        return null
      })
      const audio = await downloadStream(manifest, {
        dir: actx.stagingDir,
        baseName: `t${String(i + 1).padStart(3, '0')}-${t.id}`,
        transport: deps.transport,
        signal,
        onProgress: (f, phase) =>
          actx.progress({ phase: phase === 'processing' ? 'processing' : 'downloading', message: label(t), trackIndex: i, trackCount: total, fraction: (i + f) / total }),
      })
      const { manifest: _m, ...playback } = info
      acquired.push({ track: t, file: audio.file, quality: sourceQuality(info, audio), lyrics, playback })
    } catch (e) {
      if (e instanceof SourceError && SKIP_KINDS.has(e.kind)) {
        deps.log?.warn(`TIDAL track ${t.id} skipped (${e.kind})`, e.message)
        skipped.push({ id: String(t.id), title: t.title, reason: e.kind, message: e.message })
        continue
      }
      throw e
    } finally {
      deps.pacer.done()
    }
  }

  if (!acquired.length) {
    const kind = skipped.length && skipped.every((s) => s.reason === 'drm') ? 'drm' : 'unavailable'
    throw new SourceError(`No track could be downloaded (${skipped.map((s) => `${s.title}: ${s.message}`).join('; ')})`, kind)
  }
  actx.progress({ phase: 'done', fraction: 1, trackCount: total, message: skipped.length ? `${skipped.length} track(s) skipped` : undefined })
  return mapRelease({ album, albumTracks, acquired, skipped, trackId: job.kind === 'track' ? job.id : undefined })
}
