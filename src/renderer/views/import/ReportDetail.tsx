// One import report: summary, per-file actions and Undo.

import { useCallback, useEffect, useState } from 'react'
import { cx, plural } from '../../lib/format'
import { errorMessage, invoke } from '../../lib/ipc'
import { toast, useUi } from '../../state/ui'
import { IMPORT, type ReportAction, type ReportDetail } from '@shared/ipc/import'
import { Button, Empty, Modal, Spinner } from '../../components/ui'
import { Icon, type IconName } from '../../components/Icon'
import { basename, fmtQuality, IDENTIFIED_LABEL, sourceLabel } from './common'

interface UndoPlan {
  removeLibrary?: string
  removeArchive?: { where: 'archive' | 'pending'; rel: string }
  restore?: { vault: string; relPath: string }
}

const KIND_ORDER: ReportAction['kind'][] = ['error', 'add', 'upgrade', 'archive', 'skip', 'review']
const KIND_INFO: Record<ReportAction['kind'], { title: string; icon: IconName; cls: string }> = {
  error: { title: 'Errors', icon: 'warning', cls: 'err' },
  add: { title: 'Added', icon: 'plus', cls: 'ok' },
  upgrade: { title: 'Upgraded', icon: 'download', cls: 'accent' },
  archive: { title: 'Archived', icon: 'disc', cls: '' },
  skip: { title: 'Skipped', icon: 'check', cls: '' },
  review: { title: 'Review', icon: 'info', cls: '' },
}

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : typeof v === 'number' ? String(v) : null)

function describe(a: ReportAction): { title: string; sub: string | null } {
  const d = a.detail ?? {}
  const title = str(d.title) ?? (basename(a.relPath) || basename(str(d.file)) || 'Untitled')
  const artist = str(d.artist)
  switch (a.kind) {
    case 'add':
      return { title, sub: [artist, fmtQuality(d.quality)].filter(Boolean).join(' · ') || null }
    case 'upgrade': {
      const from = fmtQuality(d.oldQuality)
      const to = fmtQuality(d.quality)
      return { title, sub: [artist, from && to ? `${from} → ${to}` : to].filter(Boolean).join(' · ') || null }
    }
    case 'skip':
      return { title, sub: [artist, str(d.reason)].filter(Boolean).join(' · ') || null }
    case 'archive': {
      const what = d.kind === 'cover' ? 'Original cover' : d.kind === 'extra' ? 'Extra file' : 'Lossless master'
      const where = d.where === 'pending' ? 'waiting in pending' : 'in the Archive'
      return { title: d.kind === 'cover' || d.kind === 'extra' ? basename(a.relPath) || what : title, sub: `${what}, ${where}` }
    }
    case 'error':
      return { title, sub: str(d.error) ?? 'Failed' }
    default:
      return { title, sub: str(d.reason) ?? null }
  }
}

function ActionRow({ a }: { a: ReportAction }) {
  const info = KIND_INFO[a.kind] ?? KIND_INFO.review
  const { title, sub } = describe(a)
  const replaced = a.kind === 'upgrade' ? str(a.detail?.replaced) : null
  return (
    <div className={cx('imp-action', `k-${a.kind}`)}>
      <span className={cx('imp-action-icon', info.cls)}>
        <Icon name={info.icon} size={14} />
      </span>
      <div className="list-main">
        <div className="imp-action-title ellipsis" title={title}>
          {title}
        </div>
        {sub && <div className={cx('list-sub', a.kind === 'error' && 'imp-err-text')}>{sub}</div>}
        {a.relPath && (
          <div className="mono faint ellipsis imp-action-path selectable" title={a.relPath}>
            {a.relPath}
          </div>
        )}
        {replaced && replaced !== a.relPath && (
          <div className="mono faint ellipsis imp-action-path" title={replaced}>
            replaced {replaced}
          </div>
        )}
      </div>
    </div>
  )
}

function UndoModal({ report, onClose, onDone }: { report: ReportDetail; onClose: () => void; onDone: () => void }) {
  const [busy, setBusy] = useState(false)
  const plans = report.actions.map((a) => (a.undo ?? null) as UndoPlan | null).filter((u): u is UndoPlan => !!u)
  const removes = plans.filter((u) => u.removeLibrary).length
  const restores = plans.filter((u) => u.restore).length
  const archived = plans.filter((u) => u.removeArchive).length
  const go = async () => {
    setBusy(true)
    try {
      const r = await invoke<{ changed: string[]; errors: string[] }>(IMPORT.undo, report.id)
      if (r.errors.length) toast(`Undone with ${plural(r.errors.length, 'problem')}: ${r.errors[0]}`, 'error')
      else toast(`Undid “${report.title}”`, 'ok')
      onDone()
    } catch (e) {
      toast(`Undo failed: ${errorMessage(e)}`, 'error')
      setBusy(false)
    }
  }
  return (
    <Modal
      title="Undo this import?"
      width={440}
      onClose={() => !busy && onClose()}
      footer={
        <>
          <Button kind="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button kind="primary" icon="undo" onClick={() => void go()} disabled={busy}>
            {busy ? 'Undoing…' : 'Undo Import'}
          </Button>
        </>
      }
    >
      <p className="imp-modal-text">
        <b>{report.title}</b> will be rolled back:
      </p>
      <ul className="imp-modal-list">
        {removes > 0 && <li>{plural(removes, 'file')} it added to the library move to the Trash.</li>}
        {restores > 0 && <li>{plural(restores, 'file')} it replaced {restores === 1 ? 'is' : 'are'} put back.</li>}
        {archived > 0 && <li>{plural(archived, 'archived file')} (masters, covers, extras) move to the Trash.</li>}
      </ul>
      <p className="faint imp-modal-text">Files go to the system Trash, so you can still recover them there.</p>
    </Modal>
  )
}

export function ReportDetailView({ id }: { id: string }) {
  const [report, setReport] = useState<ReportDetail | null | undefined>(undefined)
  const [confirm, setConfirm] = useState(false)
  const load = useCallback(() => {
    invoke<ReportDetail | null>(IMPORT.report, id).then(setReport, (e) => {
      toast(`Couldn’t load the report: ${errorMessage(e)}`, 'error')
      setReport(null)
    })
  }, [id])
  useEffect(() => {
    setReport(undefined)
    load()
  }, [load])

  const back = () => {
    const ui = useUi.getState()
    const prev = ui.back.at(-1)
    if (prev?.view === 'import' && !prev.reportId) ui.goBack()
    else ui.navigate({ view: 'import', tab: 'reports' }, { replace: true })
  }

  const backBtn = (
    <Button kind="ghost" small icon="chevronLeft" onClick={back} className="imp-back">
      All Reports
    </Button>
  )

  if (report === undefined)
    return (
      <>
        {backBtn}
        <div className="center-spin">
          <Spinner />
        </div>
      </>
    )
  if (report === null)
    return (
      <>
        {backBtn}
        <Empty icon="warning" title="Report not found">
          <span>It may have been removed, or it was made on another device.</span>
        </Empty>
      </>
    )

  const undoable = !report.undoneAt && report.actions.some((a) => !!a.undo)
  const s = report.summary
  const groups = KIND_ORDER.map((k) => ({ kind: k, actions: report.actions.filter((a) => a.kind === k) })).filter((g) => g.actions.length)
  const when = new Date(report.createdAt)

  return (
    <div className="imp-report">
      {backBtn}
      <div className="imp-report-head">
        <div className="grow">
          <h2 className="imp-review-title">{report.title}</h2>
          <div className="imp-review-meta">
            <span className="chip imp-src">{sourceLabel(report.source)}</span>
            <span>{when.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}</span>
            <span className="faint">· {IDENTIFIED_LABEL[s.identified] ?? s.identified}</span>
            {s.release && s.release !== report.title && <span className="faint ellipsis">· {s.release}</span>}
          </div>
        </div>
        {report.undoneAt ? (
          <span className="chip">
            <Icon name="undo" size={12} /> Undone {new Date(report.undoneAt).toLocaleDateString()}
          </span>
        ) : (
          <Button icon="undo" onClick={() => setConfirm(true)} disabled={!undoable} title={undoable ? 'Roll this import back' : 'Nothing in this import can be undone'}>
            Undo Import
          </Button>
        )}
      </div>

      <div className="imp-stats">
        {(
          [
            ['Added', s.added, 'ok'],
            ['Upgraded', s.upgraded, 'accent'],
            ['Skipped', s.skipped, ''],
            ['Archived', s.archived, ''],
            ['Errors', s.errors, 'err'],
          ] as const
        ).map(([label, n, cls]) => (
          <div key={label} className={cx('imp-stat', n > 0 && cls)}>
            <div className="imp-stat-value tnum">{n.toLocaleString()}</div>
            <div className="imp-stat-label">{label}</div>
          </div>
        ))}
      </div>

      {groups.length ? (
        groups.map((g) => (
          <section key={g.kind} className="imp-group">
            <div className="imp-group-head">
              <span>{KIND_INFO[g.kind].title}</span>
              <span className="faint tnum">{g.actions.length}</span>
            </div>
            <div className="card glass imp-group-card imp-actions">
              {g.actions.map((a, i) => (
                <ActionRow key={i} a={a} />
              ))}
            </div>
          </section>
        ))
      ) : (
        <p className="muted imp-panel-note">This import didn’t change any files.</p>
      )}

      {confirm && (
        <UndoModal
          report={report}
          onClose={() => setConfirm(false)}
          onDone={() => {
            setConfirm(false)
            load()
          }}
        />
      )}
    </div>
  )
}
