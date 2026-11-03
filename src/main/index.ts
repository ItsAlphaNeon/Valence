import { app, BrowserWindow } from 'electron'
import { join } from 'node:path'
import { configureDataDir, defaultInboxDir, defaultMusicDir } from './platform/paths'
import { loadDeviceId } from './platform/device'
import { createContext, createMemorySettings, ensureDirs } from './app-context'
import { initPortBroker } from './ipc'
import { registerAudio, registerAudioSchemes } from './audio'
import { registerTidal } from './sources/tidal'
import { registerBandcamp } from './sources/bandcamp'
import type { AppContext, ValenceEnv } from './context'

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

function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 560,
    title: 'Valence',
    show: false,
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.cjs'),
      sandbox: false,
      contextIsolation: true,
      backgroundThrottling: false,
    },
  })
  win.once('ready-to-show', () => win.show())
  const r = rendererUrl('index')
  if (r.url) void win.loadURL(r.url)
  else void win.loadFile(r.file!, r.hash ? { hash: r.hash } : undefined)
  return win
}

let ctx: AppContext | null = null

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
  void app.whenReady().then(() => {
    const env = buildEnv()
    ensureDirs(env)
    ctx = createContext(env, createMemorySettings())
    initPortBroker()
    registerAudio(ctx)
    registerTidal(ctx)
    registerBandcamp(ctx)
    createMainWindow()
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createMainWindow()
    })
  })
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}
