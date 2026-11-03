// Season albums stay in upload order: a rip added later slots in where it was released and the
// season is renumbered; moving a season boundary re-files rips into the right season; a new season
// cover is embedded into every rip of that season. Runs on real files through LibraryService.

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  shell: { trashItem: async () => {} },
  ipcMain: { handle() {}, removeHandler() {}, on() {} },
  BrowserWindow: { getAllWindows: () => [] },
  MessageChannelMain: class {},
  app: {},
  safeStorage: {},
}))

import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { sandbox } from '../helpers/sandbox'
import { genAudio, genImage } from '../helpers/audio'
import type { AppContext, SettingsStore, ValenceEnv } from '@main/context'
import { LibraryService } from '@main/library/service'
import { ensureValenceDir } from '@main/sync/device-log'
import { queryAlbums, queryTracks } from '@main/library/queries'
import { probeFile } from '@main/tags/read'
import { writeTags } from '@main/tags/write'
import { YoutubeService } from '@main/sources/youtube/service'
import { DEFAULT_SEASONS, seasonAlbum } from '@main/sources/youtube/seasons'
import { RIP_GENRE, type TrackTags } from '@shared/types'
import { readFileSync } from 'node:fs'

describe('YouTube season albums (integration)', () => {
  const sb = sandbox('yt-seasons')
  const root = join(sb.dir, 'Music')
  const env: ValenceEnv = {
    libraryRoot: root,
    dataDir: join(sb.dir, 'data'),
    archiveDir: null,
    archivePendingDir: join(sb.dir, 'data', 'archive-pending'),
    stagingDir: join(sb.dir, 'data', 'staging'),
    artCacheDir: join(sb.dir, 'data', 'cache', 'art'),
    inboxDir: join(sb.dir, 'Inbox'),
    deviceId: '00112233445566aa',
    appVersion: '0.0.0-test',
  }
  const values = new Map<string, unknown>()
  const settings: SettingsStore = { get: (k, f) => (values.has(k) ? (values.get(k) as never) : f), set: (k, v) => void values.set(k, v), onChange: () => () => {} }
  const log = { info() {}, warn() {}, error: (m: string, e?: unknown) => console.error(m, e) }
  let library: LibraryService
  let yt: YoutubeService
  const s8 = seasonAlbum(DEFAULT_SEASONS.find((s) => s.key === 's8')!)
  const s7 = seasonAlbum(DEFAULT_SEASONS.find((s) => s.key === 's7')!)

  /** Writes a season rip straight into the library (as an import would) and indexes it. */
  async function addRip(id: string, title: string, uploaded: string, album = s8, track = 1) {
    const rel = `High Quality Rips/${album.replace(':', ' -')}/${title}.opus`
    const file = join(root, ...rel.split('/'))
    await genAudio(file, 'opus', { seconds: 1, freq: 300 + track * 20 })
    const tags: TrackTags = { title, artist: 'SiIvaGunner', albumartist: 'SiIvaGunner', album, genre: RIP_GENRE, tracknumber: track, totaltracks: 1, hq_rip: 'YouTube', youtube_video_id: id, youtube_uploaded: uploaded, date: uploaded.slice(0, 10) }
    writeTags(file, tags)
    await library.indexPaths([rel])
  }

  const order = (album: string) => {
    const a = queryAlbums(library.db, { collection: 'rips' }).find((x) => x.title === album)
    return a ? queryTracks(library.db, { albumId: a.id }).rows.map((r) => [r.trackNo, r.trackTotal, r.title]) : []
  }

  beforeAll(() => {
    for (const d of [root, env.dataDir, env.stagingDir, env.archivePendingDir, env.artCacheDir]) mkdirSync(d, { recursive: true })
    const ctx = {
      env,
      settings,
      secrets: { get: () => null, set() {} },
      library: null as never,
      imports: { activeKeys: () => new Map(), enqueue: () => 'job' },
      playlists: { mirror() {} },
      broadcast() {},
      log,
    } as unknown as AppContext
    library = new LibraryService(ctx)
    ctx.library = library.lookup
    ensureValenceDir(root, env.deviceId, { appVersion: env.appVersion })
    yt = new YoutubeService(ctx, library, { currentVersion: async () => null } as never)
  })

  afterAll(() => {
    yt?.stop()
    library?.stop()
    sb.cleanup()
  })

  it('numbers a season by upload time', async () => {
    await addRip('c3', 'Third', '2024-06-01T10:00:00.000Z', s8, 1)
    await addRip('a1', 'First', '2024-02-01T10:00:00.000Z', s8, 2)
    await addRip('b2', 'Second', '2024-03-01T10:00:00.000Z', s8, 3)
    expect(await yt.renumber(s8)).toBe(3)
    expect(order(s8)).toEqual([[1, 3, 'First'], [2, 3, 'Second'], [3, 3, 'Third']])
  })

  it('slots a rip added later in where it was released and renumbers the rest', async () => {
    // Same day as "First", an hour later: the exact upload time decides.
    expect(yt.positionFor(s8, '2024-02-01T11:00:00.000Z')).toEqual({ track: 2, total: 4 })
    await addRip('d4', 'Late Addition', '2024-02-01T11:00:00.000Z', s8, 2)
    await yt.renumber(s8)
    expect(order(s8)).toEqual([[1, 4, 'First'], [2, 4, 'Late Addition'], [3, 4, 'Second'], [4, 4, 'Third']])
    const t = queryTracks(library.db, { collection: 'rips', search: 'Third' }).rows[0]
    expect((await probeFile(join(root, ...t.relPath.split('/')))).tags).toMatchObject({ tracknumber: 4, totaltracks: 4 })
    // Renumbering only rewrites tags: the files keep their names.
    expect(t.relPath).toBe('High Quality Rips/SiIvaGunner - Season 8/Third.opus')
  })

  it('re-files rips when a season boundary moves', async () => {
    const seasons = DEFAULT_SEASONS.map((s) => (s.key === 's8' ? { ...s, start: '2024-02-15' } : s))
    const info = await yt.setSeasons(seasons)
    expect(order(s7).map((r) => r[2])).toEqual(['First', 'Late Addition'])
    expect(order(s8)).toEqual([[1, 2, 'Second'], [2, 2, 'Third']])
    expect(info.find((s) => s.key === 's7')?.tracks).toBe(2)
    const moved = queryTracks(library.db, { collection: 'rips', search: 'First' }).rows[0]
    expect(moved.relPath).toBe('High Quality Rips/SiIvaGunner - Season 7 – The Year of Grand Dad/First.opus')
  })

  it('embeds a new season cover into every rip of that season, and a placeholder when reset', async () => {
    const img = readFileSync(await genImage(join(sb.dir, 'cover.png'), 1500, 'purple'))
    const info = await yt.setSeasonCover('s8', img)
    expect(info.find((s) => s.key === 's8')?.customCover).toBe(true)
    for (const r of queryTracks(library.db, { collection: 'rips', ripKinds: ['YouTube'] }).rows.filter((x) => x.album === s8)) {
      const p = await probeFile(join(root, ...r.relPath.split('/')), { covers: true })
      expect(p.picture?.mime).toBe('image/jpeg')
    }
    const reset = await yt.setSeasonCover('s8', null)
    expect(reset.find((s) => s.key === 's8')).toMatchObject({ customCover: false, cover: expect.stringMatching(/^data:image\/jpeg;base64,/) })
  })
})
