// Import queue / reports / archive IPC contract (renderer <-> main).

export const IMPORT = {
  jobs: 'import:jobs',
  /** (paths: string[]) → job ids. Files, folders and zips; folders are expanded and clustered by album, zips unpacked to a temp folder first. */
  importPaths: 'import:importPaths',
  /** ('folder' | 'files') → job ids, after a native picker. */
  chooseAndImport: 'import:chooseAndImport',
  cancel: 'import:cancel',
  /** (jobId) → boolean. Failed, cancelled or finished jobs run again (already-imported files are skipped). */
  retry: 'import:retry',
  /** () → number of jobs re-queued: failed ones and finished ones whose latest report has errors. */
  retryErrors: 'import:retryErrors',
  remove: 'import:remove',
  clearFinished: 'import:clearFinished',
  pausedSources: 'import:pausedSources',
  pauseSource: 'import:pauseSource',
  resumeSource: 'import:resumeSource',
  /** (jobId, { releaseId } | { asIs: true }) */
  resolveReview: 'import:resolveReview',
  /** ({ artist?, album?, barcode? }) → ReleaseCandidate[] for the Review view's manual search. */
  searchReleases: 'import:searchReleases',
  /** (trackIds, releaseId?) → TrackLookupResult. Get Info's MusicBrainz lookup; writes nothing. */
  lookupTracks: 'import:lookupTracks',
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
  /** broadcast: something dropped or put in the Inbox couldn't be imported (message), e.g. a broken zip */
  problem: 'import:problem',
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

export interface TrackLookupResult {
  status: 'auto' | 'review' | 'unmatched'
  score: number
  release?: ReviewCandidate
  candidates: ReviewCandidate[]
  /** In release order; `patch` holds only fields that would change (apply with library:editTags). */
  changes: Array<{ id: number; title: string; patch: Record<string, unknown> }>
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
