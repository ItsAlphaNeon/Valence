// Waiting for an offline archive drive: the archive refuses masters instead of keeping them in
// pending, TIDAL/Bandcamp jobs don't start (nothing lossless is downloaded), a loose job that turns
// out to need the archive is re-queued, and everything resumes once the drive is back.

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { sandbox } from '../helpers/sandbox'
import { openDb } from '@main/db/db'
import type { ValenceEnv } from '@main/context'
import { Archive } from '@main/import/archive'
import { Reports } from '@main/import/report'
import { ImportQueueImpl } from '@main/import/queue'
import { SourceError } from '@main/import/source-types'

const log = { info() {}, warn() {}, error() {} }

describe('archive while its drive is offline', () => {
  const sb = sandbox('archive-wait')
  afterAll(() => sb.cleanup())

  const setup = (name: string, waitForDrive: boolean, dir: string | null) => {
    const env = { archiveDir: dir, archivePendingDir: join(sb.dir, name, 'pending') } as ValenceEnv
    const src = join(sb.dir, name, 'master.flac')
    mkdirSync(join(sb.dir, name), { recursive: true })
    writeFileSync(src, 'flac')
    return { archive: new Archive(env, log, () => {}, { waitForDrive: () => waitForDrive }), src, env }
  }
  const missingDrive = (name: string) => join(sb.dir, name, 'unplugged', 'Archive')

  it('refuses masters and leaves them in place when waiting for the drive', async () => {
    const { archive, src, env } = setup('wait', true, missingDrive('wait'))
    expect(archive.accepting()).toBe(false)
    await expect(archive.put(src, 'A/B/T.flac')).rejects.toMatchObject({ kind: 'archive-offline' })
    expect(existsSync(src)).toBe(true)
    expect(readdirSync(env.archivePendingDir)).toEqual([])
  })

  it('keeps using pending when not waiting, or when no archive folder is chosen', async () => {
    for (const [name, wait, dir] of [['nowait', false, missingDrive('nowait')], ['unset', true, null]] as const) {
      const { archive, src } = setup(name, wait, dir)
      expect(archive.accepting()).toBe(true)
      expect(await archive.put(src, 'A/B/T.flac')).toEqual({ where: 'pending', rel: 'A/B/T.flac' })
    }
  })
})

describe('import queue while the archive drive is offline', () => {
  const sb = sandbox('archive-queue')
  let online = false
  const acquired: Record<string, number> = {}
  const processed: Record<string, number> = {}
  const db = openDb(':memory:')
  const reports = new Reports(db, join(sb.dir, 'vault'))
  const env = { stagingDir: join(sb.dir, 'staging') } as ValenceEnv
  let queue: ImportQueueImpl

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    queue = new ImportQueueImpl({
      db,
      env,
      log,
      claims: null,
      broadcast() {},
      archive: { accepting: () => online, losslessSources: ['tidal'] },
      process: async (release, opts) => {
        const title = (release as unknown as { title: string }).title
        processed[title] = (processed[title] ?? 0) + 1
        if (!online && title.includes('lossless')) throw new SourceError('Waiting for the archive drive', 'archive-offline')
        const summary = { added: 1, upgraded: 0, skipped: 0, archived: 0, errors: 0, identified: 'source' as const }
        const reportId = randomUUID()
        reports.save({ id: reportId, jobId: opts.jobId, title, source: 'test', summary, actions: [] })
        return { status: 'done', reportId, summary }
      },
    })
    const acquirer = async (payload: { title: string }, ctx: { stagingDir: string }) => {
      acquired[payload.title] = (acquired[payload.title] ?? 0) + 1
      mkdirSync(ctx.stagingDir, { recursive: true })
      writeFileSync(join(ctx.stagingDir, 'download.flac'), 'flac')
      return { title: payload.title } as never
    }
    queue.registerAcquirer('tidal', acquirer, { concurrency: 2 })
    queue.registerAcquirer('import', acquirer, { concurrency: 2 })
  })
  afterEach(async () => {
    vi.useRealTimers()
    await queue.idle(10)
    queue.stop()
  })
  afterAll(() => {
    db.close()
    sb.cleanup()
  })

  const settle = async (ms = 200) => {
    for (let t = 0; t < ms; t += 10) await vi.advanceTimersByTimeAsync(10)
  }
  const add = (source: 'tidal' | 'import', title: string) => queue.enqueue({ source, title, releaseKeys: [`${source}:${title}`], payload: { title } })

  it('holds lossless work until the drive is back, then runs it', async () => {
    online = false
    const tidal = add('tidal', 'tidal album')
    const lossy = add('import', 'loose mp3s')
    const lossless = add('import', 'loose lossless')
    await settle()

    // TIDAL never started downloading; the lossy folder imported; the lossless folder waits, staging removed.
    expect(acquired['tidal album']).toBeUndefined()
    expect(queue.get(tidal)).toMatchObject({ status: 'queued', message: 'Waiting for the archive drive' })
    expect(queue.get(lossy)?.status).toBe('done')
    expect(queue.get(lossless)).toMatchObject({ status: 'queued', message: 'Waiting for the archive drive' })
    expect(processed['loose lossless']).toBe(1)
    await vi.waitFor(() => expect(existsSync(join(env.stagingDir, `job-${lossless}`))).toBe(false))

    // Still offline after a poll: nothing re-runs.
    await settle(31_000)
    expect(processed['loose lossless']).toBe(1)

    online = true
    await settle(31_000)
    expect(queue.get(tidal)?.status).toBe('done')
    expect(queue.get(lossless)?.status).toBe('done')
    expect(acquired['tidal album']).toBe(1)
    expect(processed['loose lossless']).toBe(2)
  })
})
