// Thin MusicBrainz WS/2 client (JSON). Every request goes through the global serial limiter.

import { fetchJson, DAY, type HttpDeps } from './http'
import type { RateLimiter } from './limiter'
import { luceneEscape } from './util'
import { splitCredit } from '@shared/artist-credit'

export const MB_ROOT = 'https://musicbrainz.org/ws/2/'
export const VA_ID = '89ad4ac3-39f7-470e-963a-56509c546377'
export const RELEASE_INC = 'recordings+artist-credits+labels+release-groups+media+isrcs+genres+tags'

export interface MbArtistCredit { name: string; joinphrase?: string; artist: { id: string; name: string; 'sort-name'?: string } }
export interface MbTag { name: string; count?: number }
export interface MbReleaseGroup {
  id: string
  title?: string
  'primary-type'?: string | null
  'secondary-types'?: string[]
  'first-release-date'?: string
  genres?: MbTag[]
  tags?: MbTag[]
}
export interface MbTrack {
  id: string
  number?: string
  position: number
  title: string
  length?: number | null
  'artist-credit'?: MbArtistCredit[]
  recording?: { id: string; title?: string; length?: number | null; isrcs?: string[]; 'artist-credit'?: MbArtistCredit[]; video?: boolean }
}
export interface MbMedium { position: number; format?: string | null; title?: string; 'track-count': number; 'track-offset'?: number; tracks?: MbTrack[]; track?: MbTrack[] }
export interface MbRelease {
  id: string
  title: string
  status?: string | null
  date?: string
  country?: string | null
  barcode?: string | null
  disambiguation?: string
  score?: number
  'track-count'?: number
  'artist-credit'?: MbArtistCredit[]
  'release-group'?: MbReleaseGroup
  'label-info'?: Array<{ 'catalog-number'?: string | null; label?: { id?: string; name?: string } | null }>
  media?: MbMedium[]
  genres?: MbTag[]
  tags?: MbTag[]
  'cover-art-archive'?: { front?: boolean; artwork?: boolean }
}
export interface MbRecording {
  id: string
  score?: number
  title: string
  length?: number | null
  disambiguation?: string
  'artist-credit'?: MbArtistCredit[]
  isrcs?: string[]
  releases?: MbRelease[]
}

export function creditString(ac: MbArtistCredit[] | undefined): string {
  return (ac ?? []).map((c) => `${c.name}${c.joinphrase ?? ''}`).join('').trim()
}

export function creditSort(ac: MbArtistCredit[] | undefined): string {
  return (ac ?? []).map((c) => `${c.artist['sort-name'] ?? c.name}${c.joinphrase ?? ''}`).join('').trim()
}

export const creditNames = (ac: MbArtistCredit[] | undefined): string[] => (ac ?? []).map((c) => c.name)
export const creditIds = (ac: MbArtistCredit[] | undefined): string[] => (ac ?? []).map((c) => c.artist.id)

export interface MbClientOptions extends HttpDeps {
  limiter: RateLimiter
  userAgent: () => string
}

const phrase = (s: string) => `"${luceneEscape(s)}"`

export function createMbClient(o: MbClientOptions) {
  const get = <T>(path: string, signal?: AbortSignal) =>
    fetchJson<T>(o, `${MB_ROOT}${path}${path.includes('?') ? '&' : '?'}fmt=json`, {
      limiter: o.limiter,
      headers: { 'User-Agent': o.userAgent(), Accept: 'application/json' },
      ttlSec: 30 * DAY,
      notFoundTtlSec: 7 * DAY,
      signal,
    })
  const search = (entity: string, query: string, limit: number, signal?: AbortSignal) =>
    get<{ releases?: MbRelease[]; recordings?: MbRecording[] }>(`${entity}?query=${encodeURIComponent(query)}&limit=${limit}`, signal)

  return {
    release: (id: string, signal?: AbortSignal) => get<MbRelease>(`release/${id}?inc=${RELEASE_INC}`, signal),
    recording: (id: string, signal?: AbortSignal) =>
      get<MbRecording>(`recording/${id}?inc=releases+release-groups+media+artist-credits+isrcs`, signal),
    async releasesByBarcode(barcode: string, signal?: AbortSignal): Promise<MbRelease[]> {
      return (await search('release', `barcode:${luceneEscape(barcode)}`, 10, signal))?.releases ?? []
    },
    /** The isrc/ resource ignores inc=releases in JSON (and rejects release-groups), so search by ISRC instead. */
    async recordingsByIsrc(isrc: string, signal?: AbortSignal): Promise<MbRecording[]> {
      return (await search('recording', `isrc:${luceneEscape(isrc)}`, 10, signal))?.recordings ?? []
    },
    /** `tracks` filters on the total track count (used when the plain search misses the edition). */
    async searchReleases(album: string, artist: string | undefined, limit = 15, signal?: AbortSignal, tracks?: number): Promise<MbRelease[]> {
      const q = `release:${phrase(album)}${artist ? ` AND artist:${phrase(artist)}` : ''}${tracks ? ` AND tracks:${tracks}` : ''}`
      return (await search('release', q, limit, signal))?.releases ?? []
    },
    async searchRecordings(title: string, artist: string | undefined, limit = 15, signal?: AbortSignal): Promise<MbRecording[]> {
      const names = splitCredit(artist).slice(0, 3)
      const a = names.length > 1 ? ` AND (${names.map((n) => `artist:${phrase(n)}`).join(' OR ')})` : artist ? ` AND artist:${phrase(artist)}` : ''
      return (await search('recording', `recording:${phrase(title)}${a}`, limit, signal))?.recordings ?? []
    },
  }
}

export type MbClient = ReturnType<typeof createMbClient>
