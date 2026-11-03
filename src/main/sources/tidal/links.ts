// Parses TIDAL web/app/share links (and bare ids) into { kind, id }.

import type { TidalLink, TidalLinkKind } from '@shared/ipc/tidal'

export type { TidalLink, TidalLinkKind }

const KINDS: Record<string, TidalLinkKind> = {
  album: 'album',
  albums: 'album',
  track: 'track',
  tracks: 'track',
  playlist: 'playlist',
  playlists: 'playlist',
  artist: 'artist',
  artists: 'artist',
  mix: 'mix',
  mixes: 'mix',
  video: 'video',
  videos: 'video',
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const NUMERIC = /^\d{1,12}$/
const MIX = /^[0-9a-z]{10,64}$/i
const HOST = /^(?:(?:www|listen|embed|desktop|play)\.)?tidal\.com$/i

function validId(kind: TidalLinkKind, id: string): boolean {
  if (kind === 'playlist') return UUID.test(id)
  if (kind === 'mix') return MIX.test(id)
  return NUMERIC.test(id)
}

/** Finds the deepest kind/id pair in path segments (e.g. album/1/track/2 → track 2). */
function fromSegments(segments: string[]): TidalLink | null {
  let found: TidalLink | null = null
  for (let i = 0; i < segments.length - 1; i++) {
    const kind = KINDS[segments[i].toLowerCase()]
    const id = segments[i + 1]
    if (kind && validId(kind, id)) found = { kind, id: kind === 'playlist' ? id.toLowerCase() : id }
  }
  return found
}

/**
 * Accepts tidal.com/browse/…, listen.tidal.com/…, tidal.com/{album|track}/…, share links (`?u`,
 * trailing `/u`), tidal:// app links, "album:123"-style shorthands, bare UUIDs (playlists) and
 * bare numeric ids (`bareKind`, default album).
 */
export function parseTidalLink(input: string, bareKind: TidalLinkKind = 'album'): TidalLink | null {
  const s = (input ?? '').trim()
  if (!s) return null

  if (UUID.test(s)) return { kind: 'playlist', id: s.toLowerCase() }
  if (NUMERIC.test(s)) return { kind: bareKind, id: s }

  // "tidal:album:123", "album:123", "track/123"
  const short = /^(?:tidal:)?(album|track|playlist|artist|mix|video)[:/]([^/?#\s]+)$/i.exec(s)
  if (short) {
    const kind = KINDS[short[1].toLowerCase()]
    return validId(kind, short[2]) ? { kind, id: kind === 'playlist' ? short[2].toLowerCase() : short[2] } : null
  }

  // tidal://album/123
  const app = /^tidal:\/\/(.+)$/i.exec(s)
  if (app) return fromSegments(app[1].split(/[?#]/)[0].split('/').filter(Boolean))

  let url: URL
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s}`)
  } catch {
    return null
  }
  if (!/^https?:$/.test(url.protocol) || !HOST.test(url.hostname)) return null
  const decode = (p: string) => {
    try {
      return decodeURIComponent(p)
    } catch {
      return p
    }
  }
  const segments = url.pathname.split('/').map(decode).filter(Boolean)
  return fromSegments(segments)
}
