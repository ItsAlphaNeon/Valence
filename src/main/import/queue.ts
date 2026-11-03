// Persistent import/download queue (jobs table). Each job = acquire (source adapter → staging) +
// pipeline. Jobs survive restarts; per-source concurrency; sources can be paused (login needed,
// abuse signal); rate limits requeue with a delay; ambiguous loose imports wait in Needs Review.

import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { DB } from '@main/db/db'
import { kvGet, kvSet } from '@main/db/db'
import type { Acquirer, EnqueueRequest, ImportQueue, Logger, ValenceEnv } from '@main/context'
import type { Claims } from '@main/sync/claims'
import { SourceError, type SourceRelease } from './source-types'
import type { PipelineOptions, PipelineOutcome } from './pipeline'
import { IMPORT, type JobInfo, type JobReview, type JobStatus } from '@shared/ipc/import'

export interface QueueDeps {
  db: DB
  env: ValenceEnv
  log: Logger
  claims: Claims | null
  broadcast: (channel: string, ...args: unknown[]) => void
  process: (release: SourceRelease, opts: PipelineOptions) => Promise<PipelineOutcome>
  /** Called after a job finished successfully (e.g. the Inbox moves originals away). */
  afterDone?: (job: JobInfo, payload: unknown, release: SourceRelease) => Promise<void>
  /** Concurrent pipeline runs across all sources (transcoding is CPU-bound). */
  maxPipelines?: number
}

interface Registered {
  fn: Acquirer
  concurrency: number
}

interface Running {
  ctrl: AbortController
  lastBroadcast: number
}

const ACTIVE: JobStatus[] = ['queued', 'running', 'review']
const NETWORK_RETRIES = 3

function rowToJob(r: Record<string, any>): JobInfo {
  return {
    id: r.id,
    source: r.source,
    title: r.title,
    releaseKeys: JSON.parse(r.release_keys),
    status: r.status,
    stage: r.stage,
    progress: r.progress ?? 0,
    message: r.message,
    error: r.error,
    attempts: r.attempts,
    reportId: r.report_id,
    review: r.review_json ? (JSON.parse(r.review_json) as JobReview) : null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

export class ImportQueueImpl implements ImportQueue {
  private acquirers = new Map<string, Registered>()
  private running = new Map<string, Running>()
  private notBefore = new Map<string, number>()
  private paused: Record<string, string>
  private pipelines = 0
  private pipelineWaiters: Array<() => void> = []
  private timer: NodeJS.Timeout | null = null
  private stopped = false

  constructor(private deps: QueueDeps) {
    this.paused = kvGet<Record<string, string>>(deps.db, 'import.pausedSources', {})
    // Jobs interrupted by a quit/crash start over (acquirers resume partial downloads themselves).
    deps.db.prepare("UPDATE jobs SET status = 'queued', stage = NULL, progress = 0, updated_at = ? WHERE status = 'running'").run(Date.now())
  }

  // ---- ImportQueue (used by source modules) ----

  registerAcquirer(source: string, fn: Acquirer, opts: { concurrency?: number } = {}): void {
    this.acquirers.set(source, { fn, concurrency: Math.max(1, opts.concurrency ?? 1) })
    this.schedule()
  }

  enqueue(req: EnqueueRequest): string {
    const existing = this.findActive(req.releaseKeys)
    if (existing) return existing.id
    const id = randomUUID()
    const now = Date.now()
    this.deps.db
      .prepare('INSERT INTO jobs(id, source, title, release_keys, payload_json, status, progress, attempts, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?, ?)')
      .run(id, req.source, req.title, JSON.stringify(req.releaseKeys), JSON.stringify(req.payload ?? null), 'queued', now, now)
    this.changed()
    this.schedule()
    return id
  }

  activeKeys(): Map<string, 'queued' | 'running'> {
    const out = new Map<string, 'queued' | 'running'>()
    const rows = this.deps.db.prepare("SELECT release_keys, status FROM jobs WHERE status IN ('queued', 'running')").all() as Array<{ release_keys: string; status: 'queued' | 'running' }>
    for (const r of rows) for (const k of JSON.parse(r.release_keys) as string[]) if (out.get(k) !== 'running') out.set(k, r.status)
    return out
  }

  pauseSource(source: string, reason: string): void {
    this.paused[source] = reason
    kvSet(this.deps.db, 'import.pausedSources', this.paused)
    this.deps.broadcast(IMPORT.sourcesChanged, { ...this.paused })
    this.deps.log.warn(`import: paused ${source}: ${reason}`)
  }

  resumeSource(source: string): void {
    if (!(source in this.paused)) return
    delete this.paused[source]
    kvSet(this.deps.db, 'import.pausedSources', this.paused)
    this.deps.broadcast(IMPORT.sourcesChanged, { ...this.paused })
    this.schedule()
  }

  // ---- UI operations ----

  /** True if a not-yet-finished (or failed/cancelled) job exists for any of these keys. */
  hasJobFor(keys: string[]): boolean {
    const rows = this.deps.db.prepare("SELECT release_keys FROM jobs WHERE status != 'done'").all() as Array<{ release_keys: string }>
    return rows.some((r) => (JSON.parse(r.release_keys) as string[]).some((k) => keys.includes(k)))
  }

  pausedSources(): Record<string, string> {
    return { ...this.paused }
  }

  list(): JobInfo[] {
    return (this.deps.db.prepare('SELECT * FROM jobs ORDER BY created_at DESC LIMIT 500').all() as Array<Record<string, any>>).map(rowToJob)
  }

  get(id: string): JobInfo | null {
    const r = this.deps.db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as Record<string, any> | undefined
    return r ? rowToJob(r) : null
  }

  cancel(id: string): void {
    const run = this.running.get(id)
    if (run) run.ctrl.abort()
    const job = this.get(id)
    if (job && ACTIVE.includes(job.status)) this.update(id, { status: 'cancelled', message: 'Cancelled' })
    void this.cleanup(id)
    this.changed()
  }

  retry(id: string): void {
    const job = this.get(id)
    if (!job || !['failed', 'cancelled'].includes(job.status)) return
    this.update(id, { status: 'queued', error: null, message: null, progress: 0, attempts: 0, stage: null })
    this.notBefore.delete(id)
    this.changed()
    this.schedule()
  }

  remove(id: string): void {
    const job = this.get(id)
    if (!job) return
    if (job.status === 'running') this.cancel(id)
    this.deps.db.prepare('DELETE FROM jobs WHERE id = ?').run(id)
    void this.cleanup(id)
    this.changed()
  }

  clearFinished(): void {
    this.deps.db.prepare("DELETE FROM jobs WHERE status IN ('done', 'cancelled')").run()
    this.changed()
  }

  resolveReview(id: string, choice: { releaseId?: string; asIs?: boolean }): void {
    const job = this.get(id)
    if (!job || job.status !== 'review' || !job.review) return
    this.update(id, { status: 'queued', review: { ...job.review, choice }, message: null, progress: 0 })
    this.changed()
    this.schedule()
  }

  stop(): void {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    for (const r of this.running.values()) r.ctrl.abort()
  }

  /** Resolves once nothing is queued or running (tests, CLI import). */
  async idle(pollMs = 100): Promise<void> {
    for (;;) {
      const busy = this.deps.db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE status IN ('queued', 'running')").get() as { n: number }
      if (!busy.n && !this.running.size) return
      await new Promise((r) => setTimeout(r, pollMs))
    }
  }

  // ---- internals ----

  private findActive(keys: string[]): JobInfo | null {
    if (!keys.length) return null
    const rows = this.deps.db.prepare("SELECT * FROM jobs WHERE status IN ('queued', 'running', 'review')").all() as Array<Record<string, any>>
    for (const r of rows) {
      const ks = JSON.parse(r.release_keys) as string[]
      if (ks.some((k) => keys.includes(k))) return rowToJob(r)
    }
    return null
  }

  private update(id: string, f: Partial<Pick<JobInfo, 'status' | 'stage' | 'progress' | 'message' | 'error' | 'attempts' | 'reportId' | 'review'>>): void {
    const cols: string[] = []
    const vals: unknown[] = []
    const map: Record<string, string> = { status: 'status', stage: 'stage', progress: 'progress', message: 'message', error: 'error', attempts: 'attempts', reportId: 'report_id', review: 'review_json' }
    for (const [k, v] of Object.entries(f)) {
      cols.push(`${map[k]} = ?`)
      vals.push(k === 'review' ? (v ? JSON.stringify(v) : null) : v)
    }
    cols.push('updated_at = ?')
    vals.push(Date.now(), id)
    this.deps.db.prepare(`UPDATE jobs SET ${cols.join(', ')} WHERE id = ?`).run(...vals)
    const job = this.get(id)
    if (job) this.deps.broadcast(IMPORT.job, job)
  }

  private changed(): void {
    this.deps.broadcast(IMPORT.jobsChanged, this.list())
  }

  private schedule(delayMs = 0): void {
    if (this.stopped) return
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = null
      this.pump()
    }, delayMs)
  }

  private pump(): void {
    if (this.stopped) return
    const queued = this.deps.db.prepare("SELECT * FROM jobs WHERE status = 'queued' ORDER BY created_at").all() as Array<Record<string, any>>
    const now = Date.now()
    let nextWake = Infinity
    const runningBySource = new Map<string, number>()
    for (const id of this.running.keys()) {
      const j = this.get(id)
      if (j) runningBySource.set(j.source, (runningBySource.get(j.source) ?? 0) + 1)
    }
    for (const r of queued) {
      if (this.running.has(r.id)) continue
      const reg = this.acquirers.get(r.source)
      if (!reg || r.source in this.paused) continue
      const nb = this.notBefore.get(r.id) ?? 0
      if (nb > now) {
        nextWake = Math.min(nextWake, nb)
        continue
      }
      const n = runningBySource.get(r.source) ?? 0
      if (n >= reg.concurrency) continue
      runningBySource.set(r.source, n + 1)
      void this.run(rowToJob(r), JSON.parse(r.payload_json), reg)
    }
    if (nextWake < Infinity) this.schedule(Math.max(50, nextWake - now))
  }

  private async withPipelineSlot<T>(fn: () => Promise<T>): Promise<T> {
    const max = this.deps.maxPipelines ?? 2
    while (this.pipelines >= max) await new Promise<void>((r) => this.pipelineWaiters.push(r))
    this.pipelines++
    try {
      return await fn()
    } finally {
      this.pipelines--
      this.pipelineWaiters.shift()?.()
    }
  }

  private async run(job: JobInfo, payload: unknown, reg: Registered): Promise<void> {
    const ctrl = new AbortController()
    const state: Running = { ctrl, lastBroadcast: 0 }
    this.running.set(job.id, state)
    const claimKeys = job.releaseKeys.filter((k) => !k.startsWith('import:'))
    const { claims } = this.deps
    if (claims && claimKeys.length && !claims.claim(claimKeys)) {
      this.running.delete(job.id)
      this.notBefore.set(job.id, Date.now() + 10 * 60_000)
      this.update(job.id, { message: 'Being imported on another device; will check again shortly' })
      this.schedule(10 * 60_000)
      return
    }
    const remote = job.source !== 'import'
    const split = remote ? 0.6 : 0.05
    const progress = (fraction: number, message?: string, stage?: string) => {
      const now = Date.now()
      if (now - state.lastBroadcast < 250 && fraction < 1) return
      state.lastBroadcast = now
      this.update(job.id, { progress: Math.max(0, Math.min(1, fraction)), ...(message !== undefined ? { message } : {}), ...(stage ? { stage } : {}) })
    }
    this.update(job.id, { status: 'running', stage: 'acquire', progress: 0, error: null, message: remote ? 'Downloading' : 'Preparing' })
    this.changed()
    try {
      const release = await reg.fn(payload, {
        stagingDir: join(this.deps.env.stagingDir, `job-${job.id}`, 'src'),
        signal: ctrl.signal,
        progress: (p) => progress((p.fraction ?? 0) * split, p.message ?? p.phase, 'acquire'),
      })
      if (ctrl.signal.aborted) throw new SourceError('Cancelled', 'cancelled')
      this.update(job.id, { stage: 'process', message: 'Waiting for a free slot' })
      const outcome = await this.withPipelineSlot(() =>
        this.deps.process(release, {
          jobId: job.id,
          signal: ctrl.signal,
          choice: job.review?.choice,
          reviewAmbiguous: job.source === 'import',
          progress: (f, m) => progress(split + f * (1 - split), m, 'process'),
        }),
      )
      if (outcome.status === 'review') {
        this.update(job.id, { status: 'review', stage: null, progress: 0, message: 'Needs review', review: outcome.review })
      } else {
        this.update(job.id, { status: 'done', stage: null, progress: 1, message: summaryLine(outcome.summary), reportId: outcome.reportId })
        this.deps.broadcast(IMPORT.reportAdded, { id: outcome.reportId, title: job.title, summary: outcome.summary })
        await this.deps.afterDone?.(job, payload, release).catch((e) => this.deps.log.warn('import: afterDone failed', (e as Error).message))
        await this.cleanup(job.id)
      }
    } catch (e) {
      await this.fail(job, e, ctrl.signal.aborted)
    } finally {
      this.running.delete(job.id)
      if (claims && claimKeys.length) claims.release(claimKeys)
      this.changed()
      this.schedule()
    }
  }

  private async fail(job: JobInfo, e: unknown, aborted: boolean): Promise<void> {
    const err = e as Error
    const current = this.get(job.id)
    if (aborted || current?.status === 'cancelled' || (e instanceof SourceError && e.kind === 'cancelled')) {
      if (current && current.status !== 'cancelled') this.update(job.id, { status: this.stopped ? 'queued' : 'cancelled', stage: null })
      return
    }
    const attempts = (current?.attempts ?? 0) + 1
    if (e instanceof SourceError) {
      switch (e.kind) {
        case 'abuse':
          this.pauseSource(job.source, e.message)
          this.update(job.id, { status: 'queued', stage: null, progress: 0, attempts, message: `Paused: ${e.message}` })
          return
        case 'auth':
          this.pauseSource(job.source, 'Login required')
          this.update(job.id, { status: 'queued', stage: null, progress: 0, attempts, message: 'Waiting for login' })
          return
        case 'rate-limit': {
          const delay = e.retryAfterMs ?? 60_000
          this.notBefore.set(job.id, Date.now() + delay)
          this.update(job.id, { status: 'queued', stage: null, progress: 0, attempts, message: `Rate limited; retrying in ${Math.round(delay / 1000)} s` })
          return
        }
        case 'network':
          if (attempts <= NETWORK_RETRIES) {
            const delay = 30_000 * attempts
            this.notBefore.set(job.id, Date.now() + delay)
            this.update(job.id, { status: 'queued', stage: null, progress: 0, attempts, message: `Network error; retrying in ${delay / 1000} s` })
            return
          }
          break
        default:
          break
      }
    }
    this.deps.log.error(`import: job ${job.title} failed`, err)
    this.update(job.id, { status: 'failed', stage: null, attempts, error: err?.message ?? String(e), message: null })
    await this.cleanup(job.id)
  }

  private async cleanup(id: string): Promise<void> {
    await rm(join(this.deps.env.stagingDir, `job-${id}`), { recursive: true, force: true }).catch(() => {})
  }
}

function summaryLine(s: { added: number; upgraded: number; skipped: number; errors: number }): string {
  const parts: string[] = []
  if (s.added) parts.push(`${s.added} added`)
  if (s.upgraded) parts.push(`${s.upgraded} upgraded`)
  if (s.skipped) parts.push(`${s.skipped} skipped`)
  if (s.errors) parts.push(`${s.errors} failed`)
  return parts.join(', ') || 'Nothing to import'
}
