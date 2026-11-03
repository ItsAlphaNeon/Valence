// Determines the primary artist of a credit string. Structured credits (MusicBrainz artist-credit,
// TIDAL artists[], Bandcamp band) are authoritative; free-text credits are only split on joiners
// that never appear inside a real artist name, so duos like "Kaos & Ethos" survive.

import { cleanText } from './sanitize'

const FEAT = /\s+(?:feat\.?|ft\.?|featuring|with)\s+/i
const SEMI = /\s*;\s*/
const X_JOIN = /\s+x\s+/i
const VS = /\s+vs\.?\s+/i
const COMMA = /\s*,\s*/

// Real names that contain commas.
const COMMA_NAMES = [
  'tyler, the creator',
  'earth, wind & fire',
  'crosby, stills, nash & young',
  'crosby, stills & nash',
  'emerson, lake & palmer',
  'peter, paul and mary',
  'blood, sweat & tears',
  'me, myself and i',
]

export const VARIOUS_ARTISTS = 'Various Artists'

export function isVariousArtists(name: string | undefined | null): boolean {
  const n = cleanText(name).toLowerCase()
  return n === 'various artists' || n === 'various' || n === 'va' || n === 'v.a.' || n === 'verschiedene interpreten'
}

/** Splits a free-text credit into its member artists using only unambiguous joiners. */
export function splitCredit(credit: string | undefined | null): string[] {
  const s = cleanText(credit)
  if (!s) return []
  const lower = s.toLowerCase()
  const protectedName = COMMA_NAMES.find((n) => lower.startsWith(n))
  let parts: string[] = [s]
  for (const re of [FEAT, SEMI, X_JOIN, VS]) parts = parts.flatMap((p) => p.split(re))
  parts = parts.flatMap((p) => {
    if (protectedName && p.toLowerCase().startsWith(protectedName)) {
      const rest = p.slice(protectedName.length).replace(/^\s*,\s*/, '')
      return rest ? [p.slice(0, protectedName.length), ...rest.split(COMMA)] : [p]
    }
    return p.split(COMMA)
  })
  return parts.map((p) => p.trim()).filter(Boolean)
}

/** Primary (first credited) artist; structured member lists win over string parsing. */
export function primaryArtist(credit: string | undefined | null, structured?: string[] | null): string {
  const first = structured?.map((a) => cleanText(a)).find(Boolean)
  if (first) return first
  return splitCredit(credit)[0] ?? cleanText(credit)
}

/** Joins artist names into a display credit like "A, B & C". */
export function joinCredit(names: string[]): string {
  const clean = names.map((n) => cleanText(n)).filter(Boolean)
  if (clean.length <= 1) return clean[0] ?? ''
  return `${clean.slice(0, -1).join(', ')} & ${clean[clean.length - 1]}`
}
