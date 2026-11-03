// Main-side IPC helpers: typed-ish handlers, broadcast to all windows, and MessagePort brokering.

import { BrowserWindow, ipcMain, MessageChannelMain, type MessagePortMain, type WebContents } from 'electron'

type Handler = (...args: any[]) => unknown | Promise<unknown>

export function handle(channel: string, fn: Handler): void {
  ipcMain.removeHandler(channel)
  ipcMain.handle(channel, async (_e, ...args) => fn(...args))
}

export function onMessage(channel: string, fn: (sender: WebContents, ...args: any[]) => void): void {
  ipcMain.on(channel, (e, ...args) => fn(e.sender, ...args))
}

export function broadcast(channel: string, ...args: unknown[]): void {
  for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send(channel, ...args)
}

export type PortProvider = (port: MessagePortMain, args: unknown, sender: WebContents) => void

const portProviders = new Map<string, PortProvider>()

/** Registers a provider that is handed one end of a fresh MessageChannel when the renderer asks. */
export function providePort(name: string, provider: PortProvider): void {
  portProviders.set(name, provider)
}

export function initPortBroker(): void {
  ipcMain.on('port:request', (e, msg: { name: string; id: string; args?: unknown }) => {
    const provider = portProviders.get(msg.name)
    if (!provider) return
    const { port1, port2 } = new MessageChannelMain()
    provider(port1, msg.args, e.sender)
    e.sender.postMessage('port:deliver', { id: msg.id, name: msg.name }, [port2])
  })
}
