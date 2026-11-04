// A better copy replacing a track is the same song: its plays, like, rating and playlist entries
// stay with it, and undoing the upgrade gives them back to the copy it replaced.

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  shell: { trashItem: async () => {} },
  dialog: {},
  ipcMain: { handle() {}, removeHandler() {}, on() {} },
  BrowserWindow: { getAllWindows: () => [], getFocusedWindow: () => null },
  MessageChannelMain: class {},
  app: {},
  safeStorage: {},
}))

import { copyFileSync, mkdirSync, renameSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { sandbox } from '../helpers/sandbox'
import { genAudio } from '../helpers/audio'
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

describe('upgrading a track keeps its history (integration)', () => {
  const sb = sandbox('upgrade-history')
  const root = join(sb.dir, 'Music')
  const src = join(sb.dir, 'src')
  const trashDir = join(sb.dir, 'trash')
  const env: ValenceEnv = {
    libraryRoot: root,
    dataDir: join(sb.dir, 'data'),
    archiveDir: join(sb.dir, 'drive', 'Archive'),
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
  let reports: Reports
  let queue: ImportQueueImpl
  let trashed = 0
  const trash = async (abs: string) => {
    mkdirSync(trashDir, { recursive: true })
    renameSync(abs, join(trashDir, `${trashed++}-${abs.split(/[\\/]/).pop()}`))
  }
  const meta = (artist: string, album: string, title: string) => ({ title, artist, album_artist: artist, album, date: '2024', track: '1/1' })

  async function importAndWait(path: string) {
    const [id] = enqueueLoose(queue, await planLooseImport([path]))
    await queue.idle(50)
    const job = queue.get(id)!
    expect(job.status, job.error ?? '').toBe('done')
    return reports.get(job.reportId!)!
  }
  // What the Import → Reports "Undo" button does.
  async function undo(reportId: string) {
    const r = await reports.undo(reportId, { libraryRoot: root, archiveRoot: env.archiveDir, pendingRoot: env.archivePendingDir, trash })
    expect(r.errors).toEqual([])
    await library.indexPaths(r.changed)
    for (const m of r.moved) library.playlists.pathMoved(m.from, m.to)
    for (const k of r.rekeys) library.rekeyTrack(k.from, k.to)
  }
  const row = (rel: string) => {
    const t = queryTracks(library.db, { collection: 'all' } as never).rows.find((r) => r.relPath === rel)
    expect(t, rel).toBeTruthy()
    return t!
  }
  const play = (trackId: number, at: number) => library.recordPlay({ trackId, playedAt: at, ms: 4000, completed: true, skipped: false })

  beforeAll(async () => {
    for (const d of [root, env.dataDir, env.stagingDir, env.archivePendingDir, env.artCacheDir]) mkdirSync(d, { recursive: true })
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
    const archive = new Archive(env, log)
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
    queue.registerAcquirer('import', looseAcquirer, { concurrency: 1 })
  })

  afterAll(() => {
    queue?.stop()
    library?.stop()
    sb.cleanup()
  })

  it('an imported track keeps its Valence ID, plays, like and rating through an upgrade and its undo', async () => {
    const tags = meta('Keyed Artist', 'Keyed Album', 'Keyed Song')
    await genAudio(join(src, 'keyed-lossy', 'Keyed Song.mp3'), 'mp3_128', { seconds: 4, freq: 330, metadata: tags })
    await genAudio(join(src, 'keyed-flac', 'Keyed Song.flac'), 'flac16', { seconds: 4, freq: 330, metadata: tags })
    const rel = 'Keyed Artist/Keyed Album (2024)/Keyed Song.mp3'

    await importAndWait(join(src, 'keyed-lossy'))
    const before = row(rel)
    expect(before.valenceId).toBeTruthy()
    play(before.id, Date.now() - 60_000)
    play(before.id, Date.now() - 30_000)
    library.setLiked({ kind: 'track', ids: [before.id] }, true)
    await library.setRating([before.id], 4)
    const listId = library.playlists.create('Upgrade Mix', [rel])
    expect(row(rel)).toMatchObject({ playCount: 2, liked: true, rating: 4 })

    const report = await importAndWait(join(src, 'keyed-flac'))
    expect(report.summary).toMatchObject({ added: 0, upgraded: 1 })
    const after = row(rel)
    expect(Math.round(after.bitrate / 1000)).toBe(320)
    expect(after.valenceId).toBe(before.valenceId)
    expect((await probeFile(join(root, rel))).tags).toMatchObject({ valence_id: before.valenceId, rating: 4 })
    expect(after).toMatchObject({ playCount: 2, liked: true, rating: 4 })
    expect(library.playlists.items(listId)).toEqual([rel])

    await undo(report.id)
    const restored = row(rel)
    expect(Math.round(restored.bitrate / 1000)).toBe(128)
    expect(restored).toMatchObject({ valenceId: before.valenceId, playCount: 2, liked: true, rating: 4 })
  })

  it('a track without a Valence ID (dropped into the library) moves its plays and like to the new ID, and back on undo', async () => {
    const tags = meta('Plain Artist', 'Plain Album', 'Plain Song')
    const lossy = await genAudio(join(src, 'plain-lossy', 'Plain Song.mp3'), 'mp3_128', { seconds: 4, freq: 440, metadata: tags })
    await genAudio(join(src, 'plain-flac', 'Plain Song.flac'), 'flac16', { seconds: 4, freq: 440, metadata: tags })
    const rel = 'Plain Artist/Plain Album (2024)/Plain Song.mp3'
    mkdirSync(dirname(join(root, rel)), { recursive: true })
    copyFileSync(lossy, join(root, rel))
    await library.indexPaths([rel])
    const before = row(rel)
    expect(before.valenceId).toBeNull()
    play(before.id, Date.now() - 60_000)
    library.setLiked({ kind: 'track', ids: [before.id] }, true)
    expect(row(rel)).toMatchObject({ playCount: 1, liked: true })

    const report = await importAndWait(join(src, 'plain-flac'))
    expect(report.summary).toMatchObject({ added: 0, upgraded: 1 })
    const after = row(rel)
    expect(after.valenceId).toBeTruthy()
    expect(after).toMatchObject({ playCount: 1, liked: true })
    play(after.id, Date.now())
    expect(row(rel).playCount).toBe(2)

    await undo(report.id)
    const restored = row(rel)
    expect(restored.valenceId).toBeNull()
    // Plays made before and after the upgrade both stay with the song.
    expect(restored).toMatchObject({ playCount: 2, liked: true })
  })
})
