// Typed TIDAL endpoints on top of TidalClient.

import { SourceError } from '../../import/source-types'
import type { TidalClient } from './client'
import type {
  TidalAlbum,
  TidalArtist,
  TidalFavorite,
  TidalFolderPage,
  TidalLyrics,
  TidalPage,
  TidalPlaybackInfo,
  TidalPlaylist,
  TidalSearchResponse,
  TidalTrack,
} from './types'

export type FavoriteKind = 'albums' | 'tracks' | 'artists'
export type SearchType = 'ARTISTS' | 'ALBUMS' | 'TRACKS' | 'PLAYLISTS'
export type ArtistAlbumFilter = 'EPSANDSINGLES' | 'COMPILATIONS'

const PAGE = 100
const PLAYLIST_PAGE = 50
const MAX_ITEMS = 10_000

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Math.floor(Number(n) || 0)))

export class TidalApi {
  constructor(
    private readonly client: TidalClient,
    private readonly userId: () => string | null | undefined,
  ) {}

  private uid(): string {
    const u = this.userId()
    if (!u) throw new SourceError('Not logged in to TIDAL', 'auth')
    return u
  }

  favorites<T>(kind: FavoriteKind, offset = 0, limit = 50): Promise<TidalPage<TidalFavorite<T>>> {
    return this.client.get(
      `users/${this.uid()}/favorites/${kind}`,
      { limit: clamp(limit, 1, PAGE), offset: clamp(offset, 0, MAX_ITEMS), order: 'DATE', orderDirection: 'DESC' },
      { cache: true },
    )
  }

  favoriteAlbums(offset = 0, limit = 50) {
    return this.favorites<TidalAlbum>('albums', offset, limit)
  }

  favoriteTracks(offset = 0, limit = 50) {
    return this.favorites<TidalTrack>('tracks', offset, limit)
  }

  favoriteArtists(offset = 0, limit = 50) {
    return this.favorites<TidalArtist>('artists', offset, limit)
  }

  /** All of the user's own and favorited playlists (v2 folders, falling back to v1), deduped by uuid. */
  async playlists(): Promise<TidalPlaylist[]> {
    try {
      return await this.playlistsV2()
    } catch (e) {
      if (e instanceof SourceError && ['auth', 'abuse', 'cancelled', 'rate-limit'].includes(e.kind)) throw e
      return this.playlistsV1()
    }
  }

  private async playlistsV2(): Promise<TidalPlaylist[]> {
    const seen = new Map<string, TidalPlaylist>()
    let cursor: string | undefined
    let offset = 0
    for (let page = 0; page < MAX_ITEMS / PLAYLIST_PAGE; page++) {
      const r = await this.client.get<TidalFolderPage>(
        'my-collection/playlists/folders',
        { folderId: 'root', includeOnly: 'PLAYLIST', offset, limit: PLAYLIST_PAGE, order: 'DATE', orderDirection: 'DESC', cursor },
        { base: 'v2', cache: true },
      )
      const items = r.items ?? []
      let added = 0
      for (const it of items) {
        const p = it.data
        if (p?.uuid && !seen.has(p.uuid)) {
          seen.set(p.uuid, p)
          added++
        }
      }
      // Stop on an empty page or one with nothing new (guards against an ignored offset).
      if (!items.length || !added) break
      if (r.totalNumberOfItems != null && seen.size >= r.totalNumberOfItems) break
      if (r.cursor) cursor = r.cursor
      else if (items.length < PLAYLIST_PAGE) break
      offset += items.length
    }
    return [...seen.values()]
  }

  private async playlistsV1(): Promise<TidalPlaylist[]> {
    const seen = new Map<string, TidalPlaylist>()
    for (let offset = 0; offset < MAX_ITEMS; ) {
      const r = await this.client.get<TidalPage<{ type?: string; created?: string; playlist: TidalPlaylist }>>(
        `users/${this.uid()}/playlistsAndFavoritePlaylists`,
        { limit: PLAYLIST_PAGE, offset, order: 'DATE', orderDirection: 'DESC' },
        { cache: true },
      )
      const items = r.items ?? []
      let added = 0
      for (const it of items) {
        if (it.playlist?.uuid && !seen.has(it.playlist.uuid)) {
          seen.set(it.playlist.uuid, it.playlist)
          added++
        }
      }
      offset += items.length
      if (!items.length || !added || offset >= (r.totalNumberOfItems ?? 0)) break
    }
    return [...seen.values()]
  }

  search(query: string, types: SearchType[] = ['ARTISTS', 'ALBUMS', 'TRACKS', 'PLAYLISTS'], limit = 25): Promise<TidalSearchResponse> {
    return this.client.get('search', { query, types: types.join(','), limit: clamp(limit, 1, 300) }, { cache: true })
  }

  /** Fetches every page of a v1 paged collection. */
  private async all<T>(path: string, params: Record<string, string> = {}, signal?: AbortSignal): Promise<T[]> {
    const out: T[] = []
    for (let offset = 0; offset < MAX_ITEMS; ) {
      const r = await this.client.get<TidalPage<T>>(path, { ...params, limit: PAGE, offset }, { cache: true, signal })
      const items = r.items ?? []
      out.push(...items)
      offset += items.length
      const total = r.totalNumberOfItems
      if (!items.length || (total != null ? offset >= total : items.length < PAGE)) break
    }
    return out
  }

  album(id: string | number, signal?: AbortSignal): Promise<TidalAlbum> {
    return this.client.get(`albums/${id}`, {}, { cache: true, signal })
  }

  albumTracks(id: string | number, signal?: AbortSignal): Promise<TidalTrack[]> {
    return this.all(`albums/${id}/tracks`, {}, signal)
  }

  artist(id: string | number): Promise<TidalArtist> {
    return this.client.get(`artists/${id}`, {}, { cache: true })
  }

  artistAlbums(id: string | number, filter?: ArtistAlbumFilter): Promise<TidalAlbum[]> {
    return this.all(`artists/${id}/albums`, filter ? { filter } : {})
  }

  playlist(uuid: string): Promise<TidalPlaylist> {
    return this.client.get(`playlists/${uuid}`, {}, { cache: true })
  }

  playlistTracks(uuid: string): Promise<TidalTrack[]> {
    return this.all(`playlists/${uuid}/tracks`)
  }

  track(id: string | number, signal?: AbortSignal): Promise<TidalTrack> {
    return this.client.get(`tracks/${id}`, {}, { cache: true, signal })
  }

  /** Lyrics, or null when TIDAL has none for the track. */
  async lyrics(id: string | number, signal?: AbortSignal): Promise<TidalLyrics | null> {
    try {
      return await this.client.get<TidalLyrics>(`tracks/${id}/lyrics`, {}, { cache: true, signal })
    } catch (e) {
      if (e instanceof SourceError && e.kind === 'unavailable') return null
      throw e
    }
  }

  /** Stream manifest; never cached (URLs are short-lived). */
  playbackInfo(id: string | number, quality = 'LOSSLESS', signal?: AbortSignal): Promise<TidalPlaybackInfo> {
    return this.client.get(
      `tracks/${id}/playbackinfopostpaywall`,
      { playbackmode: 'STREAM', audioquality: quality, assetpresentation: 'FULL' },
      { signal },
    )
  }
}
