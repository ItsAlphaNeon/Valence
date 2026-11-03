// Path templates. Syntax: {token} inserts a value; [ ... ] is an optional group that is dropped
// entirely when any token inside it is empty; "/" separates folders. The last segment is the
// file stem (extension is appended by the caller).

import type { TrackTags } from './types'
import { MAX_REL_PATH, safeTopLevel, sanitizeComponent } from './sanitize'
import { VARIOUS_ARTISTS, isVariousArtists, primaryArtist } from './artist-credit'

export const DEFAULT_TEMPLATE = '{albumartist_primary}/{album}[ ({year})]/{title}'

export type TemplateVars = Record<string, string | undefined>

export function yearOf(date: string | undefined | null): string | undefined {
  const m = date?.match(/^(\d{4})/)
  return m?.[1]
}

/** Builds the template variables for a track's tags. */
export function templateVars(tags: TrackTags): TemplateVars {
  const compilation = tags.compilation || isVariousArtists(tags.albumartist)
  const trackArtist = tags.artist || tags.albumartist || 'Unknown Artist'
  const albumArtist = compilation ? VARIOUS_ARTISTS : tags.albumartist || trackArtist
  const primary = compilation ? VARIOUS_ARTISTS : primaryArtist(albumArtist, tags.albumartists)
  const hasAlbum = !!tags.album?.trim()
  return {
    albumartist: albumArtist,
    albumartist_primary: primary || 'Unknown Artist',
    artist: trackArtist,
    // Album-less tracks are filed like a single named after the track.
    album: hasAlbum ? tags.album : tags.title || 'Unknown Album',
    year: yearOf(tags.date) ?? yearOf(tags.originaldate),
    title: tags.title || 'Untitled',
    disc: tags.discnumber ? String(tags.discnumber) : undefined,
    track: tags.tracknumber ? String(tags.tracknumber).padStart(2, '0') : undefined,
    genre: tags.genre,
  }
}

/** Renders a template to raw (unsanitized) path segments. */
export function renderSegments(template: string, vars: TemplateVars): string[] {
  const fill = (s: string): { text: string; missing: boolean } => {
    let missing = false
    const text = s.replace(/\{(\w+)\}/g, (_, key: string) => {
      const v = vars[key]
      if (v === undefined || v === '') missing = true
      return v ?? ''
    })
    return { text, missing }
  }
  // Single pass so values that happen to contain "{x}" are never re-substituted.
  let out = ''
  for (const m of template.matchAll(/\[([^\]]*)\]|([^[]+)/g)) {
    if (m[1] !== undefined) {
      const r = fill(m[1])
      if (!r.missing) out += r.text
    } else out += fill(m[2]).text
  }
  return out.split('/')
}

/** Renders a template into a sanitized relative path stem (without extension), "/"-separated. */
export function renderRelStem(template: string, tags: TrackTags): string {
  const vars = templateVars(tags)
  // Values may contain "/" (e.g. "AC/DC"); escape them before splitting on template slashes.
  const safeVars: TemplateVars = {}
  for (const [k, v] of Object.entries(vars)) safeVars[k] = v?.replace(/\//g, '\u0001')
  const segments = renderSegments(template, safeVars).map((s) => s.replace(/\u0001/g, '/'))
  let parts = segments.map((s) => sanitizeComponent(s)).filter((s) => s !== '')
  if (parts.length === 0) parts = ['_']
  if (parts.length > 1) parts[0] = safeTopLevel(parts[0])
  return fitLength(parts).join('/')
}

/** Shrinks the longest components until the relative path fits MAX_REL_PATH (+ room for ext). */
export function fitLength(parts: string[], budget = MAX_REL_PATH - 6): string[] {
  const out = [...parts]
  const total = () => out.reduce((n, p) => n + p.length, 0) + out.length - 1
  while (total() > budget) {
    let longest = 0
    for (let i = 1; i < out.length; i++) if (out[i].length > out[longest].length) longest = i
    if (out[longest].length <= 12) break
    out[longest] = sanitizeComponent(out[longest], out[longest].length - Math.max(1, Math.min(8, total() - budget)))
  }
  return out
}
