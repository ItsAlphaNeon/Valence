import { app, BrowserWindow, globalShortcut, nativeTheme, protocol } from 'electron'
import { join } from 'node:path'
import { configureDataDir, defaultInboxDir, defaultMusicDir } from './platform/paths'
import { loadDeviceId } from './platform/device'
import { createContext, ensureDirs } from './app-context'
import { createSettings } from './settings'
import { HlcClock } from './sync/hlc'
import { LibraryService } from './library/service'
import { ImportService } from './import/service'
import { registerSettingsIpc } from './settings-ipc'
import { ART_SCHEME } from './library/art'
import { initPortBroker } from './ipc'
import { registerAudio, registerAudioSchemes } from './audio'
import { registerTidal } from './sources/tidal'
import { registerBandcamp } from './sources/bandcamp'
import { registerHqrip } from './sources/hqrip'
import { onMessage } from './ipc'
import { closeMini, isMiniOpen, setMiniOnTop, toggleMini } from './windows/mini'
import { createTray, destroyTray, refreshTray } from './integrations/tray'
import { startDiscord } from './integrations/discord'
import { startMediaKeys } from './integrations/media-keys'
import appIcon from '../../resources/icons/icon-256.png?asset'
import type { AppContext, SettingsStore, ValenceEnv } from './context'

const SMOKE = process.argv.includes('--smoke')

app.setName('Valence')
const dataDir = configureDataDir()
if (process.platform === 'win32') app.setAppUserModelId('local.valence.app')
registerAudioSchemes()

function buildEnv(): ValenceEnv {
  const libraryRoot = process.env.VALENCE_LIBRARY_ROOT ?? defaultMusicDir()
  return {
    libraryRoot,
    dataDir,
    archiveDir: process.env.VALENCE_ARCHIVE_DIR ?? null,
    archivePendingDir: join(dataDir, 'archive-pending'),
    stagingDir: join(dataDir, 'staging'),
    artCacheDir: join(dataDir, 'cache', 'art'),
    inboxDir: defaultInboxDir(),
    deviceId: loadDeviceId(dataDir),
    appVersion: app.getVersion(),
  }
}

function rendererUrl(page: 'index' | 'mini'): { url?: string; file?: string; hash?: string } {
  const hash = page === 'index' ? process.env.VALENCE_HASH : undefined
  const dev = process.env.ELECTRON_RENDERER_URL
  if (dev) return { url: `${dev}/${page}.html${hash ? `#${hash}` : ''}` }
  return { file: join(import.meta.dirname, '../renderer', `${page}.html`), hash }
}

const overlay = () => ({ color: '#00000000', symbolColor: nativeTheme.shouldUseDarkColors ? '#f2f2f7' : '#1c1c1e', height: 52 })

function loadPage(win: BrowserWindow, page: 'index' | 'mini'): void {
  const r = rendererUrl(page)
  if (r.url) void win.loadURL(r.url)
  else void win.loadFile(r.file!, r.hash ? { hash: r.hash } : undefined)
}

let mainWin: BrowserWindow | null = null
let quitting = false

function createMainWindow(settings: SettingsStore): BrowserWindow {
  const glass = process.platform === 'win32' && !process.env.VALENCE_NO_MICA
  const win = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 940,
    minHeight: 600,
    title: 'Valence',
    show: false,
    ...(process.platform !== 'darwin' ? { icon: appIcon } : {}),
    titleBarStyle: 'hidden',
    ...(process.platform === 'darwin'
      ? { trafficLightPosition: { x: 18, y: 18 }, vibrancy: 'under-window' as const, visualEffectState: 'followWindow' as const, backgroundColor: '#00000000' }
      : { titleBarOverlay: overlay() }),
    ...(glass ? { backgroundMaterial: 'mica' as const, backgroundColor: '#00000000' } : { backgroundColor: nativeTheme.shouldUseDarkColors ? '#1c1c1e' : '#f2f2f7' }),
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.cjs'),
      sandbox: false,
      contextIsolation: true,
      backgroundThrottling: false,
    },
  })
  win.once('ready-to-show', () => win.show())
  const onTheme = () => {
    if (process.platform !== 'darwin' && !win.isDestroyed()) win.setTitleBarOverlay(overlay())
  }
  nativeTheme.on('updated', onTheme)
  win.on('closed', () => nativeTheme.off('updated', onTheme))
  // The audio engine lives in this window, so "closing" it to the tray (or, on macOS, the dock)
  // keeps the music going. Otherwise closing it quits, mini player included.
  win.on('close', (e) => {
    if (quitting) return
    if (process.platform === 'darwin' || settings.get('ui.closeToTray', false)) {
      e.preventDefault()
      win.hide()
    }
  })
  win.on('closed', () => {
    if (mainWin === win) mainWin = null
    if (process.platform !== 'darwin') {
      closeMini()
      app.quit()
    }
  })
  loadPage(win, 'index')
  mainWin = win
  return win
}

function showMain(settings: SettingsStore): void {
  const win = mainWin && !mainWin.isDestroyed() ? mainWin : createMainWindow(settings)
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

function registerWindowIpc(settings: SettingsStore): void {
  const toggle = () => {
    toggleMini(settings, (w) => loadPage(w, 'mini'))
    refreshTray()
  }
  onMessage('mini:toggle', toggle)
  onMessage('mini:close', () => {
    closeMini()
    refreshTray()
  })
  onMessage('app:showMain', () => showMain(settings))
  settings.onChange((k, v) => k === 'ui.mini.onTop' && setMiniOnTop(v !== false))
  globalShortcut.register('CommandOrControl+Alt+M', toggle)
  createTray({
    showMain: () => showMain(settings),
    toggleMini: toggle,
    isMiniOpen,
    quit: () => {
      quitting = true
      app.quit()
    },
  })
}

let ctx: AppContext | null = null
let library: LibraryService | null = null
let imports: ImportService | null = null
const stopIntegrations: Array<() => void> = []

if (SMOKE) {
  void app.whenReady().then(async () => {
    try {
      const { runSmoke } = await import('./smoke')
      await runSmoke()
    } catch (e) {
      console.error(e)
      app.exit(2)
    }
  })
} else {
  if (!app.requestSingleInstanceLock()) app.quit()
  void app.whenReady().then(async () => {
    const env = buildEnv()
    ensureDirs(env)
    const settings = createSettings(env.dataDir, env.libraryRoot, new HlcClock(env.deviceId))
    env.archiveDir = process.env.VALENCE_ARCHIVE_DIR ?? settings.get<string | null>('archive.dir', null)
    settings.onChange((k, v) => {
      if (k === 'archive.dir' && !process.env.VALENCE_ARCHIVE_DIR) env.archiveDir = (v as string | null) ?? null
    })
    ctx = createContext(env, settings)
    initPortBroker()
    registerSettingsIpc(ctx, settings)
    library = new LibraryService(ctx)
    ctx.library = library.lookup
    ctx.playlists = library.playlists
    imports = new ImportService(ctx, library)
    ctx.imports = imports.queue
    const lib = library
    protocol.handle(ART_SCHEME, (req) => lib.art.handle(req))
    registerAudio(ctx)
    registerTidal(ctx)
    registerBandcamp(ctx)
    const hqrip = registerHqrip(ctx)
    stopIntegrations.push(() => hqrip.stop())
    createMainWindow(settings)
    registerWindowIpc(settings)
    const coverQuery = lib.db.prepare('SELECT mb_release_id FROM tracks WHERE id = ?')
    stopIntegrations.push(
      startMediaKeys(settings),
      startDiscord({
        settings,
        publicArtUrl: (id) => {
          const r = coverQuery.get(id) as { mb_release_id: string | null } | undefined
          return r?.mb_release_id ? `https://coverartarchive.org/release/${r.mb_release_id}/front-500` : null
        },
      }),
    )
    app.on('second-instance', () => showMain(settings))
    await library.start()
    imports.start()
    app.on('activate', () => showMain(settings))
  })
  app.on('before-quit', () => {
    quitting = true
  })
  app.on('will-quit', () => {
    for (const stop of stopIntegrations.splice(0)) stop()
    globalShortcut.unregisterAll()
    destroyTray()
    imports?.stop()
    library?.stop()
  })
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}
