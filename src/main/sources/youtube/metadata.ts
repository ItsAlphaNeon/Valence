// SiIvaGunner upload metadata (pure; unit-tested). Rip titles are "<track> - <game>" and either half
// can contain " - ", so the description's "Music:" line (the exact track name) splits them.
//   Music: Swashbuckler Spectacular - A Truth-Plundering Author
//   Composer: Noriyuki Iwadare
//   Playlist: https://www.youtube.com/playlist?list=…
//   Platform: Nintendo 3DS

export const SIIVAGUNNER_CHANNEL_ID = 'UC9ecwl3FTG66jIKA9JRDtmg'

export interface RipDescription {
  music?: string
  composer?: string
  platform?: string
  playlist?: string
}

/** "Key: value" lines from the top of a rip description (first occurrence of each key wins). */
export function parseDescription(text: string | null | undefined): RipDescription {
  const out: RipDescription = {}
  for (const line of (text ?? '').split(/\r?\n/)) {
    const m = /^\s*(Music|Composers?|Platforms?|Playlist)\s*:\s*(.+?)\s*$/i.exec(line)
    if (!m) continue
    const key = m[1].toLowerCase().replace(/s$/, '') as keyof RipDescription
    out[key] ??= m[2]
  }
  return out
}

/** The game half of a rip title: what follows the "Music:" track name, else the text after the last " - ". */
export function gameFromTitle(title: string, music?: string): string | undefined {
  const t = title.trim()
  if (music) {
    const m = music.trim()
    if (t.toLowerCase().startsWith(m.toLowerCase())) {
      const rest = t.slice(m.length).replace(/^\s*[-–—]\s*/, '').trim()
      if (rest) return rest
    }
  }
  const i = t.lastIndexOf(' - ')
  return i > 0 ? t.slice(i + 3).trim() || undefined : undefined
}

export interface YtInfo {
  id: string
  title: string
  description?: string | null
  channel_id?: string | null
  channel?: string | null
  timestamp?: number | null
  release_timestamp?: number | null
  upload_date?: string | null
  duration?: number | null
  webpage_url?: string | null
}

/** When the rip went up: the premiere time when it had one, else the upload time, else the upload day. */
export function uploadedAt(info: YtInfo): string | null {
  const ts = info.release_timestamp ?? info.timestamp
  if (ts) return new Date(ts * 1000).toISOString()
  const d = /^(\d{4})(\d{2})(\d{2})$/.exec(info.upload_date ?? '')
  return d ? `${d[1]}-${d[2]}-${d[3]}T00:00:00.000Z` : null
}
