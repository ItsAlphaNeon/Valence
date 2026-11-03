// Import queue retries: finished imports whose latest report has errors, failed jobs, and the
// guards (undone reports, unknown jobs, a release another job already has).

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { sandbox } from '../helpers/sandbox'
import { openDb, type DB } from '@main/db/db'
import type { ValenceEnv } from '@main/context'
import { Reports } from '@main/import/report'
import { ImportQueueImpl } from '@main/import/queue'

describe('import queue retries', () => {
  const sb = sandbox('retry')
  const env = { stagingDir: join(sb.dir, 'staging') } as ValenceEnv
  const log = { info() {}, warn() {}, error() {} }
  let db: DB
  let queue: ImportQueueImpl
  let reports: Reports
  /** Errors each title's runs report, in order (missing → 0); 'throw' makes the acquirer fail. */
  const plan: Record<string, Array<number | 'throw'>> = {}
  const runs: Record<string, number> = {}

  const enqueue = (title: string, key = `test:${title}`) => queue.enqueue({ source: 'import', title, releaseKeys: [key], payload: { title } })

  beforeAll(() => {
    db = openDb(':memory:')
    reports = new Reports(db, join(sb.dir, 'vault'))
    queue = new ImportQueueImpl({
      db,
      env,
      log,
      claims: null,
      broadcast() {},
      process: async (release) => {
        const title = (release as unknown as { title: string }).title
        const step = plan[title]?.[runs[title] - 1]
        const errors = typeof step === 'number' ? step : 0
        const summary = { added: errors ? 0 : 1, upgraded: 0, skipped: 0, archived: 0, errors, identified: 'source' as const }
        const reportId = randomUUID()
        reports.save({ id: reportId, jobId: null, title, source: 'test', summary, actions: [] })
        return { status: 'done', reportId, summary }
      },
    })
    queue.registerAcquirer(
      'import',
      async (payload: { title: string }) => {
        runs[payload.title] = (runs[payload.title] ?? 0) + 1
        if (plan[payload.title]?.[runs[payload.title] - 1] === 'throw') throw new Error('disk full')
        return { title: payload.title } as never
      },
      { concurrency: 4 },
    )
  })

  afterAll(() => {
    queue?.stop()
    db?.close()
    sb.cleanup()
  })

  it('re-runs failed imports and finished ones with errors, skipping clean and undone ones', async () => {
    plan.partial = [2, 0]
    plan.broken = ['throw', 'throw']
    plan.undone = [1]
    const partial = enqueue('partial')
    enqueue('clean')
    const broken = enqueue('broken')
    const undone = enqueue('undone')
    await queue.idle(10)
    expect(queue.get(partial)).toMatchObject({ status: 'done', message: '2 failed' })
    expect(queue.get(broken)?.status).toBe('failed')
    db.prepare('UPDATE import_reports SET undone_at = 1 WHERE id = ?').run(queue.get(undone)!.reportId)

    expect(queue.retryErrors()).toBe(2)
    await queue.idle(10)
    expect(runs).toMatchObject({ partial: 2, clean: 1, broken: 2, undone: 1 })
    expect(queue.get(partial)).toMatchObject({ status: 'done', message: '1 added' })

    // The partial import's newest report is clean now; only the still-broken job is left.
    expect(queue.retryErrors()).toBe(1)
    await queue.idle(10)
  })

  it('retries a single finished job, but not an unknown one or one whose release is taken', async () => {
    const id = enqueue('single')
    await queue.idle(10)
    expect(queue.retry(id)).toBe(true)
    await queue.idle(10)
    expect(runs.single).toBe(2)

    expect(queue.retry('no-such-job')).toBe(false)

    queue.pauseSource('import', 'Paused by you')
    enqueue('single again', 'test:single')
    expect(queue.retry(id)).toBe(false)
    queue.resumeSource('import')
    await queue.idle(10)
  })
})
