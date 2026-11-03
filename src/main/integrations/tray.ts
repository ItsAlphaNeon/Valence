// System tray: transport controls, now-playing tooltip, show window / mini player / quit.

import { Menu, Tray, nativeImage, type MenuItemConstructorOptions } from 'electron'
import trayIcon from '../../../resources/icons/tray.png?asset'
import { onPlayerState, playerState, sendPlayerCommand, type RelayedState } from '../audio/relay'

export interface TrayActions {
  showMain(): void
  toggleMini(): void
  isMiniOpen(): boolean
  quit(): void
}

let tray: Tray | null = null
let refresh = (): void => {}

function label(s: RelayedState | null): string {
  const c = s?.current
  if (!c) return 'Valence'
  const t = `${c.title} — ${c.artist}`
  return t.length > 120 ? `${t.slice(0, 119)}…` : t
}

function buildMenu(s: RelayedState | null, a: TrayActions): Menu {
  const c = s?.current
  const items: MenuItemConstructorOptions[] = [
    ...(c ? ([{ label: label(s), enabled: false }, { type: 'separator' }] as MenuItemConstructorOptions[]) : []),
    { label: s?.playing ? 'Pause' : 'Play', enabled: !!c, click: () => sendPlayerCommand({ type: 'toggle' }) },
    { label: 'Next', enabled: !!c, click: () => sendPlayerCommand({ type: 'next' }) },
    { label: 'Previous', enabled: !!c, click: () => sendPlayerCommand({ type: 'prev' }) },
    { type: 'separator' },
    { label: 'Show Valence', click: a.showMain },
    { label: 'Mini Player', type: 'checkbox', checked: a.isMiniOpen(), click: a.toggleMini },
    { type: 'separator' },
    { label: 'Quit Valence', click: a.quit },
  ]
  return Menu.buildFromTemplate(items)
}

export function createTray(a: TrayActions): Tray {
  if (tray) return tray
  // Windows/Linux scale the 32 px icon to the tray's size; macOS wants an 18 pt template image.
  let img = nativeImage.createFromPath(trayIcon)
  if (process.platform === 'darwin') {
    img = img.resize({ width: 18, height: 18, quality: 'best' })
    img.setTemplateImage(true)
  }
  tray = new Tray(img)
  tray.setToolTip('Valence')
  refresh = () => {
    if (!tray || tray.isDestroyed()) return
    const s = playerState()
    tray.setToolTip(label(s))
    tray.setContextMenu(buildMenu(s, a))
  }
  refresh()
  // Rebuild only when something the menu shows changes (state arrives at ~4 Hz while playing).
  onPlayerState((s, prev) => {
    if (s?.current?.id !== prev?.current?.id || s?.playing !== prev?.playing) refresh()
  })
  tray.on('click', () => {
    if (process.platform !== 'darwin') a.showMain()
  })
  return tray
}

/** Re-reads state that lives outside the relay (e.g. whether the mini player is open). */
export function refreshTray(): void {
  refresh()
}

export function destroyTray(): void {
  tray?.destroy()
  tray = null
}
