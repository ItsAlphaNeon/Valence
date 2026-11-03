// Settings IPC handlers.

import { app, BrowserWindow, dialog, shell } from 'electron'
import type { AppContext } from './context'
import type { PersistentSettings } from './settings'
import { broadcast, handle } from './ipc'
import { SETTINGS, type AppInfo } from '@shared/ipc/settings'
import { loadUserThemes, writeExampleTheme } from './library/themes'

// Only links the UI itself shows (setup pages for keys and IDs).
const EXTERNAL_HOSTS = new Set([
  'acoustid.org', 'discord.com', 'musicbrainz.org', 'syncthing.net', 'docs.syncthing.net', 'tidal.com', 'listen.tidal.com', 'bandcamp.com',
  'highquality.rip', 'sgfr.highquality.rip', 'drive.google.com', 'www.youtube.com', 'youtube.com', 'siivagunner.fandom.com',
])
const externalOk = (host: string) => EXTERNAL_HOSTS.has(host) || host.endsWith('.bandcamp.com')

export function registerSettingsIpc(ctx: AppContext, settings: PersistentSettings): void {
  handle(SETTINGS.all, () => settings.all())
  handle(SETTINGS.get, (key: string, fallback?: unknown) => settings.get(key, fallback ?? null))
  handle(SETTINGS.set, (key: string, value: unknown) => settings.set(key, value))
  settings.onChange((key, value) => broadcast(SETTINGS.changed, key, value))
  handle(SETTINGS.chooseFolder, async (title?: string, defaultPath?: string) => {
    const win = BrowserWindow.getFocusedWindow() ?? undefined
    const opts: Electron.OpenDialogOptions = { title: title ?? 'Choose folder', defaultPath, properties: ['openDirectory', 'createDirectory'] }
    const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    return r.canceled ? null : (r.filePaths[0] ?? null)
  })
  handle(SETTINGS.openPath, (p: string) => shell.openPath(p))
  handle(SETTINGS.openExternal, (url: string) => {
    const u = new URL(String(url))
    if (u.protocol !== 'https:' || !externalOk(u.hostname)) throw new Error(`Not opening ${u.hostname}`)
    return shell.openExternal(u.toString())
  })
  handle(SETTINGS.themes, () => loadUserThemes(ctx.env.libraryRoot))
  handle(SETTINGS.themeExample, () => writeExampleTheme(ctx.env.libraryRoot))
  handle(
    SETTINGS.appInfo,
    (): AppInfo => ({
      version: app.getVersion(),
      libraryRoot: ctx.env.libraryRoot,
      dataDir: ctx.env.dataDir,
      inboxDir: ctx.env.inboxDir,
      archiveDir: ctx.env.archiveDir,
      deviceId: ctx.env.deviceId,
      platform: process.platform,
      gpu: app.getGPUFeatureStatus() as unknown as Record<string, string>,
    }),
  )
}
