// YouTube rips: wires yt-dlp, the 'youtube' acquirer (one video per job), the playlist/season service
// and IPC.

import type { AppContext } from '../../context'
import type { LibraryService } from '../../library/service'
import { handle } from '../../ipc'
import { kvGet, kvSet } from '../../db/db'
import { HQRIP_IPC, type SeasonDef } from '@shared/ipc/hqrip'
import { createAcquirer, type YoutubePayload } from './acquire'
import { YoutubeService } from './service'
import { YtDlp } from './ytdlp'

export function registerYoutube(ctx: AppContext, library: LibraryService): YoutubeService {
  const ytdlp = new YtDlp({
    dataDir: ctx.env.dataDir,
    transport: (url, init) => fetch(url, init),
    lastUpdate: { get: () => kvGet(library.db, 'ytdlp.updatedAt', 0), set: (ms) => kvSet(library.db, 'ytdlp.updatedAt', ms) },
    log: ctx.log,
  })
  const service = new YoutubeService(ctx, library, ytdlp)
  ctx.imports.registerAcquirer(
    'youtube',
    createAcquirer({
      ytdlp,
      seasons: () => service.seasons.list(),
      coverFor: (s, dir) => service.coverFor(s, dir),
      positionFor: (album, uploaded) => service.positionFor(album, uploaded),
    }),
    {
      concurrency: 2,
      afterDone: async (_payload: YoutubePayload, release) => {
        const album = release.tracks[0]?.tags.album
        if (album) service.scheduleRenumber(album)
      },
    },
  )
  handle(HQRIP_IPC.youtubeStatus, () => service.status())
  handle(HQRIP_IPC.youtubeSync, () => service.sync())
  handle(HQRIP_IPC.seasons, () => service.seasonInfo())
  handle(HQRIP_IPC.setSeasons, (seasons: SeasonDef[]) => service.setSeasons(seasons))
  handle(HQRIP_IPC.setSeasonCover, (key: string, data: Uint8Array | null) => service.setSeasonCover(String(key), data))
  return service
}
