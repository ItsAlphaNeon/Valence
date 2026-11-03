// Discord Rich Presence: "Listening to <title>" with artist, album and elapsed/remaining time.
// Needs a Discord application client ID (Settings → Integrations); off unless discord.enabled.
// Updates are debounced (Discord allows ~5 per 20 s) and cleared while paused.

import { Client } from '@xhayper/discord-rpc'
import type { SettingsStore } from '../context'
import { onPlayerState, playerState, type RelayedState } from '../audio/relay'

export interface DiscordDeps {
  settings: SettingsStore
  /** A public https URL for the track's cover (Discord can't load local files), or null. */
  publicArtUrl(trackId: number): string | null
}

const RETRY_MS = 30_000
const DEBOUNCE_MS = 1500

export function startDiscord(deps: DiscordDeps): () => void {
  let client: Client | null = null
  let connecting = false
  let retry: ReturnType<typeof setTimeout> | null = null
  let debounce: ReturnType<typeof setTimeout> | null = null
  let lastKey = ''
  let stopped = false

  const cfg = () => {
    const enabled = deps.settings.get<boolean>('discord.enabled', false)
    const clientId = String(deps.settings.get<string>('discord.clientId', '') ?? '').trim()
    return { on: enabled && /^\d{15,25}$/.test(clientId), clientId }
  }

  const disconnect = async () => {
    if (retry) clearTimeout(retry)
    retry = null
    const c = client
    client = null
    lastKey = ''
    if (c) await c.destroy().catch(() => {})
  }

  const connect = async () => {
    const { on, clientId } = cfg()
    if (stopped || !on || client || connecting) return
    connecting = true
    const c = new Client({ clientId, transport: { type: 'ipc' } })
    c.on('disconnected', () => {
      if (client !== c) return
      client = null
      lastKey = ''
      scheduleRetry()
    })
    try {
      await c.login()
      if (stopped || !cfg().on) {
        await c.destroy().catch(() => {})
        return
      }
      client = c
      lastKey = ''
      push()
    } catch {
      // Discord isn't running (or the client ID is wrong); try again later.
      await c.destroy().catch(() => {})
      scheduleRetry()
    } finally {
      connecting = false
    }
  }

  const scheduleRetry = () => {
    if (stopped || retry || !cfg().on) return
    retry = setTimeout(() => {
      retry = null
      void connect()
    }, RETRY_MS)
  }

  const push = () => {
    if (debounce) return
    debounce = setTimeout(() => {
      debounce = null
      void update(playerState())
    }, DEBOUNCE_MS)
  }

  const update = async (s: RelayedState | null) => {
    const user = client?.user
    if (!user) return
    const c = s?.current
    if (!c || !s.playing) {
      if (lastKey === 'clear') return
      lastKey = 'clear'
      await user.clearActivity().catch(() => {})
      return
    }
    const start = Date.now() - s.positionMs
    // Round so tiny position drift doesn't count as a change.
    const key = `${c.id}|${Math.round(start / 2000)}`
    if (key === lastKey) return
    lastKey = key
    const dur = s.durationMs || c.durationMs
    const art = c.trackId != null ? deps.publicArtUrl(c.trackId) : null
    await user
      .setActivity({
        type: 2, // Listening
        statusDisplayType: 2, // member list shows the song title
        details: clip(c.title),
        state: clip(c.artist),
        largeImageKey: art ?? 'valence',
        largeImageText: clip(c.album || c.title),
        startTimestamp: start,
        ...(dur > 0 ? { endTimestamp: start + dur } : {}),
      })
      .catch(() => {})
  }

  const offState = onPlayerState((s, prev) => {
    if (!client) return
    const changed =
      s?.current?.id !== prev?.current?.id ||
      s?.playing !== prev?.playing ||
      // A seek: position moved by more than the ~250 ms between state updates allows.
      (!!s && !!prev && Math.abs(s.positionMs - prev.positionMs) > 3000)
    if (changed) push()
  })
  const offSettings = deps.settings.onChange((k) => {
    if (!k.startsWith('discord.')) return
    void disconnect().then(connect)
  })
  void connect()

  return () => {
    stopped = true
    offState()
    offSettings()
    if (debounce) clearTimeout(debounce)
    void disconnect()
  }
}

/** Discord rejects activity strings shorter than 2 or longer than 128 characters. */
function clip(s: string): string {
  const t = (s ?? '').trim()
  if (t.length < 2) return `${t}  `.slice(0, 2)
  return t.length > 128 ? `${t.slice(0, 127)}…` : t
}
