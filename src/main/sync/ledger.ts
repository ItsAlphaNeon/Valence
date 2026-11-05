// What other devices have filed. Every import appends to its device's own ledger.jsonl after the files
// are in place, and the small ledger gets here through Syncthing long before the files can: those wait
// their turn in the pull queue, for hours on a big library. So a ledger line means "this is on its way".

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { valenceDir } from './device-log'

/** Release keys starting with `prefix` that a device other than `deviceId` has filed into the library. */
export function keysFiledElsewhere(libraryRoot: string, deviceId: string, prefix: string): Set<string> {
  const root = join(valenceDir(libraryRoot), 'devices')
  const out = new Set<string>()
  let devices: string[]
  try {
    devices = readdirSync(root)
  } catch {
    return out
  }
  for (const device of devices) {
    if (device === deviceId) continue
    let text: string
    try {
      text = readFileSync(join(root, device, 'ledger.jsonl'), 'utf8')
    } catch {
      continue // a phone, or a desktop that has imported nothing
    }
    for (const line of text.split('\n')) {
      if (!line.includes(prefix)) continue
      try {
        for (const key of (JSON.parse(line) as { keys?: string[] }).keys ?? []) if (key.startsWith(prefix)) out.add(key)
      } catch {
        /* the last line of a file Syncthing is still delivering */
      }
    }
  }
  return out
}
