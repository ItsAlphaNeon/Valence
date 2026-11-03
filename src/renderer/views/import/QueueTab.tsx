import { useState, type ReactNode } from 'react'
import { cx, plural, relativeTime } from '../../lib/format'
import { useLib } from '../../state/library'
import { navigate, toast } from '../../state/ui'
import { IMPORT, type JobInfo } from '@shared/ipc/import'
import { Button, Empty, IconButton, ProgressBar } from '../../components/ui'
import { Icon } from '../../components/Icon'
import { attempt, chooseAndImport, goTab, openInboxFolder, openReport, sourceIcon, sourceLabel } from './common'

const FINISHED_PAGE = 60

function statusLine(job: JobInfo, paused: string | undefined): string {
  switch (job.status) {
    case 'running':
      return job.message || (job.stage === 'acquire' ? (job.source === 'import' ? 'Preparing' : 'Downloading') : 'Processing')
    case 'queued':
      if (paused) return `Paused — ${paused}`
      return job.message || 'Waiting'
    case 'review':
      return 'Needs review'
    case 'done':
      return job.message || 'Imported'
    case 'failed':
      return job.attempts > 1 ? `Failed after ${job.attempts} attempts` : 'Failed'
    case 'cancelled':
      return 'Cancelled'
  }
}

function JobRow({ job }: { job: JobInfo }) {
  const paused = useLib((s) => s.pausedSources[job.source])
  const running = job.status === 'running'
  const finished = job.status === 'done' || job.status === 'failed' || job.status === 'cancelled'
  const act = (kind: 'cancel' | 'retry' | 'remove') => void attempt(IMPORT[kind], [job.id], `Couldn’t ${kind} “${job.title}”`)
  return (
    <div className={cx('list-row imp-job', `is-${job.status}`)}>
      <div className="imp-job-icon">
        <Icon name={job.status === 'failed' ? 'warning' : job.status === 'done' ? 'check' : sourceIcon(job.source)} size={18} />
      </div>
      <div className="list-main">
        <div className="list-title" title={job.title}>
          {job.title}
        </div>
        <div className="imp-job-meta">
          <span className="chip imp-src">{sourceLabel(job.source)}</span>
          <span className={cx('ellipsis', job.status === 'queued' && paused && 'imp-warn')}>{statusLine(job, paused)}</span>
          {finished && <span className="faint imp-when">· {relativeTime(job.updatedAt)}</span>}
        </div>
        {running && (
          <div className="imp-job-progress">
            <ProgressBar value={job.progress} indeterminate={job.progress <= 0.001} />
            <span className="tnum faint">{Math.round(job.progress * 100)}%</span>
          </div>
        )}
        {job.status === 'failed' && job.error && (
          <div className="imp-job-error selectable" title={job.error}>
            {job.error}
          </div>
        )}
      </div>
      <div className="imp-job-actions">
        {job.status === 'review' && (
          <Button small kind="primary" onClick={() => goTab('review')}>
            Review
          </Button>
        )}
        {job.status === 'done' && job.reportId && (
          <Button small kind="ghost" onClick={() => openReport(job.reportId!)}>
            Report
          </Button>
        )}
        {(job.status === 'failed' || job.status === 'cancelled') && <IconButton icon="refresh" size={16} title="Retry" onClick={() => act('retry')} />}
        {(running || job.status === 'queued' || job.status === 'review') && <IconButton icon="close" size={16} title="Cancel" onClick={() => act('cancel')} />}
        {finished && <IconButton icon="trash" size={16} title="Remove from list" onClick={() => act('remove')} />}
      </div>
    </div>
  )
}

function Group({ title, count, aside, children }: { title: string; count: number; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="imp-group">
      <div className="imp-group-head">
        <span>{title}</span>
        <span className="faint tnum">{count}</span>
        {aside && <span className="imp-group-aside">{aside}</span>}
      </div>
      <div className="card glass imp-group-card">
        <div className="list">{children}</div>
      </div>
    </section>
  )
}

function PausedBanner() {
  const paused = useLib((s) => s.pausedSources)
  const entries = Object.entries(paused)
  if (!entries.length) return null
  return (
    <>
      {entries.map(([source, reason]) => (
        <div key={source} className="imp-banner card glass">
          <div className="imp-banner-icon">
            <Icon name="warning" size={18} />
          </div>
          <div className="grow">
            <div className="imp-banner-title">{sourceLabel(source)} downloads are paused</div>
            <div className="muted">{reason}</div>
          </div>
          {/login|auth|sign/i.test(reason) && (
            <Button small kind="ghost" onClick={() => navigate({ view: 'settings', section: 'accounts' })}>
              Accounts…
            </Button>
          )}
          <Button
            small
            onClick={async () => {
              if (await attempt(IMPORT.resumeSource, [source], `Couldn’t resume ${sourceLabel(source)}`)) toast(`${sourceLabel(source)} downloads resumed`, 'ok')
            }}
          >
            Resume
          </Button>
        </div>
      ))}
    </>
  )
}

export function QueueTab() {
  const jobs = useLib((s) => s.jobs)
  const [showAll, setShowAll] = useState(false)
  const byCreated = (a: JobInfo, b: JobInfo) => a.createdAt - b.createdAt
  const active = jobs.filter((j) => j.status === 'running').sort(byCreated)
  const waiting = jobs.filter((j) => j.status === 'queued').sort(byCreated)
  const review = jobs.filter((j) => j.status === 'review')
  const finished = jobs.filter((j) => j.status === 'done' || j.status === 'failed' || j.status === 'cancelled').sort((a, b) => b.updatedAt - a.updatedAt)
  const clearable = finished.filter((j) => j.status !== 'failed').length
  const shown = showAll ? finished : finished.slice(0, FINISHED_PAGE)

  if (!jobs.length) {
    return (
      <>
        <PausedBanner />
        <Empty icon="inbox" title="Nothing in the queue">
          <span>Import a folder, drop music onto the window, or put files in the Inbox. Downloads from TIDAL and Bandcamp show up here too.</span>
          <div className="row">
            <Button kind="primary" icon="folder" onClick={() => void chooseAndImport('folder')}>
              Import Folder…
            </Button>
            <Button icon="inbox" onClick={() => void openInboxFolder()}>
              Open Inbox
            </Button>
          </div>
        </Empty>
      </>
    )
  }

  return (
    <div className="imp-queue">
      <PausedBanner />
      {review.length > 0 && (
        <button className="imp-review-callout card glass" onClick={() => goTab('review')}>
          <Icon name="info" size={18} />
          <span className="grow">
            <b>{plural(review.length, 'import')} need{review.length === 1 ? 's' : ''} your review</b>
            <span className="muted"> — pick the right release or import as-is.</span>
          </span>
          <Icon name="chevronRight" size={14} />
        </button>
      )}
      {active.length > 0 && (
        <Group title="Active" count={active.length}>
          {active.map((j) => (
            <JobRow key={j.id} job={j} />
          ))}
        </Group>
      )}
      {waiting.length > 0 && (
        <Group title="Waiting" count={waiting.length}>
          {waiting.map((j) => (
            <JobRow key={j.id} job={j} />
          ))}
        </Group>
      )}
      {finished.length > 0 && (
        <Group
          title="Finished"
          count={finished.length}
          aside={
            clearable > 0 && (
              <Button
                small
                kind="ghost"
                title="Remove finished and cancelled imports from the list (failed ones stay)"
                onClick={async () => {
                  if (await attempt(IMPORT.clearFinished, [], 'Couldn’t clear the list')) toast(`Cleared ${plural(clearable, 'import')}`, 'ok')
                }}
              >
                Clear Finished
              </Button>
            )
          }
        >
          {shown.map((j) => (
            <JobRow key={j.id} job={j} />
          ))}
          {finished.length > shown.length && (
            <div className="imp-more">
              <Button small kind="ghost" onClick={() => setShowAll(true)}>
                Show {plural(finished.length - shown.length, 'more import')}
              </Button>
            </div>
          )}
        </Group>
      )}
    </div>
  )
}
