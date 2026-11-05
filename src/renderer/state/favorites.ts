// Favorites ("Liked"): tracks, albums and artists. The main process keeps them in synced per-device
// logs; here we toggle them optimistically and keep the lists the library panel shows.

import { create } from 'zustand'
import { LIB, type SetLikedRequest } from '@shared/ipc/library'
import type { AlbumRow, ArtistRow, FavoriteCounts } from '@shared/types'
import { errorMessage, invoke } from '../lib/ipc'
import { onFavoritesChanged } from './library'
import { toast } from './ui'

/** Which favorites the Favorites page shows: normal music or SiivaGunner rips. */
export type FavSide = 'main' | 'rips'
const SIDE_KEY = 'valence.favorites.side'
const NONE: FavoriteCounts = { tracks: 0, albums: 0, artists: 0 }

function loadSide(): FavSide {
  try {
    return localStorage.getItem(SIDE_KEY) === 'rips' ? 'rips' : 'main'
  } catch {
    return 'main'
  }
}

interface FavState {
  /** Every collection (sidebar count). */
  counts: FavoriteCounts
  /** Each side of the Favorites switch. */
  sides: Record<FavSide, FavoriteCounts>
  side: FavSide
  albums: AlbumRow[]
  artists: ArtistRow[]
  /** Optimistic values by `t:<id>`, `a:<id>`, `r:<name>` until the library catches up. */
  pending: Record<string, boolean>
}

export const useFavorites = create<FavState>(() => ({
  counts: NONE,
  sides: { main: NONE, rips: NONE },
  side: loadSide(),
  albums: [],
  artists: [],
  pending: {},
}))

const artistKey = (name: string) => `r:${name.normalize('NFC').trim().toLowerCase()}`

let refreshing: Promise<void> | null = null
export function refreshFavorites(): Promise<void> {
  refreshing ??= Promise.all([
    invoke<FavoriteCounts>(LIB.favoriteCounts).catch(() => null),
    invoke<AlbumRow[]>(LIB.albums, { liked: true, limit: 200 }).catch(() => null),
    invoke<ArtistRow[]>(LIB.artists, { liked: true }).catch(() => null),
    invoke<FavoriteCounts>(LIB.favoriteCounts, 'main').catch(() => null),
    invoke<FavoriteCounts>(LIB.favoriteCounts, 'rips').catch(() => null),
  ]).then(([counts, albums, artists, main, rips]) => {
    refreshing = null
    useFavorites.setState((s) => ({
      counts: counts ?? s.counts,
      albums: albums ?? s.albums,
      artists: artists ?? s.artists,
      sides: { main: main ?? s.sides.main, rips: rips ?? s.sides.rips },
    }))
  })
  return refreshing
}

/** Flip the Favorites page between normal music and SiivaGunner rips (remembered on this computer). */
export function setFavSide(side: FavSide): void {
  useFavorites.setState({ side })
  try {
    localStorage.setItem(SIDE_KEY, side)
  } catch {
    /* private storage */
  }
}

export function initFavorites(): void {
  void refreshFavorites()
  onFavoritesChanged(() => void refreshFavorites())
}

function setPending(keys: string[], liked: boolean): void {
  useFavorites.setState((s) => {
    const pending = { ...s.pending }
    for (const k of keys) pending[k] = liked
    return { pending }
  })
  // The library refresh lands within a second; drop the overrides after that.
  setTimeout(() => {
    useFavorites.setState((s) => {
      const pending = { ...s.pending }
      for (const k of keys) if (pending[k] === liked) delete pending[k]
      return { pending }
    })
  }, 2500)
}

export async function setLiked(req: SetLikedRequest, liked: boolean, opts: { quiet?: boolean } = {}): Promise<void> {
  const keys = req.kind === 'artist' ? req.names.map(artistKey) : req.ids.map((id) => `${req.kind === 'track' ? 't' : 'a'}:${id}`)
  setPending(keys, liked)
  try {
    await invoke(LIB.setLiked, req, liked)
    if (!opts.quiet) {
      const n = req.kind === 'artist' ? req.names.length : req.ids.length
      const what = req.kind === 'track' ? (n === 1 ? 'Favorites' : `Favorites (${n})`) : req.kind === 'album' ? 'your favorite albums' : 'your favorite artists'
      toast(liked ? `Added to ${what}` : `Removed from ${what}`, 'ok')
    }
  } catch (e) {
    setPending(keys, !liked)
    toast(errorMessage(e), 'error')
  }
}

/** Liked state with any pending toggle applied. */
export function useLiked(kind: 'track' | 'album', id: number | null | undefined, server: boolean | undefined): boolean
export function useLiked(kind: 'artist', name: string | null | undefined, server: boolean | undefined): boolean
export function useLiked(kind: 'track' | 'album' | 'artist', id: number | string | null | undefined, server: boolean | undefined): boolean {
  const key = id == null ? '' : kind === 'artist' ? artistKey(String(id)) : `${kind === 'track' ? 't' : 'a'}:${id}`
  const p = useFavorites((s) => (key ? s.pending[key] : undefined))
  const listed = useFavorites((s) =>
    server !== undefined || !key ? false : kind === 'album' ? s.albums.some((a) => a.id === id) : kind === 'artist' ? s.artists.some((a) => artistKey(a.name) === key) : false,
  )
  if (p !== undefined) return p
  return server ?? listed
}

export const toggleTrack = (id: number, liked: boolean) => setLiked({ kind: 'track', ids: [id] }, !liked)
export const toggleAlbum = (id: number, liked: boolean) => setLiked({ kind: 'album', ids: [id] }, !liked)
export const toggleArtist = (name: string, liked: boolean) => setLiked({ kind: 'artist', names: [name] }, !liked)
