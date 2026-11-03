// Import reports: newest first, grouped by day. Selecting one opens ReportDetailView.

import { useCallback, useEffect, useState } from 'react'
import { cx, plural } from '../../lib/format'
import { errorMessage, invoke, on } from '../../lib/ipc'
import { IMPORT, type ImportSummary, type ReportListItem } from '@shared/ipc/import'
import { Button, Empty, Spinner } from '../../components/ui'
import { Icon } from '../../components/Icon'
import { dayLabel, openReport, retryAllErrors, sourceIcon, sourceLabel } from './common'
import { ReportDetailView } from './ReportDetail'

export function SummaryChips({ s, compact }: { s: ImportSummary; compact?: boolean }) {
  const parts: Array<{ n: number; label: string; kind?: string }> = [
    { n: s.added, label: 'added', kind: 'ok' },
    { n: s.upgraded, label: 'upgraded', kind: 'accent' },
    { n: s.skipped, label: 'skipped' },
    { n: s.errors, label: s.errors === 1 ? 'error' : 'errors', kind: 'err' },
  ]
  if (!compact) parts.push({ n: s.archived, label: 'archived' })
  const shown = parts.filter((p) => p.n > 0)
  if (!shown.length) return <span className="chip">Nothing imported</span>
  return (
    <>
      {shown.map((p) => (
        <span key={p.label} className={cx('chip tnum', p.kind)}>
          {p.n.toLocaleString()} {p.label}
        </span>
      ))}
    </>
  )
}

function ReportsList() {
  const [items, setItems] = useState<ReportListItem[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const load = useCallback(() => {
    invoke<ReportListItem[]>(IMPORT.reports, 300).then(
      (r) => {
        setItems([...r].sort((a, b) => b.createdAt - a.createdAt))
        setError(null)
      },
      (e) => setError(errorMessage(e)),
    )
  }, [])
  useEffect(() => {
    load()
    return on(IMPORT.reportAdded, () => load())
  }, [load])

  if (error && !items) return <Empty icon="warning" title="Couldn’t load reports">{error}</Empty>
  if (!items)
    return (
      <div className="center-spin">
        <Spinner />
      </div>
    )
  if (!items.length)
    return (
      <Empty icon="clock" title="No reports yet">
        <span>Every import writes a report — what was added, upgraded or skipped — and can be undone from here.</span>
      </Empty>
    )

  // A job's newest report is its current state; an older one with errors was already retried.
  const seenJobs = new Set<string>()
  let withErrors = 0
  for (const r of items) {
    if (!r.jobId || seenJobs.has(r.jobId)) continue
    seenJobs.add(r.jobId)
    if (r.summary.errors > 0 && !r.undoneAt) withErrors++
  }

  const groups: Array<{ label: string; items: ReportListItem[] }> = []
  for (const r of items) {
    const label = dayLabel(r.createdAt)
    if (groups.at(-1)?.label !== label) groups.push({ label, items: [] })
    groups.at(-1)!.items.push(r)
  }

  return (
    <div className="imp-reports">
      {withErrors > 0 && (
        <div className="imp-reports-bar card glass">
          <Icon name="warning" size={16} className="imp-err-text" />
          <span className="grow">
            <b>{plural(withErrors, 'import')}</b> finished with errors
          </span>
          <Button small icon="refresh" onClick={() => void retryAllErrors()} title="Run every import with errors (and every failed one) again. Files already in your library are skipped.">
            Retry All
          </Button>
        </div>
      )}
      {groups.map((g) => (
        <section key={g.label} className="imp-group">
          <div className="imp-group-head">
            <span>{g.label}</span>
            <span className="faint tnum">{g.items.length}</span>
          </div>
          <div className="card glass imp-group-card">
            <div className="list">
              {g.items.map((r) => (
                <button key={r.id} className={cx('list-row imp-report-row', !!r.undoneAt && 'undone')} onClick={() => openReport(r.id)}>
                  <div className="imp-job-icon">
                    <Icon name={r.undoneAt ? 'undo' : sourceIcon(r.source)} size={18} />
                  </div>
                  <div className="list-main">
                    <div className="list-title">{r.title}</div>
                    <div className="list-sub">
                      {new Date(r.createdAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })} · {sourceLabel(r.source)}
                      {r.summary.release && r.summary.release !== r.title ? ` · ${r.summary.release}` : ''}
                    </div>
                  </div>
                  <div className="imp-report-chips">
                    {r.undoneAt ? <span className="chip">Undone</span> : <SummaryChips s={r.summary} compact />}
                  </div>
                  <Icon name="chevronRight" size={14} className="faint" />
                </button>
              ))}
            </div>
          </div>
        </section>
      ))}
      {items.length >= 300 && <p className="faint imp-panel-note">Showing the latest {plural(items.length, 'report')}.</p>}
    </div>
  )
}

export function ReportsTab({ reportId }: { reportId?: string }) {
  return reportId ? <ReportDetailView id={reportId} /> : <ReportsList />
}
