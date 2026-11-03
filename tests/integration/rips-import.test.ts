// A rip album through the real import pipeline: FLAC in → MP3 320 under "High Quality Rips/", the
// FLAC master in the archive, genre "High Quality Rip", rip marker kept, and no MusicBrainz or lyrics
// lookups (they would match the real game soundtracks).

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  shell: { trashItem: async () => {} },
  ipcMain: { handle() {}, removeHandler() {}, on() {} },
  BrowserWindow: { getAllWindows: () => [] },
  MessageChannelMain: class {},
  app: {},
  safeStorage: {},
}))

import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { sandbox } from '../helpers/sandbox'
import { genAudio } from '../helpers/audio'
import type { AppContext, SettingsStore, ValenceEnv } from '@main/context'
import { LibraryService } from '@main/library/service'
import { ensureValenceDir } from '@main/sync/device-log'
import { Archive } from '@main/import/archive'
import { Reports } from '@main/import/report'
import { runPipeline } from '@main/import/pipeline'
import { queryTracks } from '@main/library/queries'
import { probeFile } from '@main/tags/read'
import type { MetadataService } from '@main/metadata'
import { RIP_GENRE } from '@shared/types'

describe('rip import (integration)', () => {
  const sb = sandbox('rips-import')
  const root = join(sb.dir, 'Music')
  const env: ValenceEnv = {
    libraryRoot: root,
    dataDir: join(sb.dir, 'data'),
    archiveDir: join(sb.dir, 'Archive'),
    archivePendingDir: join(sb.dir, 'data', 'archive-pending'),
    stagingDir: join(sb.dir, 'data', 'staging'),
    artCacheDir: join(sb.dir, 'data', 'cache', 'art'),
    inboxDir: join(sb.dir, 'Inbox'),
    deviceId: 'fedcba9876543210',
    appVersion: '0.0.0-test',
  }
  // Lookups are switched on: the release itself must turn them off.
  const values = new Map<string, unknown>([['metadata.musicbrainz', true], ['lyrics.fetch', true], ['import.replaygain', false]])
  const settings: SettingsStore = { get: (k, f) => (values.has(k) ? (values.get(k) as never) : f), set: (k, v) => void values.set(k, v), onChange: () => () => {} }
  const log = { info() {}, warn() {}, error: (m: string, e?: unknown) => console.error(m, e) }
  const lookups: string[] = []
  const metadata = new Proxy({}, { get: (_t, k) => () => (lookups.push(String(k)), Promise.reject(new Error(`unexpected ${String(k)}`))) }) as MetadataService
  let library: LibraryService

  beforeAll(() => {
    for (const d of [root, env.dataDir, env.stagingDir, env.archivePendingDir, env.artCacheDir, env.archiveDir!]) mkdirSync(d, { recursive: true })
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
  })

  afterAll(() => {
    library?.stop()
    sb.cleanup()
  })

  it('imports into the rip folder with the rip genre, archives the master and never looks anything up', async () => {
    const src = join(sb.dir, 'src')
    const meta = (n: number, title: string) => ({ title, artist: 'alan', album_artist: 'SiIvaGunner', album: "SiIvaGunner's Highest Quality Rips: Volume 1", date: '2026', track: String(n), genre: 'Electronic' })
    const files = [
      await genAudio(join(src, '001.flac'), 'flac16', { seconds: 2, freq: 330, metadata: meta(1, 'HOW TO MO BAMBA') }),
      await genAudio(join(src, '002.flac'), 'flac16', { seconds: 2, freq: 440, metadata: meta(2, 'SICKO GLOW') }),
    ]
    const archive = new Archive(env, log)
    const reports = new Reports(library.db, join(env.dataDir, 'undo-vault'))
    const outcome = await runPipeline(
      {
        source: 'hqrip',
        releaseKeys: ['hqr:FOLDER'],
        albumTags: { hq_rip: 'SiIvaGunner', hqr_release: 'hqr:FOLDER' },
        tracks: files.map((file, i) => ({ file, tags: { gdrive_file_id: `F${i}` } })),
        title: 'SiIvaGunner · Volume 1',
        skipLookups: true,
      },
      { env, settings, log, library, archive, reports, transport: () => Promise.reject(new Error('offline')), trash: async () => {}, metadata },
      { jobId: 'job-rip' },
    )
    expect(outcome).toMatchObject({ status: 'done', summary: { added: 2, archived: 2, errors: 0 } })
    expect(lookups).toEqual([])

    const rows = queryTracks(library.db, { collection: 'rips' }).rows
    expect(rows.map((r) => r.relPath).sort()).toEqual([
      "High Quality Rips/SiIvaGunner's Highest Quality Rips - Volume 1/HOW TO MO BAMBA.mp3",
      "High Quality Rips/SiIvaGunner's Highest Quality Rips - Volume 1/SICKO GLOW.mp3",
    ])
    expect(rows.every((r) => r.hqRip === 'SiIvaGunner' && r.genre === RIP_GENRE)).toBe(true)
    expect(queryTracks(library.db).total).toBe(0)

    const tags = (await probeFile(join(root, ...rows[0].relPath.split('/')))).tags
    expect(tags).toMatchObject({ hq_rip: 'SiIvaGunner', hqr_release: 'hqr:FOLDER', genre: RIP_GENRE, artist: 'alan' })
    expect(tags.gdrive_file_id).toMatch(/^F[01]$/)
    expect(existsSync(join(env.archiveDir!, 'High Quality Rips', "SiIvaGunner's Highest Quality Rips - Volume 1", 'HOW TO MO BAMBA.flac'))).toBe(true)
  })
})
