// Mini player: a small frameless, always-on-top window that mirrors the main window's player
// through the relay (src/main/audio/relay.ts). Position is remembered per machine.

import { BrowserWindow, nativeTheme, screen } from 'electron'
import { join } from 'node:path'
import type { SettingsStore } from '../context'

export const MINI_SIZE = { width: 400, height: 124 }
const BOUNDS_KEY = 'ui.mini.position'

let mini: BrowserWindow | null = null

type Loader = (win: BrowserWindow) => void

function onScreen(p: { x: number; y: number }): boolean {
  return screen.getAllDisplays().some((d) => {
    const a = d.workArea
    return p.x >= a.x - 20 && p.y >= a.y - 20 && p.x + MINI_SIZE.width <= a.x + a.width + 20 && p.y + MINI_SIZE.height <= a.y + a.height + 20
  })
}

function initialPosition(settings: SettingsStore): { x: number; y: number } {
  const saved = settings.get<{ x: number; y: number } | null>(BOUNDS_KEY, null)
  if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y) && onScreen(saved)) return saved
  const a = screen.getPrimaryDisplay().workArea
  return { x: a.x + a.width - MINI_SIZE.width - 24, y: a.y + a.height - MINI_SIZE.height - 24 }
}

export function isMiniOpen(): boolean {
  return !!mini && !mini.isDestroyed()
}

export function openMini(settings: SettingsStore, load: Loader): BrowserWindow {
  if (mini && !mini.isDestroyed()) {
    mini.show()
    mini.focus()
    return mini
  }
  const pos = initialPosition(settings)
  const win32 = process.platform === 'win32'
  const mac = process.platform === 'darwin'
  const win = new BrowserWindow({
    ...MINI_SIZE,
    ...pos,
    title: 'Valence Mini Player',
    frame: false,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: settings.get('ui.mini.onTop', true),
    show: false,
    ...(win32 ? { backgroundMaterial: 'acrylic' as const, backgroundColor: '#00000000' } : {}),
    ...(mac ? { vibrancy: 'hud' as const, visualEffectState: 'active' as const, backgroundColor: '#00000000' } : {}),
    ...(!win32 && !mac ? { backgroundColor: nativeTheme.shouldUseDarkColors ? '#1c1c1e' : '#f2f2f7' } : {}),
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.cjs'),
      sandbox: false,
      contextIsolation: true,
    },
  })
  win.setAlwaysOnTop(settings.get('ui.mini.onTop', true), 'floating')
  win.once('ready-to-show', () => win.show())
  let saveTimer: ReturnType<typeof setTimeout> | null = null
  win.on('moved', () => {
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(() => {
      if (win.isDestroyed()) return
      const [x, y] = win.getPosition()
      settings.set(BOUNDS_KEY, { x, y })
    }, 400)
  })
  win.on('closed', () => {
    if (mini === win) mini = null
  })
  mini = win
  load(win)
  return win
}

export function closeMini(): void {
  if (mini && !mini.isDestroyed()) mini.close()
  mini = null
}

export function toggleMini(settings: SettingsStore, load: Loader): void {
  if (isMiniOpen()) closeMini()
  else openMini(settings, load)
}

export function setMiniOnTop(onTop: boolean): void {
  if (mini && !mini.isDestroyed()) mini.setAlwaysOnTop(onTop, 'floating')
}
