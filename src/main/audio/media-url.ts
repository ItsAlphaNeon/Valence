// Pure helpers for valence-media:// (no electron import, unit-tested).

export const MEDIA_SCHEME = 'valence-media'

export const MEDIA_MIME: Record<string, string> = {
  '.flac': 'audio/flac',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.mp4': 'audio/mp4',
  '.aac': 'audio/aac',
  '.alac': 'audio/mp4',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.wav': 'audio/wav',
  '.webm': 'audio/webm',
  '.aif': 'audio/aiff',
  '.aiff': 'audio/aiff',
  '.wma': 'audio/x-ms-wma',
}

export function decodeMediaUrl(url: string): string | null {
  try {
    const u = new URL(url)
    if (u.protocol !== `${MEDIA_SCHEME}:` || u.host !== 'file') return null
    const b64 = u.pathname.replace(/^\/+/, '').replace(/\.[A-Za-z0-9]{1,5}$/, '')
    const p = Buffer.from(b64, 'base64url').toString('utf8')
    return p || null
  } catch {
    return null
  }
}

export function parseRange(h: string | null, size: number): { start: number; end: number } | 'invalid' | null {
  if (!h) return null
  const m = /^bytes=(\d*)-(\d*)$/.exec(h.trim())
  if (!m || (m[1] === '' && m[2] === '')) return 'invalid'
  let start: number
  let end: number
  if (m[1] === '') {
    const n = Number(m[2])
    if (n === 0) return 'invalid'
    start = Math.max(0, size - n)
    end = size - 1
  } else {
    start = Number(m[1])
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1)
  }
  if (start >= size || end < start) return 'invalid'
  return { start, end }
}
