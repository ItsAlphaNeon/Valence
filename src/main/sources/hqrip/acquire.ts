// The 'hqrip' acquirer: one rip album (highquality.rip or SGFR) = one Google Drive folder → staged
// files → SourceRelease. The files are already tagged (title, ripper, album, cover); Valence adds the
// rip marker, the Drive ids and, only where a file lacks them, the album and album artist.

import { extname, join } from 'node:path'
import type { Acquirer, Logger } from '@main/context'
import { SourceError, type SourceRelease } from '@main/import/source-types'
import { probeFile } from '@main/tags/read'
import type { HqrCollection } from '@shared/ipc/hqrip'
import type { TrackTags } from '@shared/types'
import type { DriveClient, DriveFile } from './drive'
import { driveFileKind } from './parse'

/** Import-queue job payload (JSON; survives restarts). */
export interface HqripPayload {
  releaseId: string
  collection: HqrCollection
  title: string
  folderId: string
  catalogNumber?: string
}

export interface HqripAcquirerDeps {
  drive: DriveClient
  log?: Logger
  /** Called once the folder is listed (track count and cover file for the catalog). */
  onListed?: (releaseId: string, info: { trackCount: number; coverId: string | null }) => void
  /** Files downloaded at once within one album. */
  parallel?: number
}

const COVER_RE = /(^|\/)(cover|folder|front)\.(png|jpe?g|webp)$/i

export function createAcquirer(deps: HqripAcquirerDeps): Acquirer {
  return async (payload: HqripPayload, ctx): Promise<SourceRelease> => {
    ctx.progress({ phase: 'resolving', message: 'Listing the Google Drive folder' })
    const { files } = await deps.drive.listTree(payload.folderId, ctx.signal)
    const audio = files.filter((f) => driveFileKind(f.name) === 'audio').sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }))
    if (!audio.length) throw new SourceError('This Google Drive folder has no audio files', 'unavailable')
    const images = files.filter((f) => driveFileKind(f.name) === 'image')
    const coverFile = images.find((f) => COVER_RE.test(f.path)) ?? null
    const extras = files.filter((f) => driveFileKind(f.name) === 'extra' || (driveFileKind(f.name) === 'image' && f !== coverFile))
    deps.onListed?.(payload.releaseId, { trackCount: audio.length, coverId: coverFile?.id ?? null })

    // Staged under index names: Drive names can hold characters Windows paths can't.
    const all: Array<{ f: DriveFile; dest: string }> = [
      ...audio.map((f, i) => ({ f, dest: join(ctx.stagingDir, `${String(i + 1).padStart(3, '0')}${extname(f.name).toLowerCase()}`) })),
      ...(coverFile ? [{ f: coverFile, dest: join(ctx.stagingDir, `cover${extname(coverFile.name).toLowerCase()}`) }] : []),
      ...extras.map((f, i) => ({ f, dest: join(ctx.stagingDir, 'extras', `${String(i + 1).padStart(2, '0')}-${safeName(f.name)}`) })),
    ]
    let done = 0
    let next = 0
    const report = (partial = 0) =>
      ctx.progress({ phase: 'downloading', fraction: (done + partial) / all.length, message: `Downloading ${Math.min(done + 1, all.length)} of ${all.length} from Google Drive` })
    report()
    const worker = async () => {
      for (let i = next++; i < all.length; i = next++) {
        const { f, dest } = all[i]
        try {
          await deps.drive.download(f.id, dest, ctx.signal, (got, total) => total && report(Math.min(0.99, got / total)))
        } catch (e) {
          // A missing booklet or picture shouldn't sink the album.
          if (driveFileKind(f.name) === 'audio' || (e as SourceError).kind === 'cancelled' || (e as SourceError).kind === 'abuse' || (e as SourceError).kind === 'rate-limit') throw e
          deps.log?.warn(`hqrip: skipped ${f.path}`, (e as Error).message)
          all[i] = { f, dest: '' }
        }
        done++
        report()
      }
    }
    await Promise.all(Array.from({ length: Math.max(1, deps.parallel ?? 2) }, worker))

    ctx.progress({ phase: 'processing', message: 'Reading tags' })
    const staged = all.slice(0, audio.length)
    const first = await probeFile(staged[0].dest, { covers: false }).catch(() => null)
    const albumTags: TrackTags = {
      hq_rip: payload.collection,
      hqr_release: payload.releaseId,
      ...(payload.catalogNumber ? { catalognumber: payload.catalogNumber } : {}),
      ...(first?.tags.album ? {} : { album: payload.title }),
      ...(first?.tags.albumartist ? {} : { albumartist: payload.collection === 'SGFR' ? 'SiIvaGunner Fusion Records' : 'SiIvaGunner' }),
    }
    const coverDest = coverFile ? all[audio.length].dest : ''
    return {
      source: 'hqrip',
      releaseKeys: [payload.releaseId],
      albumTags,
      tracks: staged.map(({ f, dest }) => ({ file: dest, tags: { gdrive_file_id: f.id }, raw: { driveName: f.path } })),
      artwork: coverDest ? { file: coverDest } : undefined,
      extras: all.slice(audio.length + (coverFile ? 1 : 0)).map((x) => x.dest).filter(Boolean),
      raw: { releaseId: payload.releaseId, folderId: payload.folderId },
      title: `${payload.collection === 'SGFR' ? 'SGFR' : 'SiIvaGunner'} · ${payload.title}`,
      skipLookups: true,
    }
  }
}

function safeName(name: string): string {
  return name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(-120)
}
