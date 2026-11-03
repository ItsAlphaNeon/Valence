// The persistent `persist:bandcamp` session: Chrome UA, cookie-based login state, login window.
// All Bandcamp traffic uses `session.fetch` (the CDN rejects non-browser clients).

import { app, BrowserWindow, session, type Cookie, type Session } from 'electron'
import type { Transport } from '@main/import/source-types'
import type { BandcampAuth } from './service'
import { chromeUserAgent } from './parse'

export const BANDCAMP_PARTITION = 'persist:bandcamp'
const LOGIN_URL = 'https://bandcamp.com/login'
const POLL_MS = 1500

export interface BandcampSession extends BandcampAuth {
  transport: Transport
  userAgent(): string
}

const isBandcampDomain = (d: string | undefined) => !!d && /(^|\.)bandcamp\.com$/i.test(d.replace(/^\./, ''))

export function createBandcampSession(): BandcampSession {
  let ses: Session | null = null
  let ua = ''

  // Lazy: session.fromPartition needs the app to be ready.
  const get = (): Session => {
    if (!ses) {
      ses = session.fromPartition(BANDCAMP_PARTITION)
      ua = chromeUserAgent(app.userAgentFallback)
      ses.setUserAgent(ua, 'en-US,en;q=0.9')
    }
    return ses
  }

  const isLoggedIn = async (): Promise<boolean> => {
    const cookies = await get().cookies.get({ domain: 'bandcamp.com', name: 'identity' })
    const now = Date.now() / 1000
    return cookies.some((c) => isBandcampDomain(c.domain) && !!c.value && c.value !== 'deleted' && (!c.expirationDate || c.expirationDate > now))
  }

  const openLogin = (): Promise<boolean> => {
    const s = get()
    return new Promise((resolve) => {
      const win = new BrowserWindow({
        width: 520,
        height: 760,
        title: 'Log in to Bandcamp',
        autoHideMenuBar: true,
        webPreferences: { partition: BANDCAMP_PARTITION, sandbox: true, contextIsolation: true, nodeIntegration: false },
      })
      let done = false
      const cleanup = () => {
        done = true
        clearInterval(timer)
        s.cookies.removeListener('changed', onChanged)
      }
      const succeed = () => {
        if (done) return
        cleanup()
        void s.cookies.flushStore().catch(() => {})
        if (!win.isDestroyed()) win.close()
        resolve(true)
      }
      const check = () => {
        if (!done) isLoggedIn().then((ok) => ok && succeed(), () => {})
      }
      const onChanged = (_e: Electron.Event, cookie: Cookie, _cause: string, removed: boolean) => {
        if (!removed && cookie.name === 'identity' && isBandcampDomain(cookie.domain)) check()
      }
      s.cookies.on('changed', onChanged)
      // Fallback in case the changed event is missed (e.g. cookie set during a redirect).
      const timer = setInterval(check, POLL_MS)
      win.on('closed', () => {
        if (done) return
        cleanup()
        isLoggedIn().then(resolve, () => resolve(false))
      })
      win.webContents.setWindowOpenHandler(({ url }) => (/^https:\/\//i.test(url) ? { action: 'allow' } : { action: 'deny' }))
      win.loadURL(LOGIN_URL, { userAgent: ua }).catch(() => {})
    })
  }

  let pending: Promise<boolean> | null = null

  return {
    transport: (url, init) => get().fetch(url, { credentials: 'include', ...init }) as unknown as Promise<Response>,
    userAgent: () => (get(), ua),
    isLoggedIn,
    async login() {
      if (await isLoggedIn()) return true
      pending ??= openLogin().finally(() => (pending = null))
      return pending
    },
    async logout() {
      const s = get()
      await s.clearStorageData()
      await s.clearCache()
      await s.clearAuthCache()
    },
  }
}
