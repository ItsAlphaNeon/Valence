// UI e2e: builds, generates a small sandbox library (tagged MP3s with art and synced lyrics),
// launches Valence against it (VALENCE_MUTE=1) and checks:
//   - every view renders with zero console errors, screenshots in light + dark and per palette
//   - playback starts from the UI and the position advances
//   - lyrics highlight follows the position
//   - the mini player mirrors the main player and controls it
//   node scripts/e2e-ui.mjs [--no-build] [--keep] [--views-only]
// Screenshots land in test-results/ui/. Run from PowerShell.

import { _electron as electron } from 'playwright'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const argv = new Set(process.argv.slice(2))
const root = resolve(import.meta.dirname, '..')
const require = createRequire(import.meta.url)
const ffmpeg = process.env.VALENCE_FFMPEG || require('ffmpeg-static')
const taglib = require('node-taglib-sharp')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const shots = join(root, 'test-results', 'ui')
const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(40)} ${detail}`)
}

function build() {
  const r = spawnSync(process.execPath, [join(root, 'node_modules/electron-vite/bin/electron-vite.js'), 'build'], { cwd: root, encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`build failed:\n${(r.stderr || r.stdout).split('\n').slice(-25).join('\n')}`)
}

function ff(args) {
  const r = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`ffmpeg ${args.join(' ')}\n${r.stderr}`)
}

// Placeholder lyrics (no real song text): one line every 2 s.
const lrc = (n) => Array.from({ length: n }, (_, i) => `[00:${String(i * 2).padStart(2, '0')}.00]Line ${i + 1} of the test lyrics`).join('\n')

const ALBUMS = [
  { artist: 'Test Artist', album: 'Aurora Lines', year: 2021, genre: 'Electronic', color: '0x3a7bd5', tracks: ['Opening', 'Second Light', 'Paper Moons', 'Coda'], lyrics: true },
  { artist: 'Other Artist', album: 'Night Signals', year: 2019, genre: 'Rock', color: '0xd53a6b', tracks: ['Static', 'Relay', 'Beacon', 'Afterglow'], discs: 2 },
  { artist: 'Third Voice', album: 'Lone Single', year: 2024, genre: 'Pop', color: '0x2fbf71', tracks: ['Lone Single'] },
]

function genLibrary(lib) {
  const tmp = join(lib, '..', 'gen')
  mkdirSync(tmp, { recursive: true })
  let n = 0
  for (const a of ALBUMS) {
    const dir = join(lib, a.artist, `${a.album} (${a.year})`)
    mkdirSync(dir, { recursive: true })
    const cover = join(tmp, `${n}.jpg`)
    ff(['-f', 'lavfi', '-i', `color=c=${a.color}:s=600x600,drawbox=x=150:y=150:w=300:h=300:color=white@0.35:t=fill`, '-frames:v', '1', cover])
    a.tracks.forEach((title, i) => {
      const out = join(dir, `${title}.mp3`)
      const freq = 220 + 55 * ++n
      ff(['-f', 'lavfi', '-i', `sine=frequency=${freq}:duration=24`, '-ac', '2', '-c:a', 'libmp3lame', '-b:a', '128k', out])
      const f = taglib.File.createFromPath(out)
      const t = f.getTag(taglib.TagTypes.Id3v2, true)
      t.title = title
      t.performers = [a.artist]
      t.albumArtists = [a.artist]
      t.album = a.album
      t.year = a.year
      t.genres = [a.genre]
      const perDisc = a.discs ? Math.ceil(a.tracks.length / a.discs) : a.tracks.length
      t.track = a.discs ? (i % perDisc) + 1 : i + 1
      t.trackCount = perDisc
      if (a.discs) {
        t.disc = Math.floor(i / perDisc) + 1
        t.discCount = a.discs
      }
      if (a.lyrics) t.lyrics = lrc(12)
      t.pictures = [taglib.Picture.fromPath(cover)]
      f.save()
      f.dispose()
    })
  }
  rmSync(tmp, { recursive: true, force: true })
}

if (!argv.has('--no-build')) build()
mkdirSync(shots, { recursive: true })
const sandbox = mkdtempSync(join(tmpdir(), 'valence-ui-'))
const lib = join(sandbox, 'Music')
genLibrary(lib)

const env = {
  ...process.env,
  VALENCE_LIBRARY_ROOT: lib,
  VALENCE_DATA_DIR: join(sandbox, 'data'),
  VALENCE_INBOX: join(sandbox, 'Inbox'),
  VALENCE_ARCHIVE_DIR: join(sandbox, 'Archive'),
  VALENCE_MUTE: '1',
  VALENCE_HASH: 'e2e',
}
delete env.ELECTRON_RUN_AS_NODE
const app = await electron.launch({ args: [join(root, 'out/main/index.js')], cwd: root, env })
const errors = []
const watch = (page, label) => {
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`${label}: ${m.text()}`)
  })
  page.on('pageerror', (e) => errors.push(`${label}: ${e.message}`))
}

try {
  const win = await app.firstWindow()
  watch(win, 'main')
  await win.waitForSelector('.app', { timeout: 20000 })
  await win.setViewportSize({ width: 1360, height: 860 }).catch(() => {})
  // Wait for the scan to index the sandbox.
  let stats = null
  for (let i = 0; i < 60; i++) {
    stats = await win.evaluate(() => window.valence.invoke('library:stats'))
    if (stats?.tracks >= 9 && !stats?.scanning) break
    await sleep(500)
  }
  check('scan indexed sandbox', stats?.tracks === 9, JSON.stringify(stats))

  const go = (route) => win.evaluate((r) => window.__valence.navigate(r), route)
  const albums = await win.evaluate(() => window.valence.invoke('library:albums', {}))
  const albumList = Array.isArray(albums) ? albums : (albums?.rows ?? [])
  const multi = albumList.find((a) => a.title === 'Night Signals')

  const ROUTES = [
    ['home', { view: 'home' }],
    ['albums', { view: 'albums' }],
    ['songs', { view: 'songs' }],
    ['artists', { view: 'artists' }],
    ['artist', { view: 'artist', artist: 'Test Artist' }],
    ['genres', { view: 'genres' }],
    ['genre', { view: 'genre', genre: 'Rock' }],
    ['recent', { view: 'recent' }],
    ['liked', { view: 'liked' }],
    ['liked-albums', { view: 'liked', tab: 'albums' }],
    ['stats', { view: 'stats' }],
    ['album-multidisc', multi ? { view: 'album', id: multi.id } : { view: 'albums' }],
    ['search', { view: 'search', q: 'light' }],
    ['smart-editor', { view: 'smart' }],
    ['nowplaying-empty', { view: 'nowplaying' }],
    ['settings', { view: 'settings' }],
    ['settings-appearance', { view: 'settings', section: 'appearance' }],
    ['settings-playback', { view: 'settings', section: 'playback' }],
    ['import', { view: 'import' }],
    ['tidal', { view: 'tidal' }],
    ['bandcamp', { view: 'bandcamp' }],
  ]

  // Playwright pins prefers-color-scheme per page, so emulate it too (nativeTheme drives the title bar).
  const scheme = async (s) => {
    await app.evaluate(({ nativeTheme }, s) => (nativeTheme.themeSource = s), s)
    await win.emulateMedia({ colorScheme: s === 'system' ? null : s })
  }
  for (const s of ['light', 'dark']) {
    await scheme(s)
    // The default palette is Dark regardless of the OS, so pick the matching palette as well.
    await win.evaluate((s) => window.valence.invoke('settings:set', 'ui.theme', s), s)
    await sleep(300)
    const got = await win.evaluate(() => document.documentElement.dataset.scheme)
    check(`${s}: palette applied`, got === s, `html[data-scheme]=${got}`)
    for (const [name, route] of ROUTES) {
      const before = errors.length
      await go(route)
      await sleep(name.startsWith('settings') || name === 'tidal' || name === 'bandcamp' || name === 'stats' ? 900 : 500)
      const empty = await win.evaluate(() => !document.querySelector('.content')?.children.length)
      await win.screenshot({ path: join(shots, `${s}-${name}.png`) })
      check(`${s}: ${name}`, errors.length === before && !empty, errors.slice(before).join(' | ').slice(0, 300))
    }
  }

  // Palettes (home view), then the density and album-art color options.
  const setting = (k, v) => win.evaluate(([k, v]) => window.valence.invoke('settings:set', k, v), [k, v])
  const dataset = () => win.evaluate(() => ({ ...document.documentElement.dataset }))
  await scheme('system')
  for (const id of ['midnight', 'ember', 'oled', 'paper']) {
    await setting('ui.theme', id)
    await go({ view: 'home' })
    await sleep(500)
    const d = await dataset()
    await win.screenshot({ path: join(shots, `palette-${id}.png`) })
    check(`palette ${id}`, d.theme === id, `html[data-theme]=${d.theme}`)
  }
  await setting('ui.theme', 'dark')
  await setting('ui.density', 'compact')
  await go({ view: 'songs' })
  await sleep(500)
  check('density compact', (await dataset()).density === 'compact')
  await win.screenshot({ path: join(shots, 'songs-compact.png') })
  await setting('ui.density', 'comfortable')
  for (const mode of ['off', 'full']) {
    await setting('ui.artTheme', mode)
    await sleep(300)
    check(`album art colors ${mode}`, (await dataset()).art === mode, `html[data-art]=${(await dataset()).art}`)
  }
  await setting('ui.artTheme', 'accent')

  // User themes: the example file loads, applies its tokens, and edits hot-reload through the watcher.
  {
    const cssVar = (name) => win.evaluate((n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim(), name)
    const until = async (fn, ms = 8000) => {
      const t0 = Date.now()
      for (;;) {
        const v = await fn()
        if (v || Date.now() - t0 > ms) return v
        await sleep(250)
      }
    }
    const file = await win.evaluate(() => window.valence.invoke('settings:themeExample'))
    const listed = await until(async () => (await win.evaluate(() => window.valence.invoke('settings:themes'))).themes.some((t) => t.id === 'user:example'))
    check('user theme: example file listed', listed, file)
    await win.evaluate(() => window.valence.invoke('settings:set', 'ui.theme', 'user:example'))
    const applied = await until(async () => (await cssVar('--r-lg')) === '14px')
    check('user theme: tokens applied', applied, `--r-lg=${await cssVar('--r-lg')}`)
    await go({ view: 'settings', section: 'appearance' })
    await sleep(700)
    await win.screenshot({ path: join(shots, 'settings-appearance-user-theme.png') })
    const json = JSON.parse(readFileSync(file, 'utf8'))
    writeFileSync(file, JSON.stringify({ ...json, tokens: { ...json.tokens, 'r-lg': '7px' } }, null, 2))
    const reloaded = await until(async () => (await cssVar('--r-lg')) === '7px', 12000)
    check('user theme: edit hot-reloads', reloaded, `--r-lg=${await cssVar('--r-lg')}`)
    await win.evaluate(() => window.valence.invoke('settings:set', 'ui.theme', 'dark'))
    await sleep(300)
  }

  // Get Info → MusicBrainz tab renders (the lookup itself needs the network, so it isn't clicked).
  {
    const first = albumList[0]
    const detail = await win.evaluate((id) => window.valence.invoke('library:album', id), first.id)
    await win.evaluate((id) => window.__valence.ui.getState().openGetInfo([id]), detail.tracks[0].id)
    await win.waitForSelector('.modal .segmented-opt', { timeout: 5000 })
    const gap = await win.evaluate(() => {
      const actions = document.querySelector('.modal .gi-art-actions')?.getBoundingClientRect()
      const tabs = document.querySelector('.modal .segmented')?.getBoundingClientRect()
      return actions && tabs ? Math.round(tabs.top - actions.bottom) : null
    })
    check('get info: art buttons clear the tabs', gap != null && gap >= 0, `gap ${gap}px`)
    await win.locator('.modal .segmented-opt', { hasText: 'MusicBrainz' }).click()
    const ok = await win.waitForSelector('.gi-mb', { timeout: 3000 }).then(() => true, () => false)
    await win.screenshot({ path: join(shots, 'getinfo-musicbrainz.png') })
    check('get info: MusicBrainz tab', ok)
    await win.keyboard.press('Escape')
    await sleep(300)
  }

  if (!argv.has('--views-only')) {
    // Playback from the UI: open the lyrics album, double-click the first row.
    const aurora = albumList.find((a) => a.title === 'Aurora Lines')
    await go({ view: 'album', id: aurora.id })
    await win.waitForSelector('.tt-row:not(.placeholder)', { timeout: 5000 })
    await win.locator('.tt-row:not(.placeholder)').first().dblclick()
    let st = null
    for (let i = 0; i < 20; i++) {
      await sleep(250)
      st = await win.evaluate(() => window.valence.invoke('player:getState'))
      if (st?.playing && st.positionMs > 300) break
    }
    check('playback starts from track table', st?.playing && st.current?.title === 'Opening', `${st?.current?.title} @ ${st?.positionMs} ms`)
    await sleep(1500)
    const st2 = await win.evaluate(() => window.valence.invoke('player:getState'))
    check('position advances', st2.positionMs > st.positionMs + 800, `${st.positionMs} → ${st2.positionMs}`)

    // Lyrics: drawer + now playing view should highlight the line for the current position.
    await win.keyboard.press('Control+L')
    await win.waitForSelector('.rightpanel.open .lyric-line', { timeout: 5000 })
    const line1 = await win.locator('.rightpanel .lyric-line.on').textContent().catch(() => null)
    await sleep(2300)
    const line2 = await win.locator('.rightpanel .lyric-line.on').textContent().catch(() => null)
    check('lyrics highlight follows position', !!line1 && !!line2 && line1 !== line2, `${line1} → ${line2}`)
    await win.screenshot({ path: join(shots, 'lyrics-drawer.png') })
    // Favorites: Alt+Shift+B likes the playing song; it shows up in Liked Songs.
    const playingId = (await win.evaluate((id) => window.valence.invoke('library:album', id), aurora.id)).tracks.find((t) => t.title === 'Opening')?.id
    await win.keyboard.press('Alt+Shift+B')
    let liked = null
    for (let i = 0; i < 12 && !liked?.liked; i++) {
      await sleep(250)
      liked = await win.evaluate((id) => window.valence.invoke('library:track', id), playingId)
    }
    check('like current song (Alt+Shift+B)', liked?.liked === true, `liked=${liked?.liked}`)
    await go({ view: 'liked' })
    await sleep(700)
    const likedRows = await win.locator('.tt-row:not(.placeholder)').count()
    check('liked songs lists it', likedRows === 1, `${likedRows} rows`)
    await win.screenshot({ path: join(shots, 'liked-one.png') })
    await go({ view: 'nowplaying' })
    await sleep(700)
    await win.screenshot({ path: join(shots, 'nowplaying.png') })
    await win.keyboard.press('Control+U')
    await sleep(500)
    await win.screenshot({ path: join(shots, 'queue-drawer.png') })

    // Mini player mirrors and controls the main engine.
    const miniP = app.waitForEvent('window', { timeout: 10000 })
    await win.evaluate(() => window.valence.send('mini:toggle'))
    const mini = await miniP
    watch(mini, 'mini')
    await mini.waitForSelector('.mini-title', { timeout: 10000 })
    await sleep(800)
    const miniTitle = await mini.locator('.mini-title').textContent()
    check('mini shows current track', miniTitle === 'Opening', miniTitle)
    await mini.screenshot({ path: join(shots, 'mini.png') })
    await mini.locator('.mini-play').click()
    await sleep(700)
    const paused = await win.evaluate(() => window.valence.invoke('player:getState'))
    check('mini pause controls main engine', paused.playing === false, `playing=${paused.playing}`)
    await mini.locator('.mini-controls .icon-btn[title="Next"]').click()
    await sleep(1200)
    const nxt = await win.evaluate(() => window.valence.invoke('player:getState'))
    check('mini next controls main engine', nxt.current?.title === 'Second Light', nxt.current?.title)
    await mini.screenshot({ path: join(shots, 'mini-next.png') })
    await win.evaluate(() => window.valence.send('mini:close'))
    await sleep(500)
    const open = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)
    check('mini closes', open === 1, `${open} windows`)
  }

  if (!argv.has('--no-perf')) {
    // 50k synthetic rows, inserted behind the running app (WAL), then a scripted scroll.
    const seed = join(sandbox, 'seed.cjs')
    writeFileSync(
      seed,
      `const Database = require(${JSON.stringify(require.resolve('better-sqlite3'))})
const db = new Database(process.argv[2]); db.pragma('busy_timeout = 10000')
const ins = db.prepare("INSERT INTO tracks (rel_path, path_key, size, mtime_ms, duration_ms, bitrate, sample_rate, title, artist, album, album_artist, track_no, year, genre, codec, added_at, scanned_at) VALUES (?, ?, 1, 0, ?, 320000, 44100, ?, ?, ?, ?, ?, ?, ?, 'mp3', ?, ?)")
const now = Date.now()
db.transaction(() => { for (let i = 0; i < 50000; i++) { const a = 'Synthetic Artist ' + (i % 700), al = 'Synthetic Album ' + Math.floor(i / 12); ins.run('zz-synth/' + i + '.mp3', 'zz-synth/' + i + '.mp3', 180000 + (i % 90) * 1000, 'Synthetic Track ' + i, a, al, a, (i % 12) + 1, 1990 + (i % 35), 'Genre ' + (i % 40), now - i * 1000, now) } })()
db.close()`,
    )
    const r = spawnSync(require('electron'), [seed, join(sandbox, 'data', 'valence.db')], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8' })
    check('seed 50k synthetic rows', r.status === 0, (r.stderr || '').slice(0, 300))
    await go({ view: 'albums' })
    await sleep(300)
    await go({ view: 'songs' })
    await win.waitForSelector('.tt-row:not(.placeholder)', { timeout: 10000 })
    await sleep(800)
    const perf = await win.evaluate(
      () =>
        new Promise((done) => {
          const el = document.querySelector('.content')
          const deltas = []
          let last = performance.now()
          const t0 = last
          const step = () => {
            const now = performance.now()
            deltas.push(now - last)
            last = now
            el.scrollTop += 240
            if (now - t0 < 3000) requestAnimationFrame(step)
            else {
              deltas.sort((a, b) => a - b)
              done({ frames: deltas.length, p50: deltas[Math.floor(deltas.length * 0.5)], p90: deltas[Math.floor(deltas.length * 0.9)], scrollTop: el.scrollTop, height: el.scrollHeight })
            }
          }
          requestAnimationFrame(step)
        }),
    )
    await win.screenshot({ path: join(shots, 'songs-50k.png') })
    const total = await win.evaluate(() => window.valence.invoke('library:stats'))
    check('50k songs scroll smoothly', perf.p90 < 34 && perf.height > 50000 * 30, `${total.tracks} tracks, ${perf.frames} frames, p50 ${perf.p50.toFixed(1)} ms, p90 ${perf.p90.toFixed(1)} ms`)
  }

  check('no console errors overall', errors.length === 0, errors.slice(0, 5).join(' | ').slice(0, 600))
} catch (e) {
  check('run', false, e?.stack ?? String(e))
} finally {
  await app.close().catch(() => {})
  if (!argv.has('--keep')) rmSync(sandbox, { recursive: true, force: true })
  else console.log(`sandbox kept at ${sandbox}`)
}

writeFileSync(join(shots, 'results.json'), JSON.stringify(results, null, 2))
const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length ? 1 : 0)
