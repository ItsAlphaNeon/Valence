// Import reports and Undo. Replaced files are hard-linked into an undo vault before being sent to
// the OS trash, so Undo can restore them even if the trash is emptied.

import { randomUUID } from 'node:crypto'
import { copyFile, link, mkdir, rm } from 'node:fs/promises'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { DB } from '@main/db/db'
import { placeFile, toAbs } from '@main/library/organizer'

export type ActionKind = 'add' | 'upgrade' | 'skip' | 'archive' | 'error' | 'review'

export interface ImportAction {
  kind: ActionKind
  relPath?: string
  /** Free-form details: title, artist, quality, reason, archive location, error text. */
  detail?: Record<string, unknown>
  undo?: {
    /** Library file to remove on undo. */
    removeLibrary?: string
    /** Archive file to remove on undo ({ root: 'archive' | 'pending', rel }). */
    removeArchive?: { where: 'archive' | 'pending'; rel: string }
    /** Vault copy of a replaced file and where it lived. */
    restore?: { vault: string; relPath: string }
    /** Plays and like moved from the replaced file's path key to the new file's Valence ID. */
    rekey?: { from: string; to: string }
  }
}

export interface ReportSummary {
  added: number
  upgraded: number
  skipped: number
  archived: number
  errors: number
  identified: 'auto' | 'review' | 'unmatched' | 'source' | 'manual'
  release?: string
}

export interface ImportReport {
  id: string
  jobId: string | null
  title: string
  source: string
  createdAt: number
  summary: ReportSummary
  actions: ImportAction[]
  undoneAt: number | null
}

export class Reports {
  constructor(
    private db: DB,
    private vaultDir: string,
  ) {}

  vaultFor(reportId: string): string {
    return join(this.vaultDir, reportId)
  }

  /** Keeps a hard link (or copy) of a file that is about to be trashed. */
  async vault(reportId: string, abs: string): Promise<string> {
    const dir = this.vaultFor(reportId)
    await mkdir(dir, { recursive: true })
    const dest = join(dir, `${randomUUID().slice(0, 8)}-${abs.split(/[\\/]/).pop()}`)
    try {
      await link(abs, dest)
    } catch {
      await copyFile(abs, dest)
    }
    return dest
  }

  save(r: Omit<ImportReport, 'createdAt' | 'undoneAt'>): void {
    this.db.transaction(() => {
      this.db
        .prepare('INSERT INTO import_reports(id, job_id, title, source, created_at, summary_json) VALUES (?, ?, ?, ?, ?, ?)')
        .run(r.id, r.jobId, r.title, r.source, Date.now(), JSON.stringify(r.summary))
      const ins = this.db.prepare('INSERT INTO import_actions(report_id, kind, rel_path, detail_json, undo_json) VALUES (?, ?, ?, ?, ?)')
      for (const a of r.actions) ins.run(r.id, a.kind, a.relPath ?? null, a.detail ? JSON.stringify(a.detail) : null, a.undo ? JSON.stringify(a.undo) : null)
    })()
  }

  list(limit = 100): Array<Omit<ImportReport, 'actions'>> {
    const rows = this.db.prepare('SELECT * FROM import_reports ORDER BY created_at DESC LIMIT ?').all(limit) as Array<Record<string, any>>
    return rows.map((r) => ({ id: r.id, jobId: r.job_id, title: r.title, source: r.source, createdAt: r.created_at, summary: JSON.parse(r.summary_json), undoneAt: r.undone_at }))
  }

  get(id: string): ImportReport | null {
    const r = this.db.prepare('SELECT * FROM import_reports WHERE id = ?').get(id) as Record<string, any> | undefined
    if (!r) return null
    const actions = (this.db.prepare('SELECT * FROM import_actions WHERE report_id = ? ORDER BY id').all(id) as Array<Record<string, any>>).map(
      (a): ImportAction => ({
        kind: a.kind,
        relPath: a.rel_path ?? undefined,
        detail: a.detail_json ? JSON.parse(a.detail_json) : undefined,
        undo: a.undo_json ? JSON.parse(a.undo_json) : undefined,
      }),
    )
    return { id: r.id, jobId: r.job_id, title: r.title, source: r.source, createdAt: r.created_at, summary: JSON.parse(r.summary_json), actions, undoneAt: r.undone_at }
  }

  /**
   * Reverts a report: trashes the files it added (library + archive) and restores replaced files.
   * Returns library-relative paths that changed (to re-index).
   */
  async undo(
    id: string,
    deps: { libraryRoot: string; archiveRoot: string | null; pendingRoot: string; trash: (abs: string) => Promise<void> },
  ): Promise<{ changed: string[]; errors: string[]; moved: Array<{ from: string; to: string }>; rekeys: Array<{ from: string; to: string }> }> {
    const report = this.get(id)
    if (!report) throw new Error('No such report')
    if (report.undoneAt) return { changed: [], errors: ['Already undone'], moved: [], rekeys: [] }
    const changed: string[] = []
    const errors: string[] = []
    // For the caller to put back: playlist entries that followed an upgrade, and moved play keys.
    const moved: Array<{ from: string; to: string }> = []
    const rekeys: Array<{ from: string; to: string }> = []
    for (const a of [...report.actions].reverse()) {
      const u = a.undo
      if (!u) continue
      try {
        if (u.removeLibrary) {
          const abs = toAbs(deps.libraryRoot, u.removeLibrary)
          if (existsSync(abs)) await deps.trash(abs)
          changed.push(u.removeLibrary)
        }
        if (u.removeArchive) {
          const root = u.removeArchive.where === 'archive' ? deps.archiveRoot : deps.pendingRoot
          const abs = root ? toAbs(root, u.removeArchive.rel) : null
          if (abs && existsSync(abs)) await deps.trash(abs)
          else if (u.removeArchive.where === 'pending' && deps.archiveRoot && existsSync(toAbs(deps.archiveRoot, u.removeArchive.rel)))
            await deps.trash(toAbs(deps.archiveRoot, u.removeArchive.rel)) // flushed since import
        }
        if (u.restore) {
          if (!existsSync(u.restore.vault)) throw new Error(`Vault copy missing for ${u.restore.relPath}`)
          const r = await placeFile(u.restore.vault, deps.libraryRoot, u.restore.relPath)
          changed.push(r.relPath)
          if (u.removeLibrary && u.removeLibrary !== r.relPath) moved.push({ from: u.removeLibrary, to: r.relPath })
          if (u.rekey) rekeys.push({ from: u.rekey.to, to: u.rekey.from.startsWith('path:') ? `path:${r.relPath}` : u.rekey.from })
        }
      } catch (e) {
        errors.push((e as Error).message)
      }
    }
    this.db.prepare('UPDATE import_reports SET undone_at = ? WHERE id = ?').run(Date.now(), id)
    await rm(this.vaultFor(id), { recursive: true, force: true }).catch(() => {})
    return { changed, errors, moved, rekeys }
  }

  /** Drops vault copies older than `days`. */
  async sweepVault(days = 30): Promise<void> {
    if (!existsSync(this.vaultDir)) return
    const cutoff = Date.now() - days * 86400000
    for (const d of readdirSync(this.vaultDir)) {
      const p = join(this.vaultDir, d)
      try {
        if (statSync(p).mtimeMs < cutoff) await rm(p, { recursive: true, force: true })
      } catch {
        /* ignore */
      }
    }
  }
}
