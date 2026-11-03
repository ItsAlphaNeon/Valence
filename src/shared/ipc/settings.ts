// Settings IPC (renderer <-> main). Keys with a shared prefix (library., transcode., art., …) sync
// through ~/Music/.valence/settings.json; everything else is local to this machine.

export const SETTINGS = {
  all: 'settings:all',
  get: 'settings:get',
  set: 'settings:set',
  /** broadcast: (key, value) */
  changed: 'settings:changed',
  /** Native folder picker; returns the chosen path or null. */
  chooseFolder: 'settings:chooseFolder',
  openPath: 'settings:openPath',
  /** Opens an https URL from a short allowlist in the default browser. */
  openExternal: 'settings:openExternal',
  appInfo: 'settings:appInfo',
} as const

export interface AppInfo {
  version: string
  libraryRoot: string
  dataDir: string
  inboxDir: string
  archiveDir: string | null
  deviceId: string
  platform: string
  gpu: Record<string, string>
}
