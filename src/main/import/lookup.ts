// Get Info → "Look up on MusicBrainz": identify already-imported tracks and propose tag changes.
// Nothing is written here; the renderer shows the diff and applies it through library:editTags,
// which also re-paths files whose artist/album/title/year changed.

import type { IdentifyInput, IdentifyResult, MetadataService } from '@main/metadata'
import type { TrackLookupResult } from '@shared/ipc/import'
import type { TrackTags } from '@shared/types'

/** Fields a lookup may change. Ratings, lyrics, ReplayGain and Valence/source ids stay as they are. */
export const LOOKUP_FIELDS: Array<keyof TrackTags> = [
  'title', 'artist', 'artists', 'album', 'albumartist', 'albumartists', 'artistsort', 'albumartistsort',
  'tracknumber', 'totaltracks', 'discnumber', 'totaldiscs', 'date', 'originaldate', 'genre', 'compilation',
  'isrc', 'barcode', 'label', 'catalognumber', 'media',
  'musicbrainz_recordingid', 'musicbrainz_trackid', 'musicbrainz_albumid', 'musicbrainz_releasegroupid',
  'musicbrainz_artistid', 'musicbrainz_albumartistid', 'releasetype', 'releasestatus', 'releasecountry',
]

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)

function singleGenre(g: unknown): string | undefined {
  if (typeof g !== 'string' || !g.trim()) return undefined
  return g.split(/\s*(?:;|\/|,|\|)\s*/)[0].trim() || undefined
}

/** Per-track patches: only fields MusicBrainz supplies that differ from the file. */
export function proposeChanges(existing: TrackTags[], ident: IdentifyResult): Array<Partial<Record<keyof TrackTags, unknown>>> {
  if (ident.status === 'unmatched' || !ident.release) return existing.map(() => ({}))
  return existing.map((cur, k) => {
    const mb: TrackTags = { ...ident.albumTags, ...(ident.trackTags[k] ?? {}) }
    // A track MusicBrainz couldn't place on the release keeps its own title/number/recording ids.
    if (!ident.trackTags[k]) for (const f of ['title', 'artist', 'artists', 'tracknumber', 'isrc', 'musicbrainz_recordingid', 'musicbrainz_trackid', 'musicbrainz_artistid'] as const) delete mb[f]
    const genre = singleGenre(mb.genre)
    if (genre) mb.genre = genre
    else delete mb.genre
    const patch: Partial<Record<keyof TrackTags, unknown>> = {}
    for (const f of LOOKUP_FIELDS) {
      const v = mb[f]
      if (v == null || v === '' || (Array.isArray(v) && !v.length)) continue
      if (!same(v, cur[f])) patch[f] = v
    }
    return patch
  })
}

export interface LookupTrack {
  id: number
  relPath: string
  file: string
  tags: TrackTags
  durationMs: number
}

const ALBUM_FIELDS: Array<keyof TrackTags> = ['album', 'albumartist', 'albumartists', 'date', 'barcode', 'label', 'catalognumber', 'totaldiscs', 'musicbrainz_albumid', 'musicbrainz_releasegroupid']

export async function lookupTracks(metadata: MetadataService, tracks: LookupTrack[], releaseId?: string): Promise<TrackLookupResult> {
  // MusicBrainz matching expects release order.
  const order = tracks
    .map((t, i) => ({ t, i }))
    .sort((a, b) => (a.t.tags.discnumber ?? 1) - (b.t.tags.discnumber ?? 1) || (a.t.tags.tracknumber ?? 0) - (b.t.tags.tracknumber ?? 0) || a.i - b.i)
    .map((x) => x.t)
  const albumTags: TrackTags = {}
  for (const f of ALBUM_FIELDS) {
    const v = order[0]?.tags[f]
    if (v != null && order.every((t) => same(t.tags[f], v))) (albumTags as Record<string, unknown>)[f] = v
  }
  const input: IdentifyInput = {
    source: 'import',
    albumTags,
    tracks: order.map((t, k) => ({ index: k, tags: t.tags, durationMs: t.durationMs, relPath: t.relPath, file: t.file })),
  }
  const ident = releaseId ? await metadata.applyRelease(releaseId, input) : await metadata.identify(input)
  const patches = proposeChanges(order.map((t) => t.tags), ident)
  return {
    status: releaseId && ident.release ? 'auto' : ident.status,
    score: ident.score,
    release: ident.release,
    candidates: ident.candidates,
    changes: order.map((t, k) => ({ id: t.id, title: t.tags.title ?? t.relPath.split('/').pop() ?? '', patch: patches[k] })),
  }
}
