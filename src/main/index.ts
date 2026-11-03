import { app, BrowserWindow, protocol } from 'electron'
import { join } from 'node:path'
import { configureDataDir, defaultInboxDir, defaultMusicDir } from './platform/paths'
import { loadDeviceId } from './platform/device'
import { createContext, ensureDirs } from './app-context'
import { createSettings } from './settings'
import { HlcClock } from './sync/hlc'
import { LibraryService } from './library/service'
import { ImportService } from './import/service'
import { ART_SCHEME } from './library/art'
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
let library: LibraryService | null = null
let imports: ImportService | null = null

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
    createMainWindow()
    await library.start()
    imports.start()
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createMainWindow()
    })
  })
  app.on('will-quit', () => {
    imports?.stop()
    library?.stop()
  })
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}
