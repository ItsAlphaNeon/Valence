// The 'youtube' acquirer: one SiIvaGunner upload → best audio stream (Opus or AAC, kept as-is) →
// SourceRelease in its season album. The track number is provisional; the service renumbers the season
// by upload time once the import is done.

import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Acquirer } from '@main/context'
import { SourceError, type SourceRelease } from '@main/import/source-types'
import type { SeasonDef } from '@shared/ipc/hqrip'
import type { TrackTags } from '@shared/types'
import { gameFromTitle, parseDescription, SIIVAGUNNER_CHANNEL_ID, uploadedAt, type YtInfo } from './metadata'
import { seasonAlbum, seasonFor } from './seasons'
import { downloadFraction, readJson, ytDlpError, type YtDlp } from './ytdlp'

export interface YoutubePayload {
  videoId: string
  title?: string
}

export interface YoutubeAcquirerDeps {
  ytdlp: YtDlp
  seasons: () => SeasonDef[]
  /** Cover image file for a season (the user's, or a generated placeholder written to `dir`). */
  coverFor: (season: SeasonDef, dir: string) => Promise<string>
  /** Provisional position in the season album: tracks already there that went up earlier, plus one. */
  positionFor: (album: string, uploaded: string) => { track: number; total: number }
}

const AUDIO = /\.(opus|m4a|webm|ogg|mp3|aac)$/i

export function createAcquirer(deps: YoutubeAcquirerDeps): Acquirer {
  return async (payload: YoutubePayload, ctx): Promise<SourceRelease> => {
    const url = `https://www.youtube.com/watch?v=${encodeURIComponent(payload.videoId)}`
    ctx.progress({ phase: 'resolving', message: 'Asking YouTube for the best audio stream' })
    const r = await deps.ytdlp.run(
      ['-f', 'bestaudio/best', '-x', '--no-playlist', '--newline', '--write-info-json', '--no-write-thumbnail', '--no-mtime', '-o', join(ctx.stagingDir, '%(id)s.%(ext)s'), url],
      {
        signal: ctx.signal,
        onLine: (line) => {
          const f = downloadFraction(line)
          if (f !== null) ctx.progress({ phase: 'downloading', fraction: f, message: `Downloading from YouTube · ${Math.round(f * 100)}%` })
        },
      },
    )
    if (r.code !== 0) throw ytDlpError(r.stderr, 'YouTube download failed')

    const files = readdirSync(ctx.stagingDir)
    const audio = files.find((f) => AUDIO.test(f) && f.startsWith(payload.videoId))
    const infoFile = files.find((f) => f.endsWith('.info.json'))
    if (!audio || !infoFile) throw new SourceError('yt-dlp finished but left no audio file', 'parse')
    const info = readJson<YtInfo>(join(ctx.stagingDir, infoFile))
    if (info.channel_id && info.channel_id !== SIIVAGUNNER_CHANNEL_ID) throw new SourceError(`Not a SiIvaGunner upload (${info.channel ?? info.channel_id})`, 'unavailable')

    const uploaded = uploadedAt(info) ?? new Date().toISOString()
    const season = seasonFor(uploaded, deps.seasons())
    const album = seasonAlbum(season)
    const desc = parseDescription(info.description)
    const pos = deps.positionFor(album, uploaded)
    const tags: TrackTags = {
      title: info.title,
      artist: 'SiIvaGunner',
      albumartist: 'SiIvaGunner',
      album,
      date: uploaded.slice(0, 10),
      tracknumber: pos.track,
      totaltracks: pos.total,
      composer: desc.composer,
      rip_game: gameFromTitle(info.title, desc.music),
      rip_platform: desc.platform,
      comment: info.webpage_url ?? url,
      hq_rip: 'YouTube',
      hqr_release: `youtube:${season.key}`,
      youtube_video_id: info.id ?? payload.videoId,
      youtube_uploaded: uploaded,
    }
    ctx.progress({ phase: 'processing', message: `Filing into ${season.name}` })
    return {
      source: 'youtube',
      releaseKeys: [`youtube:${payload.videoId}`],
      albumTags: {},
      tracks: [{ file: join(ctx.stagingDir, audio), tags, durationMs: info.duration ? info.duration * 1000 : undefined, raw: { info: { id: info.id, title: info.title, uploaded } } }],
      // The season table owns this art (and can change it), so it's no "original" to archive.
      artwork: { file: await deps.coverFor(season, ctx.stagingDir), archive: false },
      title: `YouTube · ${info.title}`,
      skipLookups: true,
    }
  }
}
