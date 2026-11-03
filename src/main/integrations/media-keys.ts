// Media keys. Normally Chromium's Media Session handles them (Windows SMTC, macOS Now Playing,
// Linux MPRIS). This optional fallback grabs them globally for setups where that doesn't reach
// Valence; it is off by default because a global grab takes the keys away from other apps.

import { globalShortcut } from 'electron'
import type { SettingsStore } from '../context'
import { sendPlayerCommand } from '../audio/relay'

const KEY = 'playback.globalMediaKeys'
const BINDINGS: Array<[string, string]> = [
  ['MediaPlayPause', 'toggle'],
  ['MediaNextTrack', 'next'],
  ['MediaPreviousTrack', 'prev'],
  ['MediaStop', 'pause'],
]

export function startMediaKeys(settings: SettingsStore): () => void {
  let active = false
  const apply = () => {
    const want = settings.get<boolean>(KEY, false)
    if (want === active) return
    if (want) {
      for (const [accel, type] of BINDINGS) {
        try {
          globalShortcut.register(accel, () => sendPlayerCommand({ type }))
        } catch {
          /* key unavailable on this platform */
        }
      }
    } else {
      for (const [accel] of BINDINGS) globalShortcut.unregister(accel)
    }
    active = want
  }
  apply()
  const off = settings.onChange((k) => k === KEY && apply())
  return () => {
    off()
    if (active) for (const [accel] of BINDINGS) globalShortcut.unregister(accel)
    active = false
  }
}
