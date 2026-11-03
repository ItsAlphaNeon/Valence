// Smoke test for the packaged Windows build (release/win-unpacked/Valence.exe):
//   1. bundled binaries are where the app looks for them (ffmpeg unpacked from asar, fpcalc in resources/bin);
//   2. a sandbox library: import one real sample end to end, then play it (muted) and watch the position advance;
//   3. the real ~/Music library opens and lists its albums (read-only: no playback, so no play/skip logs).
//   node scripts/smoke-packaged.mjs [sample.mp3]

import { _electron as electron } from 'playwright'
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const exe = join(root, 'release/win-unpacked/Valence.exe')
const out = join(root, 'test-results/packaged')
mkdirSync(out, { recursive: true })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(40)} ${detail}`)
}

const firstMp3 = (dir) => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) {
      const f = firstMp3(p)
      if (f) return f
    } else if (e.name.toLowerCase().endsWith('.mp3')) return p
  }
  return null
}

async function launch(extraEnv) {
  const env = { ...process.env, VALENCE_MUTE: '1', VALENCE_HASH: 'e2e', ...extraEnv }
  delete env.ELECTRON_RUN_AS_NODE
  const app = await electron.launch({ executablePath: exe, env })
  const win = await app.firstWindow()
  const errors = []
  win.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
  win.on('pageerror', (e) => errors.push(e.message))
  await win.waitForSelector('.app', { timeout: 30000 })
  return { app, win, errors }
}

check('packaged exe exists', existsSync(exe), exe)
const res = join(root, 'release/win-unpacked/resources')
const ffmpeg = join(res, 'app.asar.unpacked/node_modules/ffmpeg-static/ffmpeg.exe')
const fpcalc = join(res, 'bin/fpcalc.exe')
check('ffmpeg unpacked from asar', existsSync(ffmpeg))
let fpVersion = ''
try {
  fpVersion = execFileSync(fpcalc, ['-version'], { encoding: 'utf8' }).trim()
} catch {}
check('fpcalc runs', /fpcalc version/i.test(fpVersion), fpVersion)

// 2. Sandbox: import + play.
const sample = process.argv[2] ? resolve(process.argv[2]) : firstMp3(join(root, 'test-data/real/albums'))
const sb = mkdtempSync(join(tmpdir(), 'valence-pkg-'))
const src = join(sb, 'src')
mkdirSync(src, { recursive: true })
copyFileSync(sample, join(src, basename(sample)))
{
  const { app, win, errors } = await launch({
    VALENCE_LIBRARY_ROOT: join(sb, 'Music'),
    VALENCE_DATA_DIR: join(sb, 'data'),
    VALENCE_INBOX: join(sb, 'Inbox'),
    VALENCE_ARCHIVE_DIR: join(sb, 'Archive'),
  })
  try {
    await win.evaluate((p) => window.valence.invoke('import:importPaths', p), [src])
    let jobs = []
    for (let i = 0; i < 120; i++) {
      await sleep(1000)
      jobs = await win.evaluate(() => window.valence.invoke('import:jobs'))
      if (jobs.length && jobs.every((j) => !['queued', 'running'].includes(j.status))) break
    }
    const job = jobs[0]
    check('import one sample', ['done', 'review'].includes(job?.status), `${job?.title}: ${job?.status}${job?.error ? ` (${job.error})` : ''}`)
    if (job?.status === 'review') {
      await win.evaluate((id) => window.valence.invoke('import:resolveReview', id, { asIs: true }), job.id).catch(() => {})
      await sleep(5000)
    }
    const stats = await win.evaluate(() => window.valence.invoke('library:stats'))
    check('sandbox library indexed', stats.tracks >= 1, `${stats.tracks} track(s)`)

    await win.evaluate(() => window.__valence.navigate({ view: 'songs' }))
    await win.waitForSelector('.tt-row:not(.placeholder)', { timeout: 10000 })
    await win.locator('.tt-row:not(.placeholder)').first().dblclick()
    let st = null
    for (let i = 0; i < 40; i++) {
      await sleep(250)
      st = await win.evaluate(() => window.valence.invoke('player:getState'))
      if (st?.playing && st.positionMs > 300) break
    }
    check('playback starts', st?.playing, `${st?.current?.title} @ ${st?.positionMs} ms`)
    await sleep(1500)
    const st2 = await win.evaluate(() => window.valence.invoke('player:getState'))
    check('position advances', st2.positionMs > (st?.positionMs ?? 0) + 800, `${st?.positionMs} → ${st2.positionMs}`)
    await win.screenshot({ path: join(out, 'sandbox-playing.png') })
    check('sandbox: no console errors', !errors.length, errors.slice(0, 3).join(' | '))
  } finally {
    await app.close().catch(() => {})
  }
}
rmSync(sb, { recursive: true, force: true })

// 3. Real library, read-only.
{
  const { app, win, errors } = await launch({})
  try {
    let stats = null
    for (let i = 0; i < 30; i++) {
      stats = await win.evaluate(() => window.valence.invoke('library:stats'))
      if (stats.tracks && !stats.scanning) break
      await sleep(1000)
    }
    check('real library opens', stats?.tracks > 0, `${stats?.tracks} songs, ${stats?.albums} albums at ${stats?.libraryRoot}`)
    await win.evaluate(() => window.__valence.navigate({ view: 'albums' }))
    const tiles = await win.waitForSelector('.tile .tile-art', { timeout: 10000 }).then(() => true, () => false)
    await sleep(1500)
    await win.screenshot({ path: join(out, 'real-albums.png') })
    check('albums grid renders', tiles)
    check('real: no console errors', !errors.length, errors.slice(0, 3).join(' | '))
  } finally {
    await app.close().catch(() => {})
  }
}

const passed = results.filter((r) => r.ok).length
console.log(`\n${passed}/${results.length} passed`)
writeFileSync(join(out, 'results.json'), JSON.stringify(results, null, 2))
process.exit(passed === results.length ? 0 : 1)
