// Field-by-field tag merge with provenance.

import type { TrackTags } from '@shared/types'
import { matchKey } from '@shared/sanitize'
import { isGarbageValue } from './heuristics'
import { isEmpty } from './util'

export type FieldSource = 'user' | 'source' | 'mb' | 'existing' | 'heuristic'
export type MergePolicy = 'source-first' | 'musicbrainz-first'

type Key = keyof TrackTags

/** Fields the store (TIDAL/Bandcamp) is authoritative for under source-first. */
export const SOURCE_FIELDS: Key[] = ['title', 'artist', 'artists', 'album', 'albumartist', 'albumartists', 'tracknumber', 'totaltracks', 'discnumber', 'totaldiscs', 'date', 'isrc', 'barcode', 'copyright', 'explicit', 'lyrics']
/** Fields MusicBrainz always provides when confident. */
export const MB_FIELDS: Key[] = ['musicbrainz_recordingid', 'musicbrainz_trackid', 'musicbrainz_albumid', 'musicbrainz_releasegroupid', 'musicbrainz_artistid', 'musicbrainz_albumartistid', 'releasetype', 'releasestatus', 'releasecountry', 'originaldate', 'genre']
/** Identity fields MB overrides under musicbrainz-first when confident. */
export const IDENTITY_FIELDS: Key[] = [...SOURCE_FIELDS.filter((k) => !['copyright', 'explicit', 'lyrics'].includes(k)), ...MB_FIELDS, 'label', 'catalognumber', 'media', 'artistsort', 'albumartistsort', 'titlesort', 'albumsort', 'compilation']

const GROUPS: Array<[Key, Key[]]> = [
  ['artist', ['artists', 'artistsort']],
  ['albumartist', ['albumartists', 'albumartistsort']],
  ['title', ['titlesort']],
  ['album', ['albumsort']],
]
const MEMBER_OF = new Map<Key, Key>(GROUPS.flatMap(([lead, ms]) => ms.map((m) => [m, lead] as [Key, Key])))

function order(key: Key, policy: MergePolicy, mbConfident: boolean): FieldSource[] {
  if (policy === 'source-first') {
    if (!mbConfident) return ['user', 'source', 'existing', 'mb', 'heuristic']
    return MB_FIELDS.includes(key) ? ['user', 'mb', 'source', 'existing', 'heuristic'] : ['user', 'source', 'mb', 'existing', 'heuristic']
  }
  if (mbConfident && IDENTITY_FIELDS.includes(key)) return ['user', 'mb', 'source', 'existing', 'heuristic']
  return ['user', 'source', 'existing', 'mb', 'heuristic']
}

/**
 * Merges tag layers. `user` always wins. Grouped fields (artists/artistsort follow artist, etc.) are
 * only taken from a layer whose lead value agrees with the chosen lead, so credits stay consistent.
 * Garbage values in the `existing` layer (URLs, "Unknown Artist", "Track 01") are ignored.
 */
export function mergeTags(
  layers: Partial<Record<FieldSource, TrackTags | null | undefined>>,
  policy: MergePolicy,
  mbConfident: boolean,
): { tags: TrackTags; provenance: Partial<Record<Key, FieldSource>> } {
  const val = (src: FieldSource, k: Key): unknown => {
    const v = layers[src]?.[k]
    if (isEmpty(v)) return undefined
    if (src === 'existing' && isGarbageValue(k, v)) return undefined
    return v
  }
  const keys = new Set<Key>()
  for (const l of Object.values(layers)) if (l) for (const k of Object.keys(l) as Key[]) keys.add(k)
  const tags: TrackTags = {}
  const provenance: Partial<Record<Key, FieldSource>> = {}
  const put = (k: Key, src: FieldSource, v: unknown) => {
    ;(tags as Record<string, unknown>)[k] = Array.isArray(v) ? [...v] : v
    provenance[k] = src
  }
  for (const k of keys) {
    if (MEMBER_OF.has(k)) continue
    const src = order(k, policy, mbConfident).find((s) => val(s, k) !== undefined)
    if (src) put(k, src, val(src, k))
  }
  for (const [lead, members] of GROUPS) {
    const leadSrc = provenance[lead]
    for (const m of members) {
      if (val('user', m) !== undefined) { put(m, 'user', val('user', m)); continue }
      if (!leadSrc) {
        const src = order(m, policy, mbConfident).find((s) => val(s, m) !== undefined)
        if (src) put(m, src, val(src, m))
        continue
      }
      const leadKey = matchKey(String(tags[lead]))
      const src = [leadSrc, ...order(m, policy, mbConfident)].find(
        (s) => val(s, m) !== undefined && (s === leadSrc || matchKey(String(val(s, lead) ?? '')) === leadKey),
      )
      if (src) put(m, src, val(src, m))
    }
  }
  return { tags, provenance }
}
