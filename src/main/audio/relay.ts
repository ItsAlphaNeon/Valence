// Relays the main window's Player to other windows (mini player): state out, commands in.
//   renderer (player host)  send('player:state', state)    -> other windows get 'player:state'
//   any other window        send('player:command', cmd)    -> other windows get 'player:command'
//   any window              invoke('player:getState')      -> last state (or null)
// Main-side integrations (tray, Discord, media keys) use onPlayerState / sendPlayerCommand.

import { BrowserWindow, ipcMain, type WebContents } from 'electron'
import { handle } from '../ipc'

/** The subset of the renderer's PlayerState that main-side integrations read. */
export interface RelayedState {
  current: { id: string; trackId?: number; title: string; artist: string; album: string; durationMs: number } | null
  positionMs: number
  durationMs: number
  playing: boolean
  volume: number
  muted: boolean
}

type StateListener = (s: RelayedState | null, prev: RelayedState | null) => void

let last: RelayedState | null = null
let host: WebContents | null = null
const listeners = new Set<StateListener>()

function sendOthers(sender: WebContents, channel: string, payload: unknown): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (w.isDestroyed() || w.webContents === sender) continue
    w.webContents.send(channel, payload)
  }
}

export function registerPlayerRelay(): void {
  ipcMain.on('player:state', (e, state) => {
    const prev = last
    last = state
    host = e.sender
    sendOthers(e.sender, 'player:state', state)
    for (const l of listeners) l(last, prev)
  })
  ipcMain.on('player:command', (e, cmd) => {
    if (cmd && typeof cmd === 'object' && typeof cmd.type === 'string') sendOthers(e.sender, 'player:command', cmd)
  })
  handle('player:getState', () => last)
}

export function playerState(): RelayedState | null {
  return last
}

export function onPlayerState(cb: StateListener): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

/** Sends a command to the window that hosts the audio engine. */
export function sendPlayerCommand(cmd: { type: string; [k: string]: unknown }): void {
  if (host && !host.isDestroyed()) host.send('player:command', cmd)
}
