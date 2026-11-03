// Relays the main window's Player to other windows (mini player): state out, commands in.
//   renderer (player host)  send('player:state', state)    -> other windows get 'player:state'
//   any other window        send('player:command', cmd)    -> other windows get 'player:command'
//   any window              invoke('player:getState')      -> last state (or null)

import { BrowserWindow, ipcMain, type WebContents } from 'electron'
import { handle } from '../ipc'

function sendOthers(sender: WebContents, channel: string, payload: unknown): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (w.isDestroyed() || w.webContents === sender) continue
    w.webContents.send(channel, payload)
  }
}

export function registerPlayerRelay(): void {
  let last: unknown = null
  ipcMain.on('player:state', (e, state) => {
    last = state
    sendOthers(e.sender, 'player:state', state)
  })
  ipcMain.on('player:command', (e, cmd) => {
    if (cmd && typeof cmd === 'object' && typeof cmd.type === 'string') sendOthers(e.sender, 'player:command', cmd)
  })
  handle('player:getState', () => last)
}
