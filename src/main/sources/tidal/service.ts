// IPC-facing TIDAL operations (browse with in-library badges, enqueueing downloads). Electron-free;
// index.ts binds these to channels.

import type {
  TidalAlbumDetail,
  TidalArtistDetail,
  TidalDownloadRequest,
  TidalDownloadResult,
  TidalFavoriteKind,
  TidalLink,
  TidalPageResult,
  TidalPlaylistDetail,
  TidalPlaylistDownloadResult,
  TidalQueueState,
  TidalSearchResult,
  TidalSearchType,
  TidalStatus,
  TidalTrackSummary,
} from '@shared/ipc/tidal'
import type { AppContext } from '../../context'
import { SourceError } from '../../import/source-types'
import type { TidalApi } from './api'
import { parseTidalLink } from './links'
import { fullTitle, mainArtists, mapAlbumTags, releaseKeys, toBadgeQueryAlbum, toBadgeQueryTrack } from './mapper'
import { joinCredit } from '@shared/artist-credit'
import { albumSummary, artistSummary, countBadge, playlistSummary, trackSummary } from './summaries'
import type { TidalAlbum, TidalArtist, TidalTrack } from './types'

export interface TidalAuthLike {
  status(): TidalStatus
  login(): Promise<TidalStatus>
  logout(): void
}

export interface TidalServiceDeps {
  ctx: AppContext
  auth: TidalAuthLike
  api: TidalApi
  /** Called after login/logout (e.g. to clear the browse cache). */
  onSessionChange?: (s: TidalStatus) => void
}

const NUMERIC = /^\d{1,12}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const SEARCH_TYPES: TidalSearchType[] = ['ARTISTS', 'ALBUMS', 'TRACKS', 'PLAYLISTS']

function numericId(id: unknown, what: string): string {
  const s = String(id ?? '').trim()
  if (!NUMERIC.test(s)) throw new SourceError(`Invalid TIDAL ${what} id: ${s}`, 'parse')
  return s
}

function playlistId(id: unknown): string {
  const s = String(id ?? '').trim()
  if (!UUID.test(s)) throw new SourceError(`Invalid TIDAL playlist id: ${s}`, 'parse')
  return s.toLowerCase()
}

const streamable = (t: TidalTrack) => t.streamReady !== false && t.allowStreaming !== false

export type TidalService = ReturnType<typeof createTidalService>

export function createTidalService(deps: TidalServiceDeps) {
  const { ctx, api, auth } = deps
  const keys = () => ctx.imports.activeKeys()

  const albumQueue = (a: TidalAlbum, k: Map<string, TidalQueueState>) => k.get(`tidal:album:${a.id}`) ?? (a.upc ? k.get(`upc:${a.upc}`) : undefined)
  const trackQueue = (t: TidalTrack, k: Map<string, TidalQueueState>) =>
    k.get(`tidal:track:${t.id}`) ?? (t.album ? k.get(`tidal:album:${t.album.id}`) : undefined)

  function albums(list: TidalAlbum[]) {
    const badges = ctx.library.albumBadges(list.map((a) => toBadgeQueryAlbum(a)))
    const k = keys()
    return list.map((a, i) => albumSummary(a, badges[i], albumQueue(a, k)))
  }

  function tracks(list: TidalTrack[], album?: TidalAlbum) {
    const have = list.length ? ctx.library.matchTracks(list.map((t) => toBadgeQueryTrack(t, album))) : []
    const k = keys()
    return { have, items: list.map((t, i) => trackSummary(t, !!have[i], trackQueue(t, k))) }
  }

  function artists(list: TidalArtist[]) {
    const n = ctx.library.artistTracks?.(list.map((a) => a.name)) ?? []
    return list.map((a, i) => artistSummary(a, n[i] ?? 0))
  }

  const changed = () => {
    const s = auth.status()
    deps.onSessionChange?.(s)
    return s
  }

  return {
    status: (): TidalStatus => auth.status(),

    async login(): Promise<TidalStatus> {
      await auth.login()
      return changed()
    },

    logout(): TidalStatus {
      auth.logout()
      return changed()
    },

    async favorites(kind: TidalFavoriteKind, offset = 0, limit = 50): Promise<TidalPageResult<unknown>> {
      offset = Math.max(0, Math.floor(Number(offset) || 0))
      limit = Math.min(100, Math.max(1, Math.floor(Number(limit) || 50)))
      if (kind === 'playlists') {
        const all = await api.playlists()
        return { items: all.slice(offset, offset + limit).map((p) => playlistSummary(p)), offset, limit, total: all.length }
      }
      if (kind !== 'albums' && kind !== 'tracks' && kind !== 'artists') throw new SourceError(`Unknown favorites kind: ${kind}`, 'parse')
      const page = await api.favorites<any>(kind, offset, limit)
      const raw = (page.items ?? []).map((f) => f.item).filter(Boolean)
      const items = kind === 'albums' ? albums(raw) : kind === 'tracks' ? tracks(raw).items : artists(raw)
      return { items, offset: page.offset ?? offset, limit: page.limit ?? limit, total: page.totalNumberOfItems ?? items.length }
    },

    async search(query: string, types?: TidalSearchType[]): Promise<TidalSearchResult> {
      const q = String(query ?? '').trim()
      if (!q) return { artists: [], albums: [], tracks: [], playlists: [], topHit: null }
      const t = (types?.length ? types : SEARCH_TYPES).filter((x) => SEARCH_TYPES.includes(x))
      const r = await api.search(q, t.length ? t : SEARCH_TYPES)
      const hit = r.topHit
      const kind = hit ? ({ ARTISTS: 'artist', ALBUMS: 'album', TRACKS: 'track', PLAYLISTS: 'playlist' } as const)[hit.type as TidalSearchType] : undefined
      const hitId = hit?.value?.uuid ?? hit?.value?.id
      return {
        artists: artists(r.artists?.items ?? []),
        albums: albums(r.albums?.items ?? []),
        tracks: tracks(r.tracks?.items ?? []).items,
        playlists: (r.playlists?.items ?? []).map((p) => playlistSummary(p)),
        topHit: kind && hitId != null ? { kind, id: String(hitId) } : null,
      }
    },

    async album(id: string): Promise<TidalAlbumDetail> {
      const aid = numericId(id, 'album')
      const [album, list] = await Promise.all([api.album(aid), api.albumTracks(aid)])
      const t = tracks(list, album)
      const badge = ctx.library.albumBadge(toBadgeQueryAlbum(album, list))
      return { album: albumSummary(album, badge, albumQueue(album, keys())), tracks: t.items }
    },

    async artist(id: string): Promise<TidalArtistDetail> {
      const aid = numericId(id, 'artist')
      const [artist, main, eps, comps] = await Promise.all([
        api.artist(aid),
        api.artistAlbums(aid),
        api.artistAlbums(aid, 'EPSANDSINGLES'),
        api.artistAlbums(aid, 'COMPILATIONS'),
      ])
      return { artist: artists([artist])[0], albums: albums(main), epsAndSingles: albums(eps), compilations: albums(comps) }
    },

    async playlist(uuid: string): Promise<TidalPlaylistDetail> {
      const pid = playlistId(uuid)
      const [pl, list] = await Promise.all([api.playlist(pid), api.playlistTracks(pid)])
      const t = tracks(list)
      return { playlist: playlistSummary(pl, countBadge(t.have)), tracks: t.items }
    },

    async track(id: string): Promise<TidalTrackSummary> {
      const t = await api.track(numericId(id, 'track'))
      return tracks([t]).items[0]
    },

    resolveLink: (url: string): TidalLink | null => parseTidalLink(String(url ?? '')),

    async download(req: TidalDownloadRequest): Promise<TidalDownloadResult> {
      if (req?.kind === 'album') {
        const id = numericId(req.id, 'album')
        const album = await api.album(id)
        const tags = mapAlbumTags(album)
        const title = `TIDAL · ${tags.albumartist ?? 'Unknown Artist'} — ${tags.album}${req.onlyMissing ? ' (missing tracks)' : ''}`
        const rk = releaseKeys(album)
        const jobId = ctx.imports.enqueue({ source: 'tidal', title, releaseKeys: rk, payload: { kind: 'album', id, onlyMissing: !!req.onlyMissing } })
        return { jobId, title, releaseKeys: rk }
      }
      if (req?.kind === 'track') {
        const id = numericId(req.id, 'track')
        const track = await api.track(id)
        const title = `TIDAL · ${joinCredit(mainArtists(track.artists, track.artist))} — ${fullTitle(track.title, track.version)}`
        // Only the track key: an album key here would collide with sibling track jobs.
        const rk = [`tidal:track:${id}`]
        const jobId = ctx.imports.enqueue({ source: 'tidal', title, releaseKeys: rk, payload: { kind: 'track', id } })
        return { jobId, title, releaseKeys: rk }
      }
      throw new SourceError(`Unknown TIDAL download kind: ${String(req?.kind)}`, 'parse')
    },

    async downloadPlaylist(uuid: string): Promise<TidalPlaylistDownloadResult> {
      const pid = playlistId(uuid)
      const [pl, list] = await Promise.all([api.playlist(pid), api.playlistTracks(pid)])
      const queries = list.map((t) => toBadgeQueryTrack(t))
      const have = list.length ? ctx.library.matchTracks(queries) : []
      const active = keys()
      const res: TidalPlaylistDownloadResult = { queued: 0, alreadyInLibrary: 0, alreadyQueued: 0, unavailable: 0, jobIds: [] }
      const seen = new Set<string>()
      list.forEach((t, i) => {
        const id = String(t.id)
        if (seen.has(id)) return
        seen.add(id)
        if (have[i]) return void res.alreadyInLibrary++
        if (!streamable(t)) return void res.unavailable++
        if (active.has(`tidal:track:${id}`) || (t.album && active.has(`tidal:album:${t.album.id}`))) return void res.alreadyQueued++
        const title = `TIDAL · ${joinCredit(mainArtists(t.artists, t.artist))} — ${fullTitle(t.title, t.version)}`
        res.jobIds.push(ctx.imports.enqueue({ source: 'tidal', title, releaseKeys: [`tidal:track:${id}`], payload: { kind: 'track', id } }))
        res.queued++
      })
      ctx.playlists.mirror({ name: pl.title, sourceKey: `tidal:playlist:${pid}`, tracks: queries })
      return res
    },
  }
}
