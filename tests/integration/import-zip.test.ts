// Zip imports through the real ImportService: a zip unpacks to a temp folder, its music lands in
// the library, and the temp folder is deleted once no job needs it (done, cancelled or removed;
// failed jobs keep it for Retry). Inbox zips move to Inbox/Imported afterwards.

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

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { sandbox } from '../helpers/sandbox'
import { genAudio } from '../helpers/audio'
import { makeZip } from '../fixtures/bandcamp/helpers'
import type { AppContext, SettingsStore, ValenceEnv } from '@main/context'
import { LibraryService } from '@main/library/service'
import { ensureValenceDir } from '@main/sync/device-log'
import { ImportService } from '@main/import/service'
import { IMPORT } from '@shared/ipc/import'

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

describe('zip imports (integration)', () => {
  const sb = sandbox('import-zip')
  const root = join(sb.dir, 'Music')
  const src = join(sb.dir, 'src')
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
  const zipsRoot = join(env.stagingDir, 'zips')
  const values = new Map<string, unknown>([
    ['metadata.musicbrainz', false],
    ['lyrics.fetch', false],
  ])
  const settings: SettingsStore = { get: (k, f) => (values.has(k) ? (values.get(k) as never) : f), set: (k, v) => void values.set(k, v), onChange: () => () => {} }
  const log = { info() {}, warn() {}, error: (m: string, e?: unknown) => console.error(m, e) }
  const problems: string[] = []
  let library: LibraryService
  let service: ImportService
  const albumZip = join(src, 'Zip Artist - Zip Album.zip')
  const twoAlbumsZip = join(src, 'Two Albums.zip')

  const libFiles = () => files(root).filter((f) => !f.startsWith('.valence'))
  const tempDirs = () => (existsSync(zipsRoot) ? readdirSync(zipsRoot) : [])

  async function importAndWait(paths: string[]) {
    const ids = await service.importPaths(paths)
    await service.queue.idle(50)
    return ids.map((id) => service.queue.get(id)!)
  }

  beforeAll(async () => {
    for (const d of [root, env.dataDir, env.stagingDir, env.archivePendingDir, env.artCacheDir, env.inboxDir]) mkdirSync(d, { recursive: true })
    const meta = (album: string, artist: string, n: number, title: string) => ({ title, artist, album_artist: artist, album, date: '2023', track: `${n}/2` })
    const gen = async (name: string, m: Record<string, string>, freq: number) =>
      readFileSync(await genAudio(join(src, 'gen', name), 'mp3_320', { seconds: 2, freq, metadata: m }))
    const a1 = await gen('a1.mp3', meta('Zip Album', 'Zip Artist', 1, 'First Song'), 330)
    const a2 = await gen('a2.mp3', meta('Zip Album', 'Zip Artist', 2, 'Second Song'), 440)
    const b1 = await gen('b1.mp3', meta('Other Album', 'Other Artist', 1, 'Other One'), 550)
    const b2 = await gen('b2.mp3', meta('Other Album', 'Other Artist', 2, 'Other Two'), 660)
    writeFileSync(
      albumZip,
      makeZip([
        { name: 'Zip Album/01 First Song.mp3', data: a1 },
        { name: 'Zip Album/02 Second Song.mp3', data: a2 },
        { name: 'Zip Album/setup.exe', data: 'not music' },
        { name: '__MACOSX/Zip Album/._01 First Song.mp3', data: 'junk' },
      ]),
    )
    writeFileSync(
      twoAlbumsZip,
      makeZip([
        { name: 'Other Album/01.mp3', data: b1 },
        { name: 'Other Album/02.mp3', data: b2 },
        { name: 'Zip Album/01.mp3', data: a1 },
      ]),
    )
    const ctx: AppContext = {
      env,
      settings,
      secrets: { get: () => null, set() {} },
      library: { matchTracks: (t) => t.map(() => false), albumBadge: () => ({ status: 'missing', have: 0, total: 0 }), albumBadges: (a) => a.map(() => ({ status: 'missing', have: 0, total: 0 })) },
      imports: null as never,
      playlists: { mirror() {} },
      broadcast: (ch, ...args) => {
        if (ch === IMPORT.problem) problems.push(String(args[0]))
      },
      log,
    }
    library = new LibraryService(ctx)
    ensureValenceDir(root, env.deviceId, { appVersion: env.appVersion })
    service = new ImportService(ctx, library)
  })

  afterAll(() => {
    service?.stop()
    library?.stop()
    sb.cleanup()
  })

  it('imports a dropped zip and deletes the temp copy afterwards', async () => {
    const zipBytes = readFileSync(albumZip)
    const [job] = await importAndWait([albumZip])
    expect(job.status, job.error ?? '').toBe('done')
    expect(libFiles()).toEqual(['Zip Artist/Zip Album (2023)/First Song.mp3', 'Zip Artist/Zip Album (2023)/Second Song.mp3'])
    expect(tempDirs()).toEqual([])
    expect(readFileSync(albumZip).equals(zipBytes)).toBe(true)
  })

  it('unpacks the zip again when a finished job is retried', async () => {
    const [done] = service.queue.list().filter((j) => j.status === 'done')
    expect(service.queue.retry(done.id)).toBe(true)
    await service.queue.idle(50)
    const again = service.queue.get(done.id)!
    expect(again.status, again.error ?? '').toBe('done')
    expect(again.message).toMatch(/skipped/)
    expect(tempDirs()).toEqual([])
  })

  it('keeps the temp folder until every album from the zip is imported', async () => {
    const jobs = await importAndWait([twoAlbumsZip])
    expect(jobs.map((j) => j.status)).toEqual(['done', 'done'])
    expect(libFiles()).toContain('Other Artist/Other Album (2023)/Other One.mp3')
    expect(tempDirs()).toEqual([])
  })

  it('deletes the temp folder when a queued job is removed, and keeps it for a failed one', async () => {
    service.queue.pauseSource('import', 'test')
    try {
      const [id] = await service.importPaths([albumZip])
      expect(tempDirs()).toHaveLength(1)
      const dir = join(zipsRoot, tempDirs()[0])
      // A failed job may be retried, so its files stay.
      library.db.prepare("UPDATE jobs SET status = 'failed' WHERE id = ?").run(id)
      expect(await service.zips.release(dir)).toBe(false)
      expect(existsSync(dir)).toBe(true)
      service.queue.remove(id)
      await vi.waitFor(() => expect(existsSync(dir)).toBe(false))
    } finally {
      service.queue.resumeSource('import')
    }
  })

  it('reports a broken zip instead of importing nothing silently', async () => {
    const bad = join(src, 'broken.zip')
    writeFileSync(bad, Buffer.concat([Buffer.from('PK\x03\x04'), Buffer.alloc(64)]))
    await expect(service.importPaths([bad])).rejects.toThrow(/broken\.zip can't be read/)
    const empty = join(src, 'no music.zip')
    writeFileSync(empty, makeZip([{ name: 'readme.txt', data: 'hi' }]))
    await expect(service.importPaths([empty])).rejects.toThrow(/No music found in no music\.zip/)
    // Alongside something that works, the problem is broadcast and the rest still imports.
    problems.length = 0
    const ids = await service.importPaths([bad, albumZip])
    expect(ids).toHaveLength(1)
    expect(problems).toEqual([expect.stringMatching(/broken\.zip/)])
    await service.queue.idle(50)
    expect(tempDirs()).toEqual([])
  })

  it('imports a zip from the Inbox and moves it to Imported', async () => {
    const inboxZip = join(env.inboxDir, 'Two Albums.zip')
    copyFileSync(twoAlbumsZip, inboxZip)
    const ids = await service.inbox.sweep()
    expect(ids).toHaveLength(2)
    await service.queue.idle(50)
    expect(existsSync(inboxZip)).toBe(false)
    expect(existsSync(join(env.inboxDir, 'Imported', 'Two Albums.zip'))).toBe(true)
    expect(tempDirs()).toEqual([])
  })

  it('clears leftover temp folders at startup', async () => {
    mkdirSync(join(zipsRoot, 'deadbeef0000', 'Leftover'), { recursive: true })
    writeFileSync(join(zipsRoot, 'deadbeef0000', 'Leftover', 'x.mp3'), 'x')
    await service.zips.sweep()
    expect(tempDirs()).toEqual([])
  })
})
