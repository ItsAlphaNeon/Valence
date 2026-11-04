// An edit cut from a library file (a custom radio edit made from a download) keeps that file's
// tags, Valence ID included. The player, plays and likes key on that ID, so the two must not share
// it: the import gives the edit its own, and the library re-tags one that was dropped in directly.

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

import { copyFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { sandbox } from '../helpers/sandbox'
import { genAudio } from '../helpers/audio'
import type { AppContext, SettingsStore, ValenceEnv } from '@main/context'
import { derivedValenceId, LibraryService } from '@main/library/service'
import { ensureValenceDir } from '@main/sync/device-log'
import { claimValenceId, findExisting } from '@main/import/dedupe'
import { probeFile } from '@main/tags/read'
import { writeTags } from '@main/tags/write'
import { tracksByIds } from '@main/library/queries'

const SHARED = 'db5d0583-a073-4e60-a6da-4bc0ea408503'
const DEVICE = '0123456789abcdef'

describe('files sharing a Valence ID (integration)', () => {
  const sb = sandbox('shared-valence-id')
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
    deviceId: DEVICE,
    appVersion: '0.0.0-test',
  }
  const values = new Map<string, unknown>()
  const settings: SettingsStore = { get: (k, f) => (values.has(k) ? (values.get(k) as never) : f), set: (k, v) => void values.set(k, v), onChange: () => () => {} }
  const log = { info() {}, warn() {}, error: (m: string, e?: unknown) => console.error(m, e) }
  let library: LibraryService
  const dir = 'Edit Artist/It Matters (2026)'
  const original = `${dir}/It Matters.mp3`
  const edit = `${dir}/It Matters (Radio Edit).mp3`
  let editSrc = ''

  const idOf = (rel: string) => (library.db.prepare('SELECT id, valence_id FROM tracks WHERE rel_path = ?').get(rel) as { id: number; valence_id: string } | undefined)
  const place = (from: string, rel: string) => {
    mkdirSync(dirname(join(root, rel)), { recursive: true })
    copyFileSync(from, join(root, rel))
  }

  beforeAll(async () => {
    for (const d of [root, env.dataDir, env.stagingDir, env.archivePendingDir, env.artCacheDir, env.inboxDir]) mkdirSync(d, { recursive: true })
    const tags = { title: 'It Matters', artist: 'Edit Artist', album_artist: 'Edit Artist', album: 'It Matters', date: '2026', track: '1/1' }
    const full = await genAudio(join(src, 'full.mp3'), 'mp3_320', { seconds: 9, freq: 330, metadata: tags })
    editSrc = await genAudio(join(src, 'edit.mp3'), 'mp3_320', { seconds: 4, freq: 440, metadata: { ...tags, title: 'It Matters (Radio Edit)' } })
    // Both carry the download's identity, as an edit made in an audio editor does.
    for (const f of [full, editSrc]) {
      const p = await probeFile(f)
      writeTags(f, { ...p.tags, valence_id: SHARED, valence_owner: DEVICE, tidal_track_id: '123456' })
    }
    const ctx: AppContext = {
      env,
      settings,
      secrets: { get: () => null, set() {} },
      library: null as never,
      imports: null as never,
      playlists: { mirror() {} },
      broadcast: () => {},
      log,
    }
    library = new LibraryService(ctx)
    ensureValenceDir(root, env.deviceId, { appVersion: env.appVersion })
    place(full, original)
    await library.rescan()
  })

  afterAll(() => {
    library?.stop()
    sb.cleanup()
  })

  it('an import does not take the edit for a copy, and gives it its own ID', async () => {
    const edited = await probeFile(editSrc)
    // Same Valence and TIDAL IDs, different length: a different cut, not a duplicate.
    expect(findExisting(library.db, edited.tags, edited.format.durationMs)).toBeNull()
    // A true copy (about the same length) still matches.
    expect(findExisting(library.db, edited.tags, 9000)?.rel_path).toBe(original)
    const claimed = new Set<string>()
    const own = claimValenceId(library.db, SHARED, null, claimed)
    expect(own).not.toBe(SHARED)
    // Replacing the track that holds the ID keeps it, and one import never hands out an ID twice.
    expect(claimValenceId(library.db, SHARED, idOf(original)!.id, new Set())).toBe(SHARED)
    expect(claimValenceId(library.db, own, null, claimed)).not.toBe(own)
  })

  it('re-tags an edit dropped straight into the library; the original keeps its ID', async () => {
    place(editSrc, edit)
    await library.indexPaths([edit])
    await library.repairSharedIds()
    const a = idOf(original)!
    const b = idOf(edit)!
    expect(a.valence_id).toBe(SHARED)
    expect(b.valence_id).toBe(derivedValenceId(SHARED, edit))
    expect((await probeFile(join(root, edit))).tags.valence_id).toBe(b.valence_id)
    expect((await probeFile(join(root, original))).tags.valence_id).toBe(SHARED)
    // The player gets two distinct items, each pointing at its own file.
    const items = tracksByIds(library.db, [a.id, b.id]).map((t) => library.playItem(t))
    expect(new Set(items.map((i) => i.id)).size).toBe(2)
    expect(items.find((i) => i.trackId === b.id)?.path).toBe(join(root, edit))
  })

  it('keeps the ID on the original when both files arrive in one scan', async () => {
    const other = '5c1d2e3f-0000-4000-8000-00000000abcd'
    const together = 'Edit Artist/Together (2026)'
    // The edit sorts (and is indexed) first; the shorter name is still taken as the original.
    const [orig, cut] = [`${together}/Together.mp3`, `${together}/Together (Extended Edit).mp3`]
    for (const [from, rel] of [[join(root, original), orig], [editSrc, cut]] as const) {
      const tmp = join(src, `tmp-${rel.length}.mp3`)
      copyFileSync(from, tmp)
      const p = await probeFile(tmp)
      writeTags(tmp, { ...p.tags, album: 'Together', valence_id: other, valence_owner: DEVICE })
      place(tmp, rel)
    }
    await library.rescan()
    await library.repairSharedIds()
    expect(idOf(orig)!.valence_id).toBe(other)
    expect(idOf(cut)!.valence_id).toBe(derivedValenceId(other, cut))
  })

  it('leaves the same file seen at two paths, and other devices’ files, alone', async () => {
    const twin = `${dir}/It Matters (copy).mp3`
    place(join(root, original), twin)
    await library.indexPaths([twin])
    expect(await library.repairSharedIds()).toBe(0)
    expect(idOf(twin)!.valence_id).toBe(SHARED)

    const theirs = `${dir}/It Matters (their edit).mp3`
    const other = join(src, 'theirs.mp3')
    copyFileSync(editSrc, other)
    const p = await probeFile(other)
    writeTags(other, { ...p.tags, valence_id: SHARED, valence_owner: 'fedcba9876543210' })
    place(other, theirs)
    await library.indexPaths([theirs])
    expect(await library.repairSharedIds()).toBe(0)
    expect(idOf(theirs)!.valence_id).toBe(SHARED)
  })
})
