// `yt-dlp --flat-playlist -J <playlist>` output → entries (pure; unit-tested). Flat entries carry the
// uploading channel but no upload date; deleted and private videos come back without a channel.

export interface PlaylistEntry {
  id: string
  title: string
  durationSec: number | null
  channelId: string | null
  channel: string | null
  /** Deleted / private / unavailable in this region. */
  unavailable: boolean
}

export interface FlatPlaylist {
  title: string | null
  entries: PlaylistEntry[]
}

const GONE = /^\[(deleted|private|unavailable) video\]$/i

export function parseFlatPlaylist(json: string): FlatPlaylist {
  const j = JSON.parse(json) as { title?: string; entries?: Array<Record<string, unknown>> }
  const entries: PlaylistEntry[] = []
  const seen = new Set<string>()
  for (const e of j.entries ?? []) {
    const id = typeof e.id === 'string' ? e.id : null
    if (!id || seen.has(id)) continue
    seen.add(id)
    const title = typeof e.title === 'string' ? e.title : id
    const channelId = typeof e.channel_id === 'string' ? e.channel_id : null
    entries.push({
      id,
      title,
      durationSec: typeof e.duration === 'number' ? Math.round(e.duration) : null,
      channelId,
      channel: typeof e.channel === 'string' ? e.channel : typeof e.uploader === 'string' ? e.uploader : null,
      unavailable: GONE.test(title) || e.availability === 'private' || e.availability === 'needs_auth',
    })
  }
  return { title: typeof j.title === 'string' ? j.title : null, entries }
}

/** A YouTube playlist link (or bare list id) → canonical playlist URL; null if it isn't one. */
export function playlistUrl(input: string | null | undefined): string | null {
  const s = (input ?? '').trim()
  if (!s) return null
  if (/^(PL|UU|OL|FL|LL|RD)[A-Za-z0-9_-]{10,}$/.test(s)) return `https://www.youtube.com/playlist?list=${s}`
  try {
    const u = new URL(s)
    if (!/(^|\.)youtube\.com$|^youtu\.be$/i.test(u.hostname)) return null
    const list = u.searchParams.get('list')
    return list ? `https://www.youtube.com/playlist?list=${encodeURIComponent(list)}` : null
  } catch {
    return null
  }
}
