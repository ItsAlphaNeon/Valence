// Playback e2e: builds, launches Electron on #engine-lab (VALENCE_MUTE=1, so nothing is audible),
// plays contiguous sine segments and checks gapless continuity, position, seek accuracy and SMTC.
//   node scripts/e2e-playback.mjs [--no-build] [--spike] [--keep] [--verbose]
// Run from PowerShell (the Bash sandbox breaks some Windows APIs inside Electron).

import { _electron as electron } from 'playwright'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'

const argv = new Set(process.argv.slice(2))
const root = resolve(import.meta.dirname, '..')
const require = createRequire(import.meta.url)
const ffmpeg = process.env.VALENCE_FFMPEG || require('ffmpeg-static')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(34)} ${detail}`)
}
const info = (name, detail) => {
  results.push({ name, ok: true, info: true, detail })
  console.log(`INFO  ${name.padEnd(34)} ${detail}`)
}

function build() {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const r = spawnSync(process.execPath, [join(root, 'node_modules/electron-vite/bin/electron-vite.js'), 'build'], { cwd: root, encoding: 'utf8' })
    if (r.status === 0) return
    console.warn(`build attempt ${attempt} failed:\n${(r.stderr || r.stdout).split('\n').slice(-15).join('\n')}`)
  }
  throw new Error('build failed')
}

function ff(args) {
  const r = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`ffmpeg ${args.join(' ')}\n${r.stderr}`)
}

function genSegments(dir, rate, codec, ext, bounds, seconds) {
  const e = '0.5*sin(2*PI*440*t)'
  const src = `aevalsrc=${e}|${e}:s=${rate}:d=${seconds}`
  const files = []
  for (let i = 0; i < bounds.length - 1; i++) {
    const out = join(dir, `seg${i + 1}.${ext}`)
    ff(['-f', 'lavfi', '-i', src, '-af', `atrim=start_sample=${bounds[i]}:end_sample=${bounds[i + 1]},asetpts=PTS-STARTPTS`, ...codec, out])
    files.push(out)
  }
  return files
}

function analyze(x, rate, totalFrames, bounds) {
  // capture is exact silence outside playback, so the first/last non-zero samples bound the signal
  const thr = 1e-6
  let first = -1
  let last = -1
  for (let i = 0; i < x.length; i++) if (Math.abs(x[i]) > thr) { first = i; break }
  for (let i = x.length - 1; i >= 0; i--) if (Math.abs(x[i]) > thr) { last = i; break }
  if (first < 0) return { ok: false, reason: 'no signal' }
  let zeroRuns = 0
  let run = 0
  for (let i = first; i <= last; i++) {
    if (Math.abs(x[i]) < 1e-4) {
      if (++run === 32) zeroRuns++
    } else run = 0
  }
  const from = first + Math.round(rate * 0.015)
  let maxD = 0
  let maxAt = -1
  let peak = 0
  for (let i = from; i <= last; i++) peak = Math.max(peak, Math.abs(x[i]))
  for (let i = from + 1; i <= last; i++) {
    const d = Math.abs(x[i] - x[i - 1])
    if (d > maxD) {
      maxD = d
      maxAt = i
    }
  }
  // the signal ends at file sample totalFrames-1; align on the end to locate the joins
  const start0 = last - (totalFrames - 1)
  const joins = bounds.slice(1, -1).map((b) => {
    let m = 0
    for (let i = start0 + b - 200; i < start0 + b + 200; i++) if (i > from && i <= last) m = Math.max(m, Math.abs(x[i] - x[i - 1]))
    return m
  })
  return { first, last, lengthFrames: last - first + 1, zeroRuns, maxD, maxAtSec: (maxAt - start0) / rate, joins, peak }
}

// Reference: each file decoded offline by the same ffmpeg invocation as the decode host, concatenated (left channel).
function offlineDecode(files, rate) {
  const parts = files.map((p) => {
    const r = spawnSync(ffmpeg, ['-nostdin', '-loglevel', 'error', '-i', p, '-map', '0:a:0', '-vn', '-f', 'f32le', '-ac', '2', '-ar', String(rate), '-'], { maxBuffer: 1 << 28 })
    if (r.status !== 0) throw new Error(`offline decode failed: ${r.stderr}`)
    const f = new Float32Array(r.stdout.buffer.slice(r.stdout.byteOffset, r.stdout.byteOffset + r.stdout.byteLength))
    const l = new Float32Array(f.length / 2)
    for (let i = 0; i < l.length; i++) l[i] = f[i * 2]
    return l
  })
  const out = new Float32Array(parts.reduce((s, p) => s + p.length, 0))
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}

// Max |capture - reference| after the 10 ms start ramp, end-aligned (no ramp at queue end), best of +-4 frames.
function matchOffline(x, ref, a, rate) {
  let refLast = ref.length - 1
  while (refLast > 0 && Math.abs(ref[refLast]) <= 1e-6) refLast--
  let best = { diff: Infinity, shift: 0 }
  for (let s = -4; s <= 4; s++) {
    const off = a.last - refLast + s
    let d = 0
    for (let i = a.first + Math.round(rate * 0.015); i <= a.last; i++) {
      const j = i - off
      d = Math.max(d, Math.abs(x[i] - (j >= 0 && j < ref.length ? ref[j] : 0)))
    }
    if (d < best.diff) best = { diff: d, shift: s }
  }
  return best
}

async function decodeCapture(page) {
  const b64 = await page.evaluate(() => window.__lab.captureStopBase64())
  const buf = Buffer.from(b64, 'base64')
  return new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength))
}

async function waitEvent(page, type, timeoutMs) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    if (await page.evaluate((t) => window.__lab.events.some((e) => e.type === t), type)) return true
    await sleep(100)
  }
  return false
}

async function playAndCapture(page, files, titles) {
  await page.evaluate(() => {
    window.__lab.events.length = 0
    window.__lab.captureStart()
  })
  await page.evaluate(([paths, titles]) => window.__lab.loadPaths(paths, { titles, albumKey: 'e2e' }), [files, titles])
  const samples = []
  const t0 = Date.now()
  let ended = false
  while (Date.now() - t0 < 20000) {
    const s = await page.evaluate(() => {
      const st = window.__lab.state()
      return { id: st.current?.id ?? null, pos: st.positionMs, playing: st.playing, buffering: st.buffering, frames: window.__lab.framesRendered() }
    })
    samples.push({ t: Date.now() - t0, ...s })
    if (await page.evaluate(() => window.__lab.events.some((e) => e.type === 'ended'))) {
      ended = true
      break
    }
    await sleep(200)
  }
  await sleep(150)
  const x = await decodeCapture(page)
  const events = await page.evaluate(() => window.__lab.events)
  return { x, samples, ended, events }
}

function positionAdvance(samples) {
  // longest stretch on one track while playing: compare position delta with wall time
  let best = null
  for (let i = 0; i < samples.length; i++) {
    for (let j = samples.length - 1; j > i; j--) {
      const a = samples[i]
      const b = samples[j]
      if (a.id !== b.id || !a.playing || !b.playing || a.pos <= 0 || b.t - a.t < 800) continue
      const r = { wall: b.t - a.t, pos: b.pos - a.pos }
      if (!best || r.wall > best.wall) best = r
      break
    }
  }
  return best
}

function smtc(title) {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(root, 'scripts', 'verify-smtc.ps1')], { encoding: 'utf8' })
  let sessions = []
  try {
    sessions = JSON.parse(r.stdout.trim() || '[]')
  } catch {
    sessions = []
  }
  return { found: sessions.find((s) => s.title === title) ?? null, sessions, err: r.stderr?.trim() }
}

async function smtcCheck(page, file, title, tries = 6) {
  await page.evaluate(([p, t]) => {
    window.__lab.command({ type: 'setRepeat', repeat: 'one' })
    window.__lab.loadPaths([p], { titles: [t], albumKey: null })
  }, [file, title])
  await sleep(1500)
  let res = null
  for (let i = 0; i < tries; i++) {
    res = smtc(title)
    if (res.found) break
    await sleep(1000)
  }
  await page.evaluate(() => {
    window.__lab.command({ type: 'stop' })
    window.__lab.command({ type: 'setRepeat', repeat: 'off' })
  })
  return res
}

async function main() {
  if (!argv.has('--no-build')) build()
  mkdirSync(join(root, '.sandbox'), { recursive: true })
  const sb = mkdtempSync(join(root, '.sandbox', 'e2e-playback-'))
  const lib = join(sb, 'lib')
  const data = join(sb, 'data')
  mkdirSync(lib, { recursive: true })
  mkdirSync(data, { recursive: true })
  const env = { ...process.env, VALENCE_HASH: 'engine-lab', VALENCE_MUTE: '1', VALENCE_DATA_DIR: data, VALENCE_LIBRARY_ROOT: lib }
  delete env.ELECTRON_RUN_AS_NODE
  const app = await electron.launch({ args: ['.'], cwd: root, env })
  const logs = []
  app.process().stdout?.on('data', (d) => argv.has('--verbose') && process.stdout.write(`[main] ${d}`))
  app.process().stderr?.on('data', (d) => logs.push(String(d)))
  try {
    const page = await app.firstWindow()
    page.on('console', (m) => (m.type() === 'error' || argv.has('--verbose')) && console.log(`[renderer:${m.type()}] ${m.text()}`))
    page.on('pageerror', (e) => console.log(`[renderer:pageerror] ${e.message}`))
    await page.waitForFunction(() => window.__lab?.ready === true, null, { timeout: 30000 })
    const labInfo = await page.evaluate(() => window.__lab.info())
    info('lab', JSON.stringify(labInfo))
    check('mute forced (VALENCE_MUTE=1)', labInfo.mute === true)
    const devs = await page.evaluate(() => navigator.mediaDevices.enumerateDevices().then((ds) => ds.filter((d) => d.kind === 'audiooutput').map((d) => ({ id: d.deviceId.slice(0, 8), label: d.label }))))
    info('output devices', `${devs.length} found, ${devs.filter((d) => d.label).length} labelled: ${devs.map((d) => d.label || d.id).join(' | ')}`)
    const rate = labInfo.sampleRate
    const N = 9 * rate
    const bounds = [0, Math.round(2.9 * rate) + 37, Math.round(6.1 * rate) + 91, N]

    // --- FLAC gapless --------------------------------------------------------------------------
    const flacDir = join(lib, 'flac')
    mkdirSync(flacDir, { recursive: true })
    const flac = genSegments(flacDir, rate, ['-c:a', 'flac', '-sample_fmt', 's16'], 'flac', bounds, 9)
    const t1 = await playAndCapture(page, flac, ['Seg 1', 'Seg 2', 'Seg 3'])
    const a1 = analyze(t1.x, rate, N, bounds)
    check('flac: played to end', t1.ended, `${t1.events.filter((e) => e.type === 'track').length} tracks`)
    check('flac: no silence runs >= 32 samples', a1.zeroRuns === 0, `runs=${a1.zeroRuns}`)
    // slope bound from the measured amplitude (any discontinuity at a join would exceed it)
    const s1 = 2 * Math.PI * 440 * (a1.peak ?? 0.5) / rate
    check('flac: continuous at joins', a1.maxD <= s1 * 1.01 + 1e-4, `max|dx|=${a1.maxD?.toFixed(5)} (sine slope ${s1.toFixed(5)}, peak ${a1.peak?.toFixed(4)}) joins=${a1.joins?.map((j) => j.toFixed(5)).join(',')}`)
    check('flac: total length exact', Math.abs(a1.lengthFrames - N) <= 2, `${a1.lengthFrames} vs ${N} frames`)
    const m1 = matchOffline(t1.x, offlineDecode(flac, rate), a1, rate)
    check('flac: sample-exact vs offline decode', m1.diff < 1e-6, `max diff ${m1.diff.toExponential(2)} (shift ${m1.shift})`)
    const adv = positionAdvance(t1.samples)
    check('position advances', adv && Math.abs(adv.pos - adv.wall) < 0.15 * adv.wall, adv ? `${adv.pos} ms over ${adv.wall} ms wall` : 'no samples')
    const fr = t1.samples.at(-1)?.frames ?? 0
    check('frames rendered', fr >= N - rate * 0.1, `${fr}`)

    // --- MP3 gapless (encoder delay/padding via LAME tag) -----------------------------------------
    if ([32000, 44100, 48000].includes(rate)) {
      const mp3Dir = join(lib, 'mp3')
      mkdirSync(mp3Dir, { recursive: true })
      const mp3 = genSegments(mp3Dir, rate, ['-c:a', 'libmp3lame', '-b:a', '320k'], 'mp3', bounds, 9)
      const t2 = await playAndCapture(page, mp3, ['Mp3 1', 'Mp3 2', 'Mp3 3'])
      const a2 = analyze(t2.x, rate, N, bounds)
      check('mp3: played to end', t2.ended)
      check('mp3: no silence runs >= 32 samples', a2.zeroRuns === 0, `runs=${a2.zeroRuns}`)
      const m2 = matchOffline(t2.x, offlineDecode(mp3, rate), a2, rate)
      check('mp3: sample-exact vs offline decode', m2.diff < 1e-6, `max diff ${m2.diff.toExponential(2)} (shift ${m2.shift})`)
      info('mp3: join step (codec edge error)', `max|dx|=${a2.maxD?.toFixed(5)} at ${a2.maxAtSec?.toFixed(4)}s joins=${a2.joins?.map((j) => j.toFixed(5)).join(',')}`)
      check('mp3: total length', Math.abs(a2.lengthFrames - N) <= 1152, `${a2.lengthFrames} vs ${N} frames`)
    } else info('mp3', `skipped (context rate ${rate})`)

    // --- seek accuracy -----------------------------------------------------------------------------
    const rampFile = join(lib, 'ramp.flac')
    const rampExpr = '(0.05+0.04*t)*sin(2*PI*440*t)'
    const k = (a1.peak ?? 0.5) / 0.5
    ff(['-f', 'lavfi', '-i', `aevalsrc=${rampExpr}|${rampExpr}:s=${rate}:d=10`, '-c:a', 'flac', '-sample_fmt', 's16', rampFile])
    await page.evaluate((p) => {
      window.__lab.events.length = 0
      window.__lab.loadPaths([p], { titles: ['Ramp'], albumKey: null })
    }, rampFile)
    await page.waitForFunction(() => window.__lab.state().positionMs > 800, null, { timeout: 10000 })
    for (const target of [6000, 2500, 8200]) {
      await page.evaluate(() => window.__lab.captureStart())
      await sleep(100)
      await page.evaluate((t) => window.__lab.command({ type: 'seek', positionMs: t }), target)
      await sleep(700)
      const st = await page.evaluate(() => window.__lab.state())
      const x = await decodeCapture(page)
      let resume = -1
      let run = 0
      for (let i = 0; i < x.length; i++) {
        if (Math.abs(x[i]) < 1e-4) run++
        else {
          if (run >= 64) resume = i
          run = 0
        }
      }
      if (resume < 0) {
        check(`seek ${target} ms accuracy`, false, 'no restart gap found')
        continue
      }
      const w0 = resume + Math.round(rate * 0.015)
      const w1 = resume + Math.round(rate * 0.025)
      let peak = 0
      for (let i = w0; i < w1; i++) peak = Math.max(peak, Math.abs(x[i]))
      const tEst = ((peak / k - 0.05) / 0.04 - 0.024) * 1000
      check(`seek ${target} ms accuracy`, Math.abs(tEst - target) <= 50, `audio says ${tEst.toFixed(1)} ms (err ${(tEst - target).toFixed(1)} ms); reported pos ${st.positionMs} ms after 700 ms`)
    }
    await page.evaluate(() => window.__lab.command({ type: 'stop' }))

    // --- SMTC --------------------------------------------------------------------------------------
    const strategies = argv.has('--spike') ? ['destination', 'stream', 'anchor'] : [labInfo.strategy]
    for (const strategy of strategies) {
      if (strategy !== labInfo.strategy || argv.has('--spike')) await page.evaluate((s) => window.__lab.reset({ strategy: s }), strategy)
      const title = `Valence E2E ${strategy} ${Math.random().toString(36).slice(2, 7)}`
      const r = await smtcCheck(page, rampFile, title)
      const detail = r.found ? `${r.found.appId} status=${r.found.status} artist=${r.found.artist}` : `sessions=${JSON.stringify(r.sessions.map((s) => [s.appId, s.title, s.status]))} ${r.err ?? ''}`
      if (argv.has('--spike')) info(`smtc spike: ${strategy}`, `${r.found ? 'VISIBLE' : 'not visible'} ${detail}`)
      else check(`smtc session (${strategy})`, !!r.found, detail)
      await sleep(1500)
    }
    if (argv.has('--spike')) await page.evaluate((s) => window.__lab.reset({ strategy: s }), labInfo.strategy)

    // --- element fallback engine (informational) ----------------------------------------------------
    await page.evaluate(() => window.__lab.reset({ engine: 'element' }))
    const eInfo = await page.evaluate(() => window.__lab.info())
    const t3 = await playAndCapture(page, flac, ['El 1', 'El 2', 'El 3'])
    const a3 = analyze(t3.x, rate, N, bounds)
    check('element engine: plays all three', eInfo.engine === 'element' && t3.ended && a3.first >= 0, `ended=${t3.ended}`)
    info('element engine: joins', `silence runs=${a3.zeroRuns} max|dx|=${a3.maxD?.toFixed(4)} length=${a3.lengthFrames} vs ${N}`)
  } finally {
    await app.close().catch(() => {})
    if (!argv.has('--keep')) rmSync(sb, { recursive: true, force: true })
  }
  const failed = results.filter((r) => !r.ok)
  console.log(`\nSummary: ${results.filter((r) => r.ok && !r.info).length} passed, ${failed.length} failed`)
  if (failed.length && logs.length) console.log(`main stderr tail:\n${logs.join('').split('\n').slice(-20).join('\n')}`)
  process.exit(failed.length ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(2)
})
