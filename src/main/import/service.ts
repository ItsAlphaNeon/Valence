// Import service: wires the archive, reports, metadata service, pipeline, queue and Inbox together
// and exposes the import IPC.

import { BrowserWindow, dialog, shell } from 'electron'
import { join } from 'node:path'
import type { AppContext } from '@main/context'
import type { LibraryService } from '@main/library/service'
import { handle } from '@main/ipc'
import { createMetadataService, fileCache, type MetadataService } from '@main/metadata'
import { IMPORT } from '@shared/ipc/import'
import { Archive } from './archive'
import { Reports } from './report'
import { runPipeline } from './pipeline'
import { ImportQueueImpl } from './queue'
import { enqueueLoose, looseAcquirer, planLooseImport, type LoosePayload } from './loose'
import { Inbox } from './inbox'
import { lookupTracks } from './lookup'
import { tracksByIds } from '@main/library/queries'
import { toAbs } from '@main/library/organizer'
import { probeFile } from '@main/tags/read'
import type { Transport } from './source-types'

export class ImportService {
  readonly archive: Archive
  readonly reports: Reports
  readonly queue: ImportQueueImpl
  readonly metadata: MetadataService
  readonly inbox: Inbox
  private transport: Transport = (url, init) => fetch(url, init)

  constructor(
    private ctx: AppContext,
    private library: LibraryService,
  ) {
    const { env, settings, log } = ctx
    this.archive = new Archive(env, log, (s) => ctx.broadcast(IMPORT.archiveChanged, s))
    this.reports = new Reports(library.db, join(env.dataDir, 'undo-vault'))
    this.metadata = createMetadataService({
      transport: this.transport,
      cache: fileCache(join(env.dataDir, 'cache', 'http')),
      contact: () => settings.get('metadata.mbContact', ''),
      acoustidKey: () => settings.get<string | null>('metadata.acoustidKey', null),
      appVersion: env.appVersion,
      log,
    })
    const trash = (abs: string) => shell.trashItem(abs)
    this.queue = new ImportQueueImpl({
      db: library.db,
      env,
      log,
      claims: library.claims,
      broadcast: ctx.broadcast,
      maxPipelines: 2,
      process: (release, opts) =>
        runPipeline(
          release,
          { env, settings, log, library, archive: this.archive, reports: this.reports, transport: this.transport, trash, metadata: settings.get('metadata.musicbrainz', true) ? this.metadata : null },
          opts,
        ),
      afterDone: async (_job, payload) => {
        if ((payload as LoosePayload | null)?.inbox) await this.inbox.archiveOriginals(payload as LoosePayload)
      },
    })
    this.queue.registerAcquirer('import', looseAcquirer, { concurrency: 2 })
    this.inbox = new Inbox(env.inboxDir, this.queue, log, 4000, (k) => this.queue.hasJobFor([k]))
  }

  start(): void {
    this.archive.start()
    if (this.ctx.settings.get('import.inbox', true)) this.inbox.start()
    this.ctx.settings.onChange((k, v) => {
      if (k !== 'import.inbox') return
      if (v === false) this.inbox.stop()
      else this.inbox.start()
    })
    void this.reports.sweepVault()
    this.registerIpc()
  }

  stop(): void {
    this.inbox.stop()
    this.archive.stop()
    this.queue.stop()
  }

  async importPaths(paths: string[]): Promise<string[]> {
    return enqueueLoose(this.queue, await planLooseImport(paths))
  }

  private registerIpc(): void {
    const { env, settings } = this.ctx
    const q = this.queue
    handle(IMPORT.jobs, () => q.list())
    handle(IMPORT.importPaths, (paths: string[]) => this.importPaths(paths))
    handle(IMPORT.chooseAndImport, async (kind: 'folder' | 'files') => {
      const win = BrowserWindow.getFocusedWindow() ?? undefined
      const opts: Electron.OpenDialogOptions = {
        title: kind === 'folder' ? 'Import folder' : 'Import files',
        properties: kind === 'folder' ? ['openDirectory', 'multiSelections'] : ['openFile', 'multiSelections'],
        filters: kind === 'files' ? [{ name: 'Audio', extensions: ['mp3', 'flac', 'm4a', 'aac', 'ogg', 'opus', 'wav', 'aiff', 'aif', 'wma', 'ape', 'wv', 'alac'] }] : undefined,
      }
      const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
      return r.canceled ? [] : this.importPaths(r.filePaths)
    })
    handle(IMPORT.cancel, (id: string) => q.cancel(id))
    handle(IMPORT.retry, (id: string) => q.retry(id))
    handle(IMPORT.remove, (id: string) => q.remove(id))
    handle(IMPORT.clearFinished, () => q.clearFinished())
    handle(IMPORT.pausedSources, () => q.pausedSources())
    handle(IMPORT.pauseSource, (s: string) => q.pauseSource(s, 'Paused by you'))
    handle(IMPORT.resumeSource, (s: string) => q.resumeSource(s))
    handle(IMPORT.resolveReview, (id: string, choice: { releaseId?: string; asIs?: boolean }) => q.resolveReview(id, choice))
    handle(IMPORT.searchReleases, (query: { artist?: string; album?: string; barcode?: string }) => this.metadata.searchReleases(query))
    handle(IMPORT.lookupTracks, async (ids: number[], releaseId?: string) => {
      const rows = tracksByIds(this.library.db, ids.slice(0, 200))
      const tracks = await Promise.all(
        rows.map(async (r) => {
          const file = toAbs(env.libraryRoot, r.relPath)
          const p = await probeFile(file)
          return { id: r.id, relPath: r.relPath, file, tags: p.tags, durationMs: p.format.durationMs }
        }),
      )
      return lookupTracks(this.metadata, tracks, releaseId)
    })
    handle(IMPORT.reports, (limit?: number) => this.reports.list(limit))
    handle(IMPORT.report, (id: string) => this.reports.get(id))
    handle(IMPORT.undo, async (id: string) => {
      const r = await this.reports.undo(id, {
        libraryRoot: env.libraryRoot,
        archiveRoot: env.archiveDir,
        pendingRoot: env.archivePendingDir,
        trash: async (abs) => void (await shell.trashItem(abs)),
      })
      if (r.changed.length) await this.library.indexPaths(r.changed)
      return r
    })
    handle(IMPORT.archiveStatus, () => this.archive.status())
    handle(IMPORT.chooseArchiveDir, async () => {
      const win = BrowserWindow.getFocusedWindow() ?? undefined
      const opts: Electron.OpenDialogOptions = {
        title: 'Choose where lossless masters are kept (not synced)',
        properties: ['openDirectory', 'createDirectory'],
        defaultPath: env.archiveDir ?? undefined,
      }
      const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
      if (r.canceled || !r.filePaths[0]) return this.archive.status()
      settings.set('archive.dir', r.filePaths[0])
      env.archiveDir = r.filePaths[0]
      await this.archive.flush()
      const s = await this.archive.status()
      this.ctx.broadcast(IMPORT.archiveChanged, s)
      return s
    })
    handle(IMPORT.flushArchive, async () => {
      await this.archive.flush()
      return this.archive.status()
    })
    handle(IMPORT.inboxInfo, () => ({ dir: env.inboxDir, enabled: settings.get('import.inbox', true) }))
    handle(IMPORT.openInbox, () => shell.openPath(env.inboxDir))
  }
}
