// Random per-device identifier, persisted in local app data. Internal only — never displayed as a name.

import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export function loadDeviceId(dataDir: string): string {
  const file = join(dataDir, 'device.json')
  try {
    const j = JSON.parse(readFileSync(file, 'utf8')) as { id?: string }
    if (j.id && /^[a-z0-9]{12,}$/.test(j.id)) return j.id
  } catch {
    /* create */
  }
  const id = randomBytes(8).toString('hex')
  mkdirSync(dataDir, { recursive: true })
  writeFileSync(file, JSON.stringify({ id, createdAt: new Date().toISOString() }))
  return id
}
