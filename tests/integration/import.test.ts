// End-to-end import pipeline on generated audio, offline (no MusicBrainz/LRCLIB): loose lossy copy
// → FLAC album upgrade + add → re-import skip → offline archive flush → undo.

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  shell: { trashItem: async () => {} },
  ipcMain: { handle() {}, removeHandler() {}, on() {} },
  BrowserWindow: { getAllWindows: () => [] },
  MessageChannelMain: class {},
  app: {},
  safeStorage: {},
}))

import { existsSync, mkdirSync, readdirSync, renameSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import sharp from 'sharp'
import { sandbox } from '../helpers/sandbox'
import { genAudio, genImage } from '../helpers/audio'
import type { AppContext, SettingsStore, ValenceEnv } from '@main/context'
import { LibraryService } from '@main/library/service'
import { ensureValenceDir } from '@main/sync/device-log'
import { Archive } from '@main/import/archive'
import { Reports } from '@main/import/report'
import { runPipeline } from '@main/import/pipeline'
import { ImportQueueImpl } from '@main/import/queue'
import { enqueueLoose, looseAcquirer, planLooseImport } from '@main/import/loose'
import { probeFile } from '@main/tags/read'
import { queryTracks } from '@main/library/queries'

function files(dir: string): string[] {
  if (!existsSync(dir)) return []
  const out: string[] = []
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name)
      if (e.isDirectory()) walk(p)
      else out.push(relative(dir, p).split(sep).join('/'))
    }
  }
  walk(dir)
  return out.sort()
}

describe('import pipeline (integration)', () => {
  const sb = sandbox('import')
  const root = join(sb.dir, 'Music')
  const src = join(sb.dir, 'src')
  const trashDir = join(sb.dir, 'trash')
  const env: ValenceEnv = {
    libraryRoot: root,
    dataDir: join(sb.dir, 'data'),
    archiveDir: join(sb.dir, 'drive', 'Archive'), // drive not present yet → offline
    archivePendingDir: join(sb.dir, 'data', 'archive-pending'),
    stagingDir: join(sb.dir, 'data', 'staging'),
    artCacheDir: join(sb.dir, 'data', 'cache', 'art'),
    inboxDir: join(sb.dir, 'Inbox'),
    deviceId: '0123456789abcdef',
    appVersion: '0.0.0-test',
  }
  const values = new Map<string, unknown>([
    ['metadata.musicbrainz', false],
    ['lyrics.fetch', false],
  ])
  const settings: SettingsStore = { get: (k, f) => (values.has(k) ? (values.get(k) as never) : f), set: (k, v) => void values.set(k, v), onChange: () => () => {} }
  const log = { info() {}, warn() {}, error: (m: string, e?: unknown) => console.error(m, e) }
  let library: LibraryService
  let archive: Archive
  let reports: Reports
  let queue: ImportQueueImpl
  let trashed = 0
  const trash = async (abs: string) => {
    mkdirSync(trashDir, { recursive: true })
    renameSync(abs, join(trashDir, `${trashed++}-${abs.split(/[\\/]/).pop()}`))
  }

  async function importAndWait(paths: string[]) {
    const ids = enqueueLoose(queue, await planLooseImport(paths))
    await queue.idle(50)
    return ids.map((id) => queue.get(id)!)
  }

  beforeAll(async () => {
    for (const d of [root, env.dataDir, env.stagingDir, env.archivePendingDir, env.artCacheDir]) mkdirSync(d, { recursive: true })
    const meta = (n: number, title: string) => ({ title, artist: 'Test Artist', album_artist: 'Test Artist', album: 'Generated Album', date: '2024', track: `${n}/3`, genre: 'Electronic; House' })
    await genAudio(join(src, 'flac', 'Generated Album', '01 Track One.flac'), 'flac16', { seconds: 4, freq: 330, metadata: meta(1, 'Track One') })
    await genAudio(join(src, 'flac', 'Generated Album', '02 Track Two.flac'), 'flac16', { seconds: 4, freq: 440, metadata: meta(2, 'Track Two') })
    await genAudio(join(src, 'flac', 'Generated Album', '03 Track Three.flac'), 'flac16', { seconds: 4, freq: 550, metadata: meta(3, 'Track Three') })
    await genImage(join(src, 'flac', 'Generated Album', 'cover.png'), 2400, 'navy')
    await genAudio(join(src, 'lossy', 'Track One.mp3'), 'mp3_128', { seconds: 4, freq: 330, metadata: meta(1, 'Track One') })
    await genAudio(join(src, 'messy', 'random downloads', 'Some Artist - Messy Song [Official Video].mp3'), 'mp3_320', { seconds: 3, freq: 660 })
    await genAudio(join(src, 'messy', 'random downloads', 'Some Artist - Another One (Lyrics).mp3'), 'mp3_320', { seconds: 3, freq: 770 })

    const ctx: AppContext = {
      env,
      settings,
      secrets: { get: () => null, set() {} },
      library: { matchTracks: (t) => t.map(() => false), albumBadge: () => ({ status: 'missing', have: 0, total: 0 }), albumBadges: (a) => a.map(() => ({ status: 'missing', have: 0, total: 0 })) },
      imports: null as never,
      playlists: { mirror() {} },
      broadcast() {},
      log,
    }
    library = new LibraryService(ctx)
    ensureValenceDir(root, env.deviceId, { appVersion: env.appVersion })
    archive = new Archive(env, log)
    reports = new Reports(library.db, join(env.dataDir, 'undo-vault'))
    queue = new ImportQueueImpl({
      db: library.db,
      env,
      log,
      claims: library.claims,
      broadcast() {},
      process: (release, opts) =>
        runPipeline(release, { env, settings, log, library, archive, reports, transport: () => Promise.reject(new Error('offline')), trash, metadata: null }, opts),
    })
    queue.registerAcquirer('import', looseAcquirer, { concurrency: 2 })
  })

  afterAll(() => {
    queue?.stop()
    library?.stop()
    sb.cleanup()
  })

  it('keeps a lossy import as-is', async () => {
    const [job] = await importAndWait([join(src, 'lossy')])
    expect(job.status).toBe('done')
    expect(files(root).filter((f) => !f.startsWith('.valence'))).toEqual(['Test Artist/Generated Album (2024)/Track One.mp3'])
    const p = await probeFile(join(root, 'Test Artist/Generated Album (2024)/Track One.mp3'))
    expect(Math.round(p.format.bitrate / 1000)).toBe(128)
    expect(p.tags.genre).toBe('Electronic')
    expect(p.tags.valence_owner).toBe(env.deviceId)
  })

  it('imports a FLAC album as MP3 320 with the master in pending archive, upgrading the lossy copy', async () => {
    const [job] = await importAndWait([join(src, 'flac', 'Generated Album')])
    expect(job.status, job.error ?? '').toBe('done')
    const report = reports.get(job.reportId!)!
    expect(report.summary).toMatchObject({ added: 2, upgraded: 1, skipped: 0, errors: 0 })

    const lib = files(root).filter((f) => !f.startsWith('.valence'))
    expect(lib).toEqual(['Test Artist/Generated Album (2024)/Track One.mp3', 'Test Artist/Generated Album (2024)/Track Three.mp3', 'Test Artist/Generated Album (2024)/Track Two.mp3'])
    for (const f of lib) {
      const p = await probeFile(join(root, f), { covers: true })
      expect(p.format.codec).toBe('mp3')
      expect(Math.round(p.format.bitrate / 1000)).toBe(320)
      expect(p.tags.album).toBe('Generated Album')
      expect(p.tags.totaltracks).toBe(3)
      expect(p.tags.replaygain_track_gain).toBeTypeOf('number')
      expect(p.tags.replaygain_album_gain).toBeTypeOf('number')
      expect(p.tags.source_quality).toBe('lossless:16:44100')
      expect(p.picture).toBeTruthy()
      const m = await sharp(p.picture!.data).metadata()
      expect(m.format).toBe('jpeg')
      expect(Math.max(m.width!, m.height!)).toBe(2000)
    }
    // Old 128k copy went to the (fake) trash; a vault copy exists for undo.
    expect(trashed).toBe(1)
    const pending = files(env.archivePendingDir)
    expect(pending).toEqual([
      'Test Artist/Generated Album (2024)/Track One.flac',
      'Test Artist/Generated Album (2024)/Track Three.flac',
      'Test Artist/Generated Album (2024)/Track Two.flac',
      'Test Artist/Generated Album (2024)/cover-original.png',
    ])
    const master = await probeFile(join(env.archivePendingDir, 'Test Artist/Generated Album (2024)/Track Two.flac'))
    expect(master.format.codec).toBe('flac')
    expect(master.tags.title).toBe('Track Two')
    expect(queryTracks(library.db, {}).total).toBe(3)
  })

  it('skips an identical re-import', async () => {
    const [job] = await importAndWait([join(src, 'flac', 'Generated Album')])
    // Same files → same release key; a finished job does not block a new one.
    expect(job.status).toBe('done')
    expect(reports.get(job.reportId!)!.summary).toMatchObject({ added: 0, upgraded: 0, skipped: 3 })
  })

  it('cleans messy loose files', async () => {
    const [job] = await importAndWait([join(src, 'messy', 'random downloads')])
    expect(job.status).toBe('done')
    const rows = queryTracks(library.db, { search: 'Some Artist' } as never).rows
    const titles = queryTracks(library.db, {}).rows.map((r) => r.title)
    expect(titles).toContain('Messy Song')
    expect(titles).toContain('Another One')
    expect(rows.length + titles.length).toBeGreaterThan(0)
    expect(files(root).some((f) => f.startsWith('Some Artist/'))).toBe(true)
  })

  it('flushes the pending archive when the drive appears', async () => {
    mkdirSync(join(sb.dir, 'drive'), { recursive: true })
    const moved = await archive.flush()
    expect(moved).toBe(4)
    expect(files(env.archivePendingDir)).toEqual([])
    expect(files(env.archiveDir!)).toHaveLength(4)
  })

  it('undoes the FLAC import (restores the lossy copy, removes masters)', async () => {
    const flacReport = reports.list().find((r) => r.summary.upgraded === 1)!
    const r = await reports.undo(flacReport.id, { libraryRoot: root, archiveRoot: env.archiveDir, pendingRoot: env.archivePendingDir, trash })
    expect(r.errors).toEqual([])
    await library.indexPaths(r.changed)
    expect(files(root).filter((f) => f.startsWith('Test Artist/'))).toEqual(['Test Artist/Generated Album (2024)/Track One.mp3'])
    const p = await probeFile(join(root, 'Test Artist/Generated Album (2024)/Track One.mp3'))
    expect(Math.round(p.format.bitrate / 1000)).toBe(128)
    expect(files(env.archiveDir!).filter((f) => f.endsWith('.flac'))).toEqual([])
    expect(queryTracks(library.db, {}).rows.filter((t) => t.album === 'Generated Album')).toHaveLength(1)
  })

  it('a fresh login resumes only a source paused for login', () => {
    queue.pauseSource('tidal', 'Login required')
    queue.pauseSource('bandcamp', 'Account flagged: slow down')
    queue.resumeAfterLogin('tidal')
    queue.resumeAfterLogin('bandcamp')
    expect(queue.pausedSources()).toEqual({ bandcamp: 'Account flagged: slow down' })
    queue.resumeSource('bandcamp')
  })
})
