// One video, one file. Every desktop syncs the playlist, so another device's copy of a rip can turn up
// at any point: before a job starts, during the download, while the file is being processed, at the
// very moment it's being filed, or hours after the other device finished. These run the real queue,
// acquirer, pipeline and library on real files over a fake yt-dlp; "Syncthing" drops a finished file
// into the library. The watcher is off, so an arrival isn't indexed until something looks.
//
// Also the cleanup of duplicates already in a library: nothing moves without an explicit list.

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

const hooks = vi.hoisted(() => ({
  trashed: [] as string[],
  beforePlace: null as (() => void) | null,
}))

vi.mock('electron', () => ({
  shell: {
    trashItem: async (p: string) => {
      hooks.trashed.push(p)
      ;(await import('node:fs')).rmSync(p)
    },
  },
  ipcMain: { handle() {}, removeHandler() {}, on() {} },
  BrowserWindow: { getAllWindows: () => [] },
  MessageChannelMain: class {},
  app: {},
  safeStorage: {},
}))

vi.mock('@main/library/organizer', async (importOriginal) => {
  const real = await importOriginal<typeof import('@main/library/organizer')>()
  return {
    ...real,
    placeFile: (...args: Parameters<typeof real.placeFile>) => {
      const hook = hooks.beforePlace
      hooks.beforePlace = null
      hook?.()
      return real.placeFile(...args)
    },
  }
})

import { appendFileSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { sandbox } from '../helpers/sandbox'
import { genAudio } from '../helpers/audio'
import type { AppContext, SettingsStore, ValenceEnv } from '@main/context'
import { Archive } from '@main/import/archive'
import { runPipeline } from '@main/import/pipeline'
import { ImportQueueImpl } from '@main/import/queue'
import { Reports } from '@main/import/report'
import { LibraryService } from '@main/library/service'
import { pathKey } from '@main/library/indexer'
import { createAcquirer } from '@main/sources/youtube/acquire'
import { SIIVAGUNNER_CHANNEL_ID } from '@main/sources/youtube/metadata'
import { DEFAULT_SEASONS, seasonAlbum, seasonFor } from '@main/sources/youtube/seasons'
import { ARRIVAL_GRACE_MS, PLAYLIST_KEY, YoutubeService } from '@main/sources/youtube/service'
import { deviceDir, ensureValenceDir } from '@main/sync/device-log'
import { writeTags } from '@main/tags/write'
import { RIP_GENRE, type TrackTags } from '@shared/types'

const OTHER_DEVICE = '77c37eb005c558b1'
const UPLOADED = '2025-12-11T16:00:34.000Z'

describe('YouTube imports are idempotent per video (integration)', () => {
  const sb = sandbox('yt-idempotent')
  const root = join(sb.dir, 'Music')
  const env: ValenceEnv = {
    libraryRoot: root,
    dataDir: join(sb.dir, 'data'),
    archiveDir: null,
    archivePendingDir: join(sb.dir, 'data', 'archive-pending'),
    stagingDir: join(sb.dir, 'data', 'staging'),
    artCacheDir: join(sb.dir, 'data', 'cache', 'art'),
    inboxDir: join(sb.dir, 'Inbox'),
    deviceId: 'c07477df2eef96ae',
    appVersion: '0.0.0-test',
  }
  const values = new Map<string, unknown>([['import.replaygain', false], [PLAYLIST_KEY, 'PLaaaaaaaaaaaaaaaa']])
  const settings: SettingsStore = { get: (k, f) => (values.has(k) ? (values.get(k) as never) : f), set: (k, v) => void values.set(k, v), onChange: () => () => {} }
  const log = { info() {}, warn() {}, error: (m: string, e?: unknown) => console.error(m, e) }
  const album = seasonAlbum(seasonFor(UPLOADED, DEFAULT_SEASONS))
  const folder = `High Quality Rips/${album.replace(':', ' -')}`
  const rel = (name: string) => `${folder}/${name}.opus`
  const abs = (r: string) => join(root, ...r.split('/'))

  let library: LibraryService
  let queue: ImportQueueImpl
  let yt: YoutubeService
  let fixture: string
  let spare = 0

  // The fake yt-dlp: a playlist, and downloads that leave an audio file and its info.json in staging.
  const downloads: string[] = []
  const titles = new Map<string, string>()
  let playlist: Array<{ id: string; title: string }> = []
  let duringDownload: ((videoId: string) => void | Promise<void>) | null = null
  let onProgress: ((message: string) => void) | null = null
  const ytdlp = {
    currentVersion: async () => null,
    run: async (args: string[]) => {
      if (args.includes('--flat-playlist')) {
        const entries = playlist.map((e) => ({ ...e, channel_id: SIIVAGUNNER_CHANNEL_ID, channel: 'SiIvaGunner', duration: 1 }))
        return { code: 0, stdout: JSON.stringify({ title: 'Rips', entries }), stderr: '' }
      }
      const url = args[args.length - 1]
      const id = decodeURIComponent(url.slice(url.indexOf('v=') + 2))
      downloads.push(id)
      await duringDownload?.(id)
      const dir = dirname(args[args.indexOf('-o') + 1])
      mkdirSync(dir, { recursive: true })
      copyFileSync(fixture, join(dir, `${id}.opus`))
      writeFileSync(join(dir, `${id}.info.json`), JSON.stringify({ id, title: titles.get(id) ?? playlist.find((e) => e.id === id)?.title ?? id, channel_id: SIIVAGUNNER_CHANNEL_ID, channel: 'SiIvaGunner', timestamp: Date.parse(UPLOADED) / 1000, duration: 1 }))
      return { code: 0, stdout: '', stderr: '' }
    },
  }

  /** A rip as another device filed it, kept out of the library until `deliver()` (synchronous). */
  async function fromOtherDevice(videoId: string, name: string, opts: { seconds?: number; to?: string } = {}) {
    const held = join(sb.dir, 'in-transit', `${spare++}.opus`)
    await genAudio(held, 'opus', { seconds: opts.seconds ?? 1, freq: 500 })
    const tags: TrackTags = { title: name, artist: 'SiIvaGunner', albumartist: 'SiIvaGunner', album, genre: RIP_GENRE, hq_rip: 'YouTube', hqr_release: 'youtube:s9', youtube_video_id: videoId, youtube_uploaded: UPLOADED, date: UPLOADED.slice(0, 10), valence_owner: OTHER_DEVICE, valence_id: `id-${spare}` }
    writeTags(held, tags)
    const target = opts.to ?? rel(name)
    return () => {
      mkdirSync(dirname(abs(target)), { recursive: true })
      renameSync(held, abs(target))
      return target
    }
  }

  /** As fromOtherDevice, delivered and indexed right away. */
  async function inLibrary(videoId: string, name: string, opts: { seconds?: number; to?: string } = {}) {
    const target = (await fromOtherDevice(videoId, name, opts))()
    await library.indexPaths([target])
    return target
  }

  const enqueue = (videoId: string, title: string) => {
    titles.set(videoId, title)
    return queue.enqueue({ source: 'youtube', title: `YouTube · ${title}`, releaseKeys: [`youtube:${videoId}`], payload: { videoId, title } })
  }
  const job = (videoId: string) => queue.list().find((j) => j.releaseKeys.includes(`youtube:${videoId}`))!
  const rows = (videoId: string) => (library.db.prepare('SELECT rel_path FROM tracks WHERE youtube_video_id = ? ORDER BY rel_path').all(videoId) as Array<{ rel_path: string }>).map((r) => r.rel_path)
  const named = (title: string) => (existsSync(abs(folder)) ? readdirSync(abs(folder)).filter((n) => n.startsWith(title)).sort() : [])
  const ownLedger = () => {
    try {
      return readFileSync(join(deviceDir(root, env.deviceId), 'ledger.jsonl'), 'utf8')
    } catch {
      return ''
    }
  }
  const writeLedgerLine = (device: string, videoId: string, line?: string) => {
    mkdirSync(deviceDir(root, device), { recursive: true })
    const ev = { hlc: '0mw0zvz1q-0000-' + device, op: 'add', rel: rel(videoId), keys: [`youtube:${videoId}`], report: 'r', q: 'lossy:opus:137' }
    appendFileSync(join(deviceDir(root, device), 'ledger.jsonl'), (line ?? JSON.stringify(ev)) + '\n')
  }
  const entryState = async (videoId: string) => (await yt.status()).entries.find((e) => e.id === videoId)?.state

  /** Holds the queue's one slot on a throwaway download until the returned function is called. */
  function occupyQueue(blocker: string): { released: () => void; started: Promise<void> } {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    let started!: () => void
    const startedP = new Promise<void>((r) => (started = r))
    duringDownload = async (id) => {
      if (id === blocker) {
        started()
        await gate
      }
    }
    enqueue(blocker, blocker)
    return { released: release, started: startedP }
  }

  beforeAll(async () => {
    for (const d of [root, env.dataDir, env.stagingDir, env.archivePendingDir, env.artCacheDir]) mkdirSync(d, { recursive: true })
    fixture = await genAudio(join(sb.dir, 'fixture.opus'), 'opus', { seconds: 1, freq: 440 })
    const ctx = {
      env,
      settings,
      secrets: { get: () => null, set() {} },
      library: null as never,
      imports: null as never,
      playlists: { mirror() {} },
      broadcast() {},
      log,
    } as unknown as AppContext
    library = new LibraryService(ctx)
    ctx.library = library.lookup
    ensureValenceDir(root, env.deviceId, { appVersion: env.appVersion })
    const archive = new Archive(env, log)
    const reports = new Reports(library.db, join(env.dataDir, 'undo-vault'))
    queue = new ImportQueueImpl({
      db: library.db,
      env,
      log,
      claims: library.claims,
      broadcast() {},
      process: (release, opts) =>
        runPipeline(
          release,
          { env, settings, log, library, archive, reports, transport: () => Promise.reject(new Error('offline')), trash: async () => {}, metadata: null },
          {
            ...opts,
            progress: (f, m) => {
              onProgress?.(m)
              opts.progress?.(f, m)
            },
          },
        ),
    })
    ctx.imports = queue
    yt = new YoutubeService(ctx, library, ytdlp as never)
    queue.registerAcquirer(
      'youtube',
      createAcquirer({ ytdlp: ytdlp as never, seasons: () => DEFAULT_SEASONS, coverFor: (s, dir) => yt.coverFor(s, dir), positionFor: (a, u) => yt.positionFor(a, u) }),
      { concurrency: 1, skipReason: (p) => yt.skipReason((p as { videoId: string }).videoId) },
    )
  })

  afterEach(async () => {
    await queue.idle(10)
    duringDownload = null
    onProgress = null
    hooks.beforePlace = null
    downloads.length = 0
    playlist = []
    vi.restoreAllMocks()
  })

  afterAll(() => {
    queue?.stop()
    yt?.stop()
    library?.stop()
    sb.cleanup()
  })

  describe('another copy turns up mid-job', () => {
    it('never downloads a video that arrived while its job was queued', async () => {
      const { released, started } = occupyQueue('blocker-1')
      await started
      enqueue('arrivedQueued', 'Arrived Queued')
      await inLibrary('arrivedQueued', 'Arrived Queued')
      released()
      await queue.idle(10)
      expect(downloads).toEqual(['blocker-1'])
      expect(job('arrivedQueued')).toMatchObject({ status: 'done', message: 'Already in library' })
      expect(rows('arrivedQueued')).toEqual([rel('Arrived Queued')])
    })

    it('files nothing when it lands during the download, before the watcher reports it', async () => {
      const deliver = await fromOtherDevice('arrivedDownload', 'Arrived Download')
      duringDownload = () => void deliver()
      enqueue('arrivedDownload', 'Arrived Download')
      await queue.idle(10)
      expect(downloads).toEqual(['arrivedDownload'])
      expect(job('arrivedDownload')).toMatchObject({ status: 'done', message: '1 skipped' })
      expect(named('Arrived Download')).toEqual(['Arrived Download.opus'])
      expect(rows('arrivedDownload')).toEqual([rel('Arrived Download')])
      expect(ownLedger()).not.toContain('arrivedDownload')
    })

    it('files nothing when it lands after the first check, while the rip is being processed', async () => {
      const deliver = await fromOtherDevice('arrivedProcessing', 'Arrived Processing')
      onProgress = (m) => {
        if (m === 'Artwork') {
          onProgress = null
          deliver()
        }
      }
      enqueue('arrivedProcessing', 'Arrived Processing')
      await queue.idle(10)
      expect(job('arrivedProcessing')).toMatchObject({ status: 'done', message: '1 skipped' })
      expect(named('Arrived Processing')).toEqual(['Arrived Processing.opus'])
      expect(rows('arrivedProcessing')).toEqual([rel('Arrived Processing')])
      expect(ownLedger()).not.toContain('arrivedProcessing')
    })

    it('recognizes it by video id when it lands under another name in that folder', async () => {
      const deliver = await fromOtherDevice('otherName', 'Other Name', { to: rel('Other Name (renamed on the other device)') })
      onProgress = (m) => {
        if (m === 'Artwork') {
          onProgress = null
          deliver()
        }
      }
      enqueue('otherName', 'Other Name')
      await queue.idle(10)
      expect(job('otherName')).toMatchObject({ status: 'done', message: '1 skipped' })
      expect(named('Other Name')).toEqual(['Other Name (renamed on the other device).opus'])
      expect(rows('otherName')).toHaveLength(1)
    })

    it('leaves no "(2)" and no temp file when it takes the path at the instant of filing', async () => {
      const deliver = await fromOtherDevice('arrivedPlacing', 'Arrived Placing')
      hooks.beforePlace = () => void deliver()
      enqueue('arrivedPlacing', 'Arrived Placing')
      await queue.idle(10)
      expect(job('arrivedPlacing')).toMatchObject({ status: 'done', message: '1 skipped' })
      expect(named('Arrived Placing')).toEqual(['Arrived Placing.opus'])
      expect(rows('arrivedPlacing')).toEqual([rel('Arrived Placing')])
      expect(readdirSync(abs(folder)).filter((n) => n.endsWith('.valence-tmp'))).toEqual([])
      expect(ownLedger()).not.toContain('arrivedPlacing')
    })

    it('goes by video alone: a copy of another length or quality is still that video', async () => {
      const deliver = await fromOtherDevice('otherLength', 'Other Length', { seconds: 8 })
      duringDownload = () => void deliver()
      enqueue('otherLength', 'Other Length')
      await queue.idle(10)
      expect(job('otherLength')).toMatchObject({ status: 'done', message: '1 skipped' })
      expect(named('Other Length')).toEqual(['Other Length.opus'])
      expect(hooks.trashed).toEqual([])
    })

    it('still files a different video with the same title', async () => {
      await inLibrary('sameTitleA', 'Same Title')
      playlist = [{ id: 'sameTitleB', title: 'Same Title' }]
      enqueue('sameTitleB', 'Same Title')
      await queue.idle(10)
      expect(job('sameTitleB')).toMatchObject({ status: 'done', message: '1 added' })
      expect(named('Same Title')).toEqual(['Same Title (2).opus', 'Same Title.opus'])
      expect(rows('sameTitleB')).toEqual([rel('Same Title (2)')])
    })

    it('files a video once, however many times it is asked', async () => {
      playlist = [{ id: 'once', title: 'Once' }]
      enqueue('once', 'Once')
      await queue.idle(10)
      expect(rows('once')).toEqual([rel('Once')])
      enqueue('once', 'Once')
      await queue.idle(10)
      expect(downloads).toEqual(['once'])
      expect(rows('once')).toEqual([rel('Once')])
    })
  })

  // The real failure: a desktop filed the rip and released its claim, and a day later another desktop
  // synced the playlist while the file was still waiting in Syncthing's queue. No claim, no index row.
  describe('another device filed it and the file is still on its way', () => {
    it('waits for the file instead of downloading it again', async () => {
      playlist = [{ id: 'inTransit', title: 'In Transit' }]
      const deliver = await fromOtherDevice('inTransit', 'In Transit')
      writeLedgerLine(OTHER_DEVICE, 'inTransit')

      const before = await yt.sync()
      await queue.idle(10)
      expect(downloads).toEqual([])
      expect(queue.list().filter((j) => j.releaseKeys.includes('youtube:inTransit'))).toEqual([])
      expect(before.summary).toContain('1 on the way from another device')
      expect(await entryState('inTransit')).toBe('arriving')

      await library.indexPaths([deliver()])
      expect(await entryState('inTransit')).toBe('in-library')
      const after = await yt.sync()
      await queue.idle(10)
      expect(downloads).toEqual([])
      expect(after.summary).toContain('already in library')
      expect(rows('inTransit')).toEqual([rel('In Transit')])
    })

    it('downloads it after all if it never turns up', async () => {
      playlist = [{ id: 'neverArrives', title: 'Never Arrives' }]
      writeLedgerLine(OTHER_DEVICE, 'neverArrives')
      const t0 = Date.now()
      const now = vi.spyOn(Date, 'now')

      now.mockReturnValue(t0)
      await yt.sync()
      now.mockReturnValue(t0 + ARRIVAL_GRACE_MS - 3600_000)
      await yt.sync()
      await queue.idle(10)
      expect(downloads).toEqual([])
      expect(await entryState('neverArrives')).toBe('arriving')

      now.mockReturnValue(t0 + ARRIVAL_GRACE_MS + 1)
      await yt.sync()
      await queue.idle(10)
      expect(downloads).toEqual(['neverArrives'])
      expect(rows('neverArrives')).toEqual([rel('Never Arrives')])
    })

    it('counts the wait from when this device first needed the video, not from when it was filed', async () => {
      // A device back after a week: the ledger line is old, and the file is still on its way.
      playlist = [{ id: 'oldLine', title: 'Old Line' }]
      writeLedgerLine(OTHER_DEVICE, 'oldLine')
      const now = vi.spyOn(Date, 'now')
      now.mockReturnValue(Date.parse('2030-01-01T00:00:00Z'))
      await yt.sync()
      await queue.idle(10)
      expect(downloads).toEqual([])
    })

    it('stops a job that was queued before the ledger line arrived', async () => {
      const { released, started } = occupyQueue('blocker-2')
      await started
      enqueue('lineWhileQueued', 'Line While Queued')
      writeLedgerLine(OTHER_DEVICE, 'lineWhileQueued')
      released()
      await queue.idle(10)
      expect(downloads).toEqual(['blocker-2'])
      expect(job('lineWhileQueued').status).toBe('done')
      expect(job('lineWhileQueued').message).toMatch(/another device/)
      expect(rows('lineWhileQueued')).toEqual([])
    })

    it("doesn't count this device's own ledger, or a line still being delivered", async () => {
      playlist = [
        { id: 'ownLine', title: 'Own Line' },
        { id: 'halfLine', title: 'Half Line' },
      ]
      writeLedgerLine(env.deviceId, 'ownLine')
      writeLedgerLine(OTHER_DEVICE, 'halfLine', '{"hlc":"x","op":"add","keys":["youtube:halfLine"')
      await yt.sync()
      await queue.idle(10)
      expect(downloads.sort()).toEqual(['halfLine', 'ownLine'])
    })
  })

  describe('cleaning up duplicates already in the library', () => {
    const conflict = rel('Dup.sync-conflict-20261105-123456-ABCDEFG')

    beforeAll(async () => {
      await inLibrary('dup', 'Dup', { to: rel('Dup') })
      await inLibrary('dup', 'Dup', { to: rel('Dup (2)') })
      await inLibrary('dup', 'Dup', { to: rel('Dup (3)') })
      await inLibrary('dup', 'Dup edit', { to: rel('Dup edit'), seconds: 8 })
      ;(await fromOtherDevice('dup', 'Dup', { to: conflict }))()
    })

    it('lists the exact files, keeps the plain name, spares edit cuts, and moves nothing', async () => {
      const groups = (await yt.duplicates()).filter((g) => g.videoId === 'dup')
      expect(groups).toEqual([{ videoId: 'dup', title: 'Dup', keep: rel('Dup'), trash: [rel('Dup (2)'), rel('Dup (3)'), conflict] }])
      expect(hooks.trashed).toEqual([])
      for (const r of [rel('Dup'), rel('Dup (2)'), rel('Dup (3)'), rel('Dup edit'), conflict]) expect(existsSync(abs(r)), r).toBe(true)
    })

    it('never calls a stale row "the copy that stays"', async () => {
      await inLibrary('stale', 'Stale', { to: rel('Stale') })
      await inLibrary('stale', 'Stale', { to: rel('Stale (2)') })
      await inLibrary('stale', 'Stale', { to: rel('Stale (3)') })
      rmSync(abs(rel('Stale'))) // gone from disk; the index hasn't noticed
      const group = (await yt.duplicates()).find((g) => g.videoId === 'stale')
      expect(group).toMatchObject({ keep: rel('Stale (2)'), trash: [rel('Stale (3)')] })

      rmSync(abs(rel('Stale (3)')))
      expect((await yt.duplicates()).find((g) => g.videoId === 'stale')).toBeUndefined()
      expect((await yt.trashDuplicates([rel('Stale (2)')])).trashed).toEqual([])
      expect(existsSync(abs(rel('Stale (2)')))).toBe(true)
    })

    it("doesn't take two rows for one file for two copies", async () => {
      await inLibrary('spelled', 'Spelled', { to: rel('Spelled') })
      // What an old rename left behind: a row under another spelling of the same name. On macOS and
      // Windows the file exists under both, and trashing "the copy" would take the only one.
      const other = rel('SPELLED')
      const cols = (library.db.prepare('PRAGMA table_info(tracks)').all() as Array<{ name: string }>).map((c) => c.name).filter((c) => c !== 'id')
      const select = cols.map((c) => (c === 'rel_path' ? '?' : c === 'path_key' ? '?' : c)).join(', ')
      library.db.prepare(`INSERT INTO tracks (${cols.join(', ')}) SELECT ${select} FROM tracks WHERE rel_path = ?`).run(...cols.flatMap((c) => (c === 'rel_path' ? [other] : c === 'path_key' ? [pathKey(other)] : [])), rel('Spelled'))
      expect(rows('spelled')).toHaveLength(2)
      expect((await yt.duplicates()).find((g) => g.videoId === 'spelled')).toBeUndefined()
      expect((await yt.trashDuplicates([other, rel('Spelled')])).trashed).toEqual([])
      expect(existsSync(abs(rel('Spelled')))).toBe(true)
    })

    it('moves only the files it was given, and never the copy that stays or a file outside the plan', async () => {
      hooks.trashed.length = 0
      const stranger = await inLibrary('stranger', 'Stranger')
      const res = await yt.trashDuplicates([rel('Dup (2)'), rel('Dup'), stranger, rel('Dup edit')])
      expect(res.trashed).toEqual([rel('Dup (2)')])
      expect(res.errors.map((e) => e.relPath)).toEqual([rel('Dup'), stranger, rel('Dup edit')])
      expect(hooks.trashed).toEqual([abs(rel('Dup (2)'))])
      for (const r of [rel('Dup'), rel('Dup edit'), conflict, stranger]) expect(existsSync(abs(r)), r).toBe(true)
      expect(rows('dup')).toHaveLength(3) // Dup, the other numbered copy, Dup edit
    })

    it('hands plays, the like, the rating and playlist entries to the copy that stays', async () => {
      // A renumber re-paths a numbered copy to the lowest free number, so ask which one is left.
      const { trash } = (await yt.duplicates()).find((g) => g.videoId === 'dup')!
      const numbered = trash.find((r) => r !== conflict)!
      const copy = (library.db.prepare('SELECT id FROM tracks WHERE rel_path = ?').get(numbered) as { id: number }).id
      library.setLiked({ kind: 'track', ids: [copy] }, true)
      library.recordPlay({ trackId: copy, playedAt: Date.now(), ms: 60_000, completed: true, skipped: false })
      await library.setRating([copy], 4)
      const playlistId = library.playlists.create('Mix', [numbered])

      const res = await yt.trashDuplicates(trash)
      expect(res).toEqual({ trashed: trash, errors: [] })
      for (const r of trash) expect(existsSync(abs(r)), r).toBe(false)

      const kept = library.db
        .prepare(
          `SELECT t.rating, t.valence_id AS key, t.track_no AS no, t.track_total AS total,
             (SELECT count(*) FROM plays p WHERE p.track_key = t.valence_id) AS plays,
             (SELECT liked FROM favorites f WHERE f.kind = 't' AND f.item_key = t.valence_id) AS liked
           FROM tracks t WHERE t.rel_path = ?`,
        )
        .get(rel('Dup')) as { rating: number; plays: number; liked: number; no: number; total: number }
      expect(kept).toMatchObject({ rating: 4, plays: 1, liked: 1 })
      expect(library.playlists.items(playlistId)).toEqual([rel('Dup')])
      expect((await yt.duplicates()).find((g) => g.videoId === 'dup')).toBeUndefined()
      // The season is renumbered without the copies that went.
      const inSeason = library.db.prepare("SELECT count(*) n FROM tracks WHERE album = ? AND hq_rip = 'YouTube'").get(album) as { n: number }
      expect(kept.total).toBe(inSeason.n)
    })
  })
})
