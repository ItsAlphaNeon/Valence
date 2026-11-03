import { contextBridge } from 'electron'

contextBridge.exposeInMainWorld('valence', {
  platform: process.platform,
})
