// Single-genre selection restricted to the official MusicBrainz genre list.

import { cleanText } from '@shared/sanitize'
import genreList from '../../../resources/data/mb-genres.json'

const GENRES = new Set((genreList as string[]).map((g) => g.toLowerCase()))

const ACRONYMS = new Set(['uk', 'us', 'edm', 'idm', 'ebm', 'r&b', 'mpb', 'aor', 'asmr', 'nrg', 'opm', 'rkt', 'tbm', 'eai', 'c86', 'uk82', 'fm', 'mor', 'dj', 'mc', 'nyc'])
const MINOR = new Set(['and', 'of', 'the', 'in', 'on', 'de', 'del', 'da', 'do', 'du', 'des', 'la', 'le', 'y', 'e', 'en', 'à', 'for', 'n', "'n'", 'or', 'with', 'a'])

const norm = (s: string) => cleanText(s).toLowerCase().replace(/[‐-―]/g, '-')

export function isKnownGenre(name: string | undefined | null): boolean {
  return !!name && GENRES.has(norm(name))
}

/** Title Case for genre names: "drum and bass" → "Drum and Bass", "uk garage" → "UK Garage", "j-pop" → "J-Pop". */
export function genreTitleCase(name: string): string {
  const words = norm(name).split(' ')
  return words
    .map((w, i) => {
      if (ACRONYMS.has(w) && !(i > 0 && MINOR.has(w))) return w.toUpperCase()
      if (i > 0 && MINOR.has(w)) return w
      return w
        .split('-')
        .map((p) => (ACRONYMS.has(p) ? p.toUpperCase() : p.replace(/^(\p{L})/u, (c) => c.toUpperCase())))
        .join('-')
    })
    .join(' ')
}

const splitExisting = (s: string | undefined) =>
  cleanText(s)
    .split(/\s*[;,/|]\s*/)
    .map((x) => x.trim())
    .filter(Boolean)

/**
 * Most-voted genre among names in the MusicBrainz genre list (duplicates add up; ties prefer
 * `existing`, then first seen). Without a valid candidate, falls back to the first component of
 * `existing` (title-cased when it is a known genre).
 */
export function pickGenre(candidates: Array<{ name: string; count?: number }>, existing?: string): string | undefined {
  const totals = new Map<string, number>()
  for (const c of candidates) {
    const n = norm(c.name ?? '')
    if (!GENRES.has(n)) continue
    totals.set(n, (totals.get(n) ?? 0) + Math.max(0, c.count ?? 1))
  }
  const ex = splitExisting(existing)
  const exKeys = new Set(ex.map(norm))
  let best: string | undefined
  let bestN = -1
  for (const [n, count] of totals) {
    if (count > bestN || (count === bestN && exKeys.has(n) && !exKeys.has(best!))) {
      best = n
      bestN = count
    }
  }
  if (best) return genreTitleCase(best)
  const known = ex.find((e) => GENRES.has(norm(e)))
  if (known) return genreTitleCase(known)
  return ex[0]
}
