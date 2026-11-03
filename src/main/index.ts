import { app, BrowserWindow } from 'electron'
import { join } from 'node:path'

const SMOKE = process.argv.includes('--smoke')

app.setName('Valence')
if (process.env.VALENCE_USER_DATA) app.setPath('userData', process.env.VALENCE_USER_DATA)

function rendererUrl(page: 'index' | 'mini'): { url?: string; file?: string } {
  const dev = process.env.ELECTRON_RENDERER_URL
  if (dev) return { url: `${dev}/${page}.html` }
  return { file: join(import.meta.dirname, '../renderer', `${page}.html`) }
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
    },
  })
  win.once('ready-to-show', () => win.show())
  const r = rendererUrl('index')
  if (r.url) void win.loadURL(r.url)
  else void win.loadFile(r.file!)
  return win
}

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
    createMainWindow()
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createMainWindow()
    })
  })
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}
