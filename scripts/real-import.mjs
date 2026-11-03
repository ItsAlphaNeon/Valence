// One-off "real" run: launches Valence against the real library (~/Music) and data dir, imports
// the given folders (copies; sources untouched), waits for the queue to settle and writes a
// summary to test-results/real-import.json plus screenshots.
//   node scripts/real-import.mjs <folder> [<folder> ...]
// Live MusicBrainz / Cover Art Archive / LRCLIB lookups happen; no TIDAL or Bandcamp traffic.

import { _electron as electron } from 'playwright'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const folders = process.argv.slice(2).map((p) => resolve(p))
if (!folders.length) throw new Error('usage: node scripts/real-import.mjs <folder> [...]')
const out = join(root, 'test-results')
mkdirSync(out, { recursive: true })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a)

const env = { ...process.env, VALENCE_MUTE: '1', VALENCE_HASH: 'e2e' }
delete env.ELECTRON_RUN_AS_NODE
const app = await electron.launch({ args: [join(root, 'out/main/index.js')], cwd: root, env })
const errors = []
let summary = null
try {
  const win = await app.firstWindow()
  win.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
  win.on('pageerror', (e) => errors.push(e.message))
  await win.waitForSelector('.app', { timeout: 30000 })
  const before = await win.evaluate(() => window.valence.invoke('library:stats'))
  log('library before', JSON.stringify(before))
  const ids = await win.evaluate((p) => window.valence.invoke('import:importPaths', p), folders)
  log(`queued ${Array.isArray(ids) ? ids.length : JSON.stringify(ids)} jobs`)
  const t0 = Date.now()
  let quietSince = 0
  let last = ''
  for (;;) {
    await sleep(5000)
    const jobs = await win.evaluate(() => window.valence.invoke('import:jobs'))
    const by = {}
    for (const j of jobs) by[j.status] = (by[j.status] ?? 0) + 1
    const line = JSON.stringify(by)
    const running = jobs.filter((j) => j.status === 'running')
    if (line !== last) {
      log(line, running.map((j) => `${j.title} [${j.stage} ${Math.round(j.progress * 100)}%]`).join(' | ').slice(0, 200))
      last = line
    }
    const busy = (by.queued ?? 0) + (by.running ?? 0)
    if (!busy) {
      quietSince ||= Date.now()
      if (Date.now() - quietSince > 15000) break
    } else quietSince = 0
    if (Date.now() - t0 > 3 * 3600_000) {
      log('giving up after 3 h')
      break
    }
  }
  const jobs = await win.evaluate(() => window.valence.invoke('import:jobs'))
  const reports = await win.evaluate(() => window.valence.invoke('import:reports'))
  const after = await win.evaluate(() => window.valence.invoke('library:stats'))
  const archive = await win.evaluate(() => window.valence.invoke('import:archiveStatus'))
  summary = {
    finishedAt: new Date().toISOString(),
    minutes: Math.round((Date.now() - t0) / 6000) / 10,
    folders,
    before,
    after,
    archive,
    byStatus: jobs.reduce((m, j) => ((m[j.status] = (m[j.status] ?? 0) + 1), m), {}),
    review: jobs.filter((j) => j.status === 'review').map((j) => ({ title: j.title, score: j.review?.score, kind: j.review?.status, top: j.review?.candidates?.[0] && `${j.review.candidates[0].artist} — ${j.review.candidates[0].title}` })),
    failed: jobs.filter((j) => j.status === 'failed').map((j) => ({ title: j.title, error: j.error })),
    reports: (Array.isArray(reports) ? reports : []).slice(0, 50).map((r) => ({ title: r.title, summary: r.summary })),
    consoleErrors: errors,
  }
  log('library after', JSON.stringify(after))
  for (const [name, route] of [
    ['albums', { view: 'albums' }],
    ['artists', { view: 'artists' }],
    ['songs', { view: 'songs' }],
    ['import', { view: 'import', tab: 'reports' }],
    ['review', { view: 'import', tab: 'review' }],
  ]) {
    await win.evaluate((r) => window.__valence.navigate(r), route)
    await sleep(1200)
    await win.screenshot({ path: join(out, `real-${name}.png`) })
  }
} finally {
  await app.close().catch(() => {})
}
writeFileSync(join(out, 'real-import.json'), JSON.stringify(summary, null, 2))
log('summary', JSON.stringify(summary?.byStatus), `errors=${errors.length}`)
