// Import: the queue (downloads + file imports), Needs Review and Reports.

import { bytes, cx, plural } from '../../lib/format'
import { useLib } from '../../state/library'
import { navigate } from '../../state/ui'
import { Button, IconButton, Segmented, showMenu } from '../../components/ui'
import { Icon } from '../../components/Icon'
import { archiveState, useArchiveStatus } from './useArchive'
import { chooseAndImport, goTab, openInboxFolder, type ImportTab } from './common'
import { QueueTab } from './QueueTab'
import { ReviewTab } from './ReviewTab'
import { ReportsTab } from './ReportsTab'
import './import.css'

function ArchiveChip() {
  const { status } = useArchiveStatus()
  const st = archiveState(status)
  if (!status || !st) return null
  const pending = status.pendingFiles ? ` · ${plural(status.pendingFiles, 'file')} pending` : ''
  const label = st === 'online' ? `Archive connected${pending}` : st === 'offline' ? `Archive offline${pending}` : `Archive not set${pending}`
  const kind = st === 'online' ? 'ok' : st === 'offline' || status.pendingFiles ? 'warn' : ''
  const tip =
    st === 'online'
      ? `Lossless masters go to ${status.dir}`
      : st === 'offline'
        ? `${status.dir} isn’t reachable. Masters wait in pending (${bytes(status.pendingBytes)}) until it is.`
        : `Choose an archive folder for lossless masters. ${status.pendingFiles ? `${bytes(status.pendingBytes)} waiting.` : ''}`
  return (
    <button className={cx('chip imp-chip-btn', kind)} title={tip} onClick={() => navigate({ view: 'settings', section: 'archive' })}>
      <Icon name={st === 'online' ? 'disc' : 'warning'} size={12} />
      {label}
    </button>
  )
}

export function ImportView({ tab, reportId }: { tab?: 'queue' | 'review' | 'reports'; reportId?: string }) {
  const jobs = useLib((s) => s.jobs)
  const running = jobs.filter((j) => j.status === 'running').length
  const queued = jobs.filter((j) => j.status === 'queued').length
  const review = jobs.filter((j) => j.status === 'review').length
  const current: ImportTab = reportId ? 'reports' : (tab ?? 'queue')

  const sub = running || queued ? [running && `${running} importing`, queued && `${queued} waiting`].filter(Boolean).join(' · ') : review ? `${plural(review, 'import')} waiting for review` : 'Nothing importing right now'

  return (
    <div className="view import-view">
      <div className="view-head">
        <div>
          <h1 className="view-title">Import</h1>
          <div className="view-sub">{sub}</div>
        </div>
        <div className="view-actions">
          <ArchiveChip />
          <Button icon="inbox" onClick={() => void openInboxFolder()}>
            Open Inbox
          </Button>
          <span className="imp-split">
            <Button kind="primary" icon="folder" onClick={() => void chooseAndImport('folder')}>
              Import Folder…
            </Button>
            <IconButton
              icon="chevronDown"
              size={14}
              title="More import options"
              className="imp-split-more"
              onClick={(e) => {
                const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
                showMenu({ clientX: r.left, clientY: r.bottom + 6 }, [
                  { label: 'Import Folder…', icon: 'folder', onClick: () => void chooseAndImport('folder') },
                  { label: 'Import Files…', icon: 'songs', onClick: () => void chooseAndImport('files') },
                  { separator: true },
                  { label: 'Open Inbox', icon: 'inbox', onClick: () => void openInboxFolder() },
                  { label: 'Import Settings…', icon: 'settings', onClick: () => navigate({ view: 'settings', section: 'transcoding' }) },
                ])
              }}
            />
          </span>
        </div>
      </div>

      <div className="tabs">
        <Segmented<ImportTab>
          value={current}
          onChange={(t) => (t === current && !reportId ? undefined : goTab(t))}
          options={[
            {
              value: 'queue',
              label: (
                <span className="imp-tab">
                  Queue{running + queued > 0 && <span className="imp-tab-count tnum">{running + queued}</span>}
                </span>
              ),
            },
            {
              value: 'review',
              label: (
                <span className="imp-tab">
                  Needs Review{review > 0 && <span className="imp-tab-count warn tnum">{review}</span>}
                </span>
              ),
            },
            { value: 'reports', label: 'Reports' },
          ]}
        />
      </div>

      {current === 'queue' && <QueueTab />}
      {current === 'review' && <ReviewTab />}
      {current === 'reports' && <ReportsTab reportId={reportId} />}
    </div>
  )
}

export default ImportView
