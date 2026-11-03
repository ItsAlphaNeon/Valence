// Import queue / reports / archive IPC contract (renderer <-> main).

export const IMPORT = {
  jobs: 'import:jobs',
  /** (paths: string[]) → job ids. Files and folders; folders are expanded and clustered by album. */
  importPaths: 'import:importPaths',
  /** ('folder' | 'files') → job ids, after a native picker. */
  chooseAndImport: 'import:chooseAndImport',
  cancel: 'import:cancel',
  retry: 'import:retry',
  remove: 'import:remove',
  clearFinished: 'import:clearFinished',
  pausedSources: 'import:pausedSources',
  pauseSource: 'import:pauseSource',
  resumeSource: 'import:resumeSource',
  /** (jobId, { releaseId } | { asIs: true }) */
  resolveReview: 'import:resolveReview',
  /** ({ artist?, album?, barcode? }) → ReleaseCandidate[] for the Review view's manual search. */
  searchReleases: 'import:searchReleases',
  reports: 'import:reports',
  report: 'import:report',
  undo: 'import:undo',
  archiveStatus: 'import:archiveStatus',
  chooseArchiveDir: 'import:chooseArchiveDir',
  flushArchive: 'import:flushArchive',
  inboxInfo: 'import:inboxInfo',
  openInbox: 'import:openInbox',
  /** broadcast: one job changed (JobInfo) */
  job: 'import:job',
  /** broadcast: job list changed structurally (JobInfo[]) */
  jobsChanged: 'import:jobsChanged',
  /** broadcast: paused sources changed (Record<source, reason>) */
  sourcesChanged: 'import:sourcesChanged',
  /** broadcast: ArchiveStatus */
  archiveChanged: 'import:archiveChanged',
  /** broadcast: a report was saved ({ id, title, summary }) */
  reportAdded: 'import:reportAdded',
} as const

export type JobStatus = 'queued' | 'running' | 'review' | 'done' | 'failed' | 'cancelled'

export interface ReviewCandidate {
  releaseId: string
  releaseGroupId?: string
  title: string
  artist: string
  date?: string
  country?: string
  trackCount: number
  format?: string
  score: number
  status?: string
  type?: string
}

export interface JobReview {
  status: 'review' | 'unmatched'
  score: number
  candidates: ReviewCandidate[]
  tracks: Array<{ index: number; title: string; artist: string; album: string; durationMs: number; relPath?: string }>
  choice?: { releaseId?: string; asIs?: boolean }
}

export interface JobInfo {
  id: string
  source: string
  title: string
  releaseKeys: string[]
  status: JobStatus
  stage: string | null
  progress: number
  message: string | null
  error: string | null
  attempts: number
  reportId: string | null
  review: JobReview | null
  createdAt: number
  updatedAt: number
}

export interface ImportSummary {
  added: number
  upgraded: number
  skipped: number
  archived: number
  errors: number
  identified: 'auto' | 'review' | 'unmatched' | 'source' | 'manual'
  release?: string
}

export interface ReportListItem {
  id: string
  jobId: string | null
  title: string
  source: string
  createdAt: number
  summary: ImportSummary
  undoneAt: number | null
}

export interface ReportAction {
  kind: 'add' | 'upgrade' | 'skip' | 'archive' | 'error' | 'review'
  relPath?: string
  detail?: Record<string, unknown>
  undo?: unknown
}

export interface ReportDetail extends ReportListItem {
  actions: ReportAction[]
}

export interface ArchiveStatusInfo {
  dir: string | null
  online: boolean
  pendingFiles: number
  pendingBytes: number
}
