// Resolves Valence's directories. Library root defaults to the OS Music folder; app data lives in
// a local (non-roaming) location; everything is overridable by env for tests.

import { app } from 'electron'
import { execFileSync } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'

export function defaultMusicDir(): string {
  try {
    return app.getPath('music')
  } catch {
    if (process.platform === 'linux') {
      try {
        const p = execFileSync('xdg-user-dir', ['MUSIC'], { encoding: 'utf8' }).trim()
        if (p) return p
      } catch {
        /* fall through */
      }
    }
    return join(homedir(), 'Music')
  }
}

/** Local app data dir. On Windows use %LOCALAPPDATA%\Valence so caches don't roam. Call before 'ready'. */
export function configureDataDir(): string {
  const override = process.env.VALENCE_DATA_DIR ?? process.env.VALENCE_USER_DATA
  let dir: string
  if (override) dir = override
  else if (process.platform === 'win32') dir = join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'Valence')
  else if (process.platform === 'linux') dir = join(process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), 'valence')
  else dir = join(app.getPath('appData'), 'Valence')
  app.setPath('userData', dir)
  return dir
}

export function defaultInboxDir(): string {
  return process.env.VALENCE_INBOX ?? join(homedir(), 'Valence Inbox')
}
