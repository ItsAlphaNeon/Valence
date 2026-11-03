// Generic, channel-based bridge. Feature modules define their own channels in shared/ipc-contract.ts
// so this file rarely needs to change.

import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'

const api = {
  platform: process.platform,
  invoke: (channel: string, ...args: unknown[]): Promise<unknown> => ipcRenderer.invoke(channel, ...args),
  send: (channel: string, ...args: unknown[]): void => ipcRenderer.send(channel, ...args),
  on: (channel: string, cb: (...args: unknown[]) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, ...args: unknown[]) => cb(...args)
    ipcRenderer.on(channel, listener)
    return () => ipcRenderer.off(channel, listener)
  },
  /**
   * Asks main for a MessagePort (e.g. a PCM stream). The port is delivered to the page with
   * window.postMessage({ type: 'valence-port', id }, '*', [port]) since contextBridge can't pass ports.
   */
  requestPort: (name: string, id: string, args?: unknown): void => {
    ipcRenderer.send('port:request', { name, id, args })
  },
}

ipcRenderer.on('port:deliver', (e, msg: { id: string; name: string }) => {
  window.postMessage({ type: 'valence-port', id: msg.id, name: msg.name }, '*', e.ports)
})

contextBridge.exposeInMainWorld('valence', api)

export type ValenceBridge = typeof api
