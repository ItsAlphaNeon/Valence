// Import job progress is throttled (one DB write + broadcast per interval, the latest state sent
// when it ends) while status changes and completion go out at once; activity listeners and the
// active-progress snapshot feed the taskbar progress bar.

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { sandbox } from '../helpers/sandbox'
import { openDb, type DB } from '@main/db/db'
import type { ValenceEnv } from '@main/context'
import { ImportQueueImpl, PROGRESS_INTERVAL_MS } from '@main/import/queue'
import type { AcquireProgress } from '@main/import/source-types'
import { IMPORT, type JobInfo } from '@shared/ipc/import'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('import progress throttle', () => {
  const sb = sandbox('progress')
  const env = { stagingDir: join(sb.dir, 'staging') } as ValenceEnv
  const log = { info() {}, warn() {}, error() {} }
  let db: DB
  let queue: ImportQueueImpl
  const sent: JobInfo[] = []
  let activity = 0
  const snapshots: Array<Array<{ id: string; status: string; progress: number }>> = []
  /** What each title's acquirer does with its progress callback. */
  const scripts: Record<string, (progress: (p: AcquireProgress) => void) => Promise<void>> = {}

  beforeAll(() => {
    db = openDb(':memory:')
    queue = new ImportQueueImpl({
      db,
      env,
      log,
      claims: null,
      broadcast(channel, ...args) {
        if (channel === IMPORT.job) sent.push(args[0] as JobInfo)
      },
      process: async () => ({ status: 'done', reportId: 'r', summary: { added: 1, upgraded: 0, skipped: 0, archived: 0, errors: 0, identified: 'source' as const } }),
    })
    queue.registerAcquirer('import', async (payload: { title: string }, ctx) => {
      await scripts[payload.title]?.(ctx.progress)
      return { title: payload.title } as never
    })
    queue.onActivity(() => {
      activity++
      snapshots.push(queue.activeProgress())
    })
  })
  afterAll(() => {
    queue?.stop()
    db?.close()
    sb.cleanup()
  })

  const enqueue = (title: string) => queue.enqueue({ source: 'import', title, releaseKeys: [`test:${title}`], payload: { title } })
  const forJob = (id: string) => sent.filter((j) => j.id === id)

  it('sends the first update at once and the latest one when the interval ends', async () => {
    scripts.burst = async (progress) => {
      for (let i = 1; i <= 100; i++) progress({ phase: 'downloading', fraction: i / 100, message: `step ${i}` })
      await sleep(PROGRESS_INTERVAL_MS + 150)
    }
    const id = enqueue('burst')
    await queue.idle(10)
    const acquiring = forJob(id).filter((j) => j.status === 'running' && j.stage === 'acquire')
    // The 'running' transition, the first progress, then one trailing update with the latest state.
    expect(acquiring.map((j) => j.message)).toEqual(['Preparing', 'step 1', 'step 100'])
    expect(acquiring[2].progress).toBeCloseTo(0.05) // local imports spend 5% acquiring
    const last = forJob(id).at(-1)!
    expect(last).toMatchObject({ status: 'done', progress: 1 })
  })

  it('never lets held-back progress overwrite a later status change', async () => {
    scripts.quick = async (progress) => {
      progress({ phase: 'downloading', fraction: 0.1, message: 'first' })
      progress({ phase: 'downloading', fraction: 0.2, message: 'held back' })
    }
    const id = enqueue('quick')
    await queue.idle(10)
    await sleep(PROGRESS_INTERVAL_MS + 100)
    const msgs = forJob(id).map((j) => j.message)
    expect(msgs).not.toContain('held back')
    expect(forJob(id).at(-1)).toMatchObject({ status: 'done', progress: 1 })
    expect(queue.get(id)).toMatchObject({ status: 'done', progress: 1 })
  })

  it('reports activity with a snapshot of running jobs', async () => {
    const before = activity
    let release!: () => void
    scripts.held = async (progress) => {
      progress({ phase: 'downloading', fraction: 0.5 })
      await new Promise<void>((r) => (release = r))
    }
    const id = enqueue('held')
    for (let i = 0; i < 50 && !release; i++) await sleep(10)
    expect(activity).toBeGreaterThan(before)
    expect(queue.activeProgress()).toEqual([{ id, status: 'running', progress: 0.025 }])
    release()
    await queue.idle(10)
    expect(queue.activeProgress()).toEqual([])
    expect(snapshots.at(-1)).toEqual([])
  })
})
