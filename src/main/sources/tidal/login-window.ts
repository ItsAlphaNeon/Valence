// Electron login window for the PKCE flow. The redirect to tidal.com/android/login/auth is
// intercepted (never actually loaded) and its `code` handed back.

import { BrowserWindow, session } from 'electron'
import { SourceError } from '../../import/source-types'
import { extractAuthCode, type CodeCapture } from './auth'
import type { TidalConfig } from './config'

/** Electron's default UA minus the Electron/app tokens some login pages reject. */
const desktopUa = (ua: string) => ua.replace(/\s(?:Electron|valence|Valence)\/\S+/g, '')

export function openLoginWindow(loginUrl: string, cfg: TidalConfig): Promise<string> {
  return new Promise((resolve, reject) => {
    const ses = session.fromPartition(cfg.partition)
    const win = new BrowserWindow({
      width: 480,
      height: 760,
      title: 'Log in to TIDAL',
      autoHideMenuBar: true,
      webPreferences: { partition: cfg.partition, contextIsolation: true, nodeIntegration: false, sandbox: true },
    })
    let settled = false
    const finish = (r: CodeCapture | null, err?: Error) => {
      if (settled) return
      settled = true
      ses.webRequest.onBeforeRequest(null)
      if (!win.isDestroyed()) win.close()
      if (err) reject(err)
      else if (r && 'code' in r) resolve(r.code)
      else reject(new SourceError(`TIDAL login failed: ${r?.error ?? 'unknown error'}`, 'auth'))
    }

    ses.webRequest.onBeforeRequest({ urls: [`${cfg.redirectUri}*`] }, (details, cb) => {
      const r = extractAuthCode(details.url, cfg.redirectUri)
      cb(r ? { cancel: true } : {})
      if (r) setImmediate(() => finish(r))
    })
    // Fallback in case the webRequest hook misses a renderer-initiated redirect.
    const onNav = (e: { url: string; preventDefault(): void }) => {
      const r = extractAuthCode(e.url, cfg.redirectUri)
      if (!r) return
      e.preventDefault()
      finish(r)
    }
    win.webContents.on('will-redirect', onNav)
    win.webContents.on('will-navigate', onNav)
    win.on('closed', () => finish(null, new SourceError('TIDAL login was cancelled', 'auth')))

    win.webContents.setUserAgent(desktopUa(win.webContents.getUserAgent()))
    win.loadURL(loginUrl).catch((e: Error & { code?: string }) => {
      // Client-side redirects and our own cancel abort the pending load; those are not failures.
      if (e.code === 'ERR_ABORTED' || e.code === 'ERR_BLOCKED_BY_CLIENT') return
      setTimeout(() => {
        if (!settled) finish(null, new SourceError(`Could not open TIDAL login: ${e.message}`, 'network'))
      }, 250)
    })
  })
}
