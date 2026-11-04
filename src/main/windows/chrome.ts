// Main-window chrome driven by the renderer (fire-and-forget messages):
//   'window:chrome'   { symbolColor, background }  caption-button colours + window background
//   'window:zoom'     number                       page zoom 0.7..1.6 (the overlay follows)
//   'window:playback' { playing, hasTrack, title?, artist? }  window title + Windows thumbnail buttons
//   'notify:track'    { title, artist, album?, artHash? }      silent notification when unfocused
// plus the Windows taskbar progress bar while imports/downloads run.

import { BrowserWindow, nativeImage, nativeTheme, Notification, type NativeImage, type WebContents } from 'electron'
import sharp from 'sharp'
import type { SettingsStore } from '../context'
import { onMessage } from '../ipc'
import { sendPlayerCommand } from '../audio/relay'
import {
  clampZoom,
  MAIN_BACKGROUND,
  overlayHeight,
  parseChrome,
  playbackTitle,
  TaskbarBatch,
  thumbarSpecs,
  thumbarSvg,
  trafficLightPosition,
  validColor,
  type PlaybackChrome,
  type ThumbarGlyph,
  type WindowChrome,
} from './chrome-state'

const CHROME_KEY = 'ui.windowChrome'
const mac = process.platform === 'darwin'
const win32 = process.platform === 'win32'

export interface ChromeDeps {
  settings: SettingsStore
  mainWindow: () => BrowserWindow | null
  showMain: () => void
  /** Cached album art (JPEG) for notification icons. */
  art: (hash: string, size: number) => Promise<Buffer | null>
}

let chrome: WindowChrome | null = null
let zoom = 1
let playback: PlaybackChrome | null = null

/** Last chrome the renderer asked for (kept across launches so the window opens in the right colour). */
export function currentChrome(settings: SettingsStore): WindowChrome {
  chrome ??= parseChrome(settings.get(CHROME_KEY, null))
  return chrome
}

/** BrowserWindow options for the main window's frame. */
export function mainWindowChromeOptions(settings: SettingsStore): Electron.BrowserWindowConstructorOptions {
  const c = currentChrome(settings)
  return {
    titleBarStyle: 'hidden',
    backgroundColor: c.background || MAIN_BACKGROUND,
    ...(mac ? { trafficLightPosition: trafficLightPosition(zoom) } : { titleBarOverlay: { color: '#00000000', symbolColor: c.symbolColor, height: overlayHeight(zoom) } }),
  }
}

function applyOverlay(win: BrowserWindow, symbolColor: string): void {
  if (win.isDestroyed()) return
  try {
    if (mac) win.setWindowButtonPosition(trafficLightPosition(zoom))
    else win.setTitleBarOverlay({ color: '#00000000', symbolColor, height: overlayHeight(zoom) })
  } catch {
    /* no overlay on this window */
  }
}

// ---- thumbnail toolbar (Windows) ----

type Glyph = ThumbarGlyph
const iconSets = new Map<string, Promise<Record<Glyph, NativeImage>>>()

function iconSet(color: string): Promise<Record<Glyph, NativeImage>> {
  let p = iconSets.get(color)
  if (!p) {
    p = (async () => {
      const out = {} as Record<Glyph, NativeImage>
      for (const g of ['prev', 'play', 'pause', 'next'] as Glyph[]) {
        const img = nativeImage.createEmpty()
        for (const [scale, px] of [[1, 16], [1.25, 20], [1.5, 24], [2, 32]] as const) {
          const png = await sharp(Buffer.from(thumbarSvg(g, color, px))).png().toBuffer()
          img.addRepresentation({ scaleFactor: scale, buffer: png, width: px, height: px })
        }
        out[g] = img
      }
      return out
    })()
    p.catch(() => iconSets.delete(color))
    iconSets.set(color, p)
  }
  return p
}

// The thumbnail is used most while the window is minimized, when isVisible() is false, so updates
// go through in every window state. A rejected update matters: Electron drops the old buttons'
// click handlers before it validates the new ones, so a failed call leaves buttons that show but
// do nothing. Rejected updates are retried, and showing the window re-applies the current buttons.
const THUMBAR_RETRY_MS = [250, 500, 1000, 2000, 4000]
let thumbarWanted = '' // state last sent (or being sent); cleared when Windows keeps refusing it
let thumbarGen = 0
let thumbarRetry: NodeJS.Timeout | null = null

function refreshThumbar(win: BrowserWindow, force = false): void {
  if (!win32 || !playback || win.isDestroyed()) return
  const color = nativeTheme.shouldUseDarkColorsForSystemIntegratedUI ? '#ffffff' : '#1a1a1a'
  const key = `${playback.hasTrack}|${playback.playing}|${color}`
  if (!force && key === thumbarWanted) return
  thumbarWanted = key
  const gen = ++thumbarGen
  if (thumbarRetry) clearTimeout(thumbarRetry)
  thumbarRetry = null
  void attemptThumbar(win, playback, color, gen, 0)
}

async function attemptThumbar(win: BrowserWindow, p: PlaybackChrome, color: string, gen: number, tries: number): Promise<void> {
  const icons = await iconSet(color).catch(() => null)
  if (gen !== thumbarGen || win.isDestroyed()) return
  let ok = false
  if (icons) {
    try {
      ok = win.setThumbarButtons(
        thumbarSpecs(p).map((b) => ({ tooltip: b.tooltip, icon: icons[b.glyph], flags: b.flags as Electron.ThumbarButton['flags'], click: () => sendPlayerCommand({ type: b.command }) })),
      )
    } catch {
      ok = false
    }
  }
  if (ok) return
  if (tries >= THUMBAR_RETRY_MS.length) {
    thumbarWanted = ''
    return
  }
  thumbarRetry = setTimeout(() => {
    thumbarRetry = null
    void attemptThumbar(win, p, color, gen, tries + 1)
  }, THUMBAR_RETRY_MS[tries])
}

// ---- notifications ----

let notification: Notification | null = null
let notifySeq = 0

async function notifyTrack(deps: ChromeDeps, t: { title?: unknown; artist?: unknown; album?: unknown; artHash?: unknown }): Promise<void> {
  if (!Notification.isSupported() || typeof t?.title !== 'string' || !t.title) return
  const main = deps.mainWindow()
  if (main && !main.isDestroyed() && main.isFocused()) return
  const seq = ++notifySeq
  let icon: NativeImage | undefined
  const hash = typeof t.artHash === 'string' ? t.artHash.replace(/[^0-9a-f]/gi, '') : ''
  if (hash) {
    const buf = await deps.art(hash, 128).catch(() => null)
    if (buf) icon = nativeImage.createFromBuffer(buf)
  }
  if (seq !== notifySeq) return
  const body = [t.artist, t.album].filter((x): x is string => typeof x === 'string' && !!x).join(' — ')
  notification?.close()
  const n = new Notification({ title: t.title, body, silent: true, ...(icon && !icon.isEmpty() ? { icon } : {}) })
  n.on('click', () => deps.showMain())
  n.on('close', () => {
    if (notification === n) notification = null
  })
  n.show()
  notification = n
}

// ---- wiring ----

function isMain(deps: ChromeDeps, sender: WebContents): BrowserWindow | null {
  const win = BrowserWindow.fromWebContents(sender)
  return win && win === deps.mainWindow() ? win : null
}

/** Applies remembered chrome/zoom/playback state to a (re)created main window. */
export function attachMainWindow(win: BrowserWindow): void {
  win.webContents.setZoomMode('isolated')
  win.on('page-title-updated', (e) => e.preventDefault())
  win.setTitle(playbackTitle(playback))
  win.webContents.on('did-finish-load', () => {
    if (zoom !== 1 && !win.isDestroyed()) win.webContents.setZoomFactor(zoom)
  })
  // A new window, or one back from the tray, has a fresh taskbar button with no thumbnail buttons.
  thumbarWanted = ''
  win.on('show', () => refreshThumbar(win, true))
}

export function registerWindowChrome(deps: ChromeDeps): void {
  onMessage('window:chrome', (sender, c: Partial<WindowChrome>) => {
    const symbolColor = validColor(c?.symbolColor)
    const background = validColor(c?.background)
    const win = BrowserWindow.fromWebContents(sender)
    if (!win || win.isDestroyed()) return
    if (background) win.setBackgroundColor(background)
    if (win !== deps.mainWindow()) return
    const next = { symbolColor: symbolColor ?? currentChrome(deps.settings).symbolColor, background: background ?? currentChrome(deps.settings).background }
    const changed = next.symbolColor !== chrome?.symbolColor || next.background !== chrome?.background
    chrome = next
    applyOverlay(win, next.symbolColor)
    if (changed) deps.settings.set(CHROME_KEY, next)
  })
  onMessage('window:zoom', (sender, z: unknown) => {
    const f = clampZoom(z)
    if (f === null || sender.isDestroyed()) return
    sender.setZoomFactor(f)
    const win = isMain(deps, sender)
    if (win) {
      zoom = f
      applyOverlay(win, currentChrome(deps.settings).symbolColor)
    }
  })
  onMessage('window:playback', (sender, p: Partial<PlaybackChrome>) => {
    const win = isMain(deps, sender)
    if (!win) return
    playback = { playing: !!p?.playing, hasTrack: !!p?.hasTrack, title: typeof p?.title === 'string' ? p.title : undefined, artist: typeof p?.artist === 'string' ? p.artist : undefined }
    const title = playbackTitle(playback)
    if (win.getTitle() !== title) win.setTitle(title)
    refreshThumbar(win)
  })
  onMessage('notify:track', (_sender, t) => void notifyTrack(deps, t).catch(() => {}))
  nativeTheme.on('updated', () => {
    const win = deps.mainWindow()
    if (win) refreshThumbar(win)
  })
}

/** Shows overall import/download progress on the taskbar button while anything is running. */
export function startTaskbarProgress(
  mainWindow: () => BrowserWindow | null,
  queue: { onActivity(cb: () => void): () => void; activeProgress(): Array<{ id: string; status: string; progress: number }> },
): () => void {
  const batch = new TaskbarBatch()
  let timer: NodeJS.Timeout | null = null
  let shown = -2
  const apply = () => {
    timer = null
    const v = batch.update(queue.activeProgress())
    const win = mainWindow()
    if (!win || win.isDestroyed()) return
    const value = v === null ? -1 : Math.round(v * 200) / 200
    if (value === shown) return
    shown = value
    win.setProgressBar(value === -1 ? -1 : Math.max(0.01, value))
  }
  const off = queue.onActivity(() => {
    timer ??= setTimeout(apply, 500)
  })
  apply()
  return () => {
    off()
    if (timer) clearTimeout(timer)
    const win = mainWindow()
    if (win && !win.isDestroyed()) win.setProgressBar(-1)
  }
}
