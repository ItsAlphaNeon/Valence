// TIDAL favorites: albums / tracks / playlists / artists, paged with infinite scroll.

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  TIDAL_IPC,
  type TidalAlbumSummary,
  type TidalArtistSummary,
  type TidalFavoriteKind,
  type TidalPageResult,
  type TidalPlaylistSummary,
  type TidalTrackSummary,
} from '@shared/ipc/tidal'
import { invoke } from '../../lib/ipc'
import { useLib } from '../../state/library'
import { Empty } from '../../components/ui'
import { CenterSpin, ErrorState, LoadMore } from './source-kit'
import { AlbumTile, ArtistTile, PlaylistTile, TidalTrackList } from './items'
import { tidalLogin } from './tidal-state'

const PAGE = 50
/** main clamps `limit` to 100 */
const REFRESH_PAGE = 100

type Item = TidalAlbumSummary | TidalTrackSummary | TidalPlaylistSummary | TidalArtistSummary

const idOf = (kind: TidalFavoriteKind, x: Item) => (kind === 'playlists' ? (x as TidalPlaylistSummary).uuid : (x as { id: string }).id)

interface PagerState {
  kind: TidalFavoriteKind
  items: Item[]
  total: number | null
  /** Raw TIDAL offset of the next page. Main drops entries without an item, so this can run ahead of items.length. */
  next: number
  done: boolean
  loading: boolean
  error: unknown
}

const fresh = (kind: TidalFavoriteKind): PagerState => ({ kind, items: [], total: null, next: 0, done: false, loading: true, error: null })

function dedupe(kind: TidalFavoriteKind, list: Item[]): Item[] {
  const ids = new Set<string>()
  return list.filter((x) => {
    const id = idOf(kind, x)
    if (ids.has(id)) return false
    ids.add(id)
    return true
  })
}

function useFavorites(kind: TidalFavoriteKind) {
  const [s, setS] = useState<PagerState>(() => fresh(kind))
  const seq = useRef(0)
  const cur = useRef(s)
  useLayoutEffect(() => {
    cur.current = s
  })

  const load = useCallback(
    (offset: number) => {
      const n = ++seq.current
      setS((p) => ({ ...(p.kind === kind && offset > 0 ? p : fresh(kind)), loading: true, error: null }))
      invoke<TidalPageResult<Item>>(TIDAL_IPC.favorites, kind, offset, PAGE).then(
        (r) => {
          if (n !== seq.current) return
          setS((p) => {
            const base = offset === 0 || p.kind !== kind ? [] : p.items
            const next = offset + PAGE
            return { kind, items: dedupe(kind, base.concat(r.items)), total: r.total, next, done: r.items.length === 0 || next >= r.total, loading: false, error: null }
          })
        },
        (error: unknown) => {
          if (n === seq.current) setS((p) => ({ ...(p.kind === kind ? p : fresh(kind)), loading: false, error }))
        },
      )
    },
    [kind],
  )

  useEffect(() => load(0), [load])

  // Imports finishing change badges: quietly re-read what is loaded (main caches these pages).
  const version = useLib((st) => st.version)
  const seen = useRef(version)
  useEffect(() => {
    if (version === seen.current) return
    seen.current = version
    const t = setTimeout(async () => {
      const { next, loading, kind: k, items } = cur.current
      if (!items.length || loading || k !== kind) return
      const n = ++seq.current
      try {
        const out: Item[] = []
        let total = cur.current.total ?? 0
        let off = 0
        for (; off < next; off += REFRESH_PAGE) {
          const r = await invoke<TidalPageResult<Item>>(TIDAL_IPC.favorites, kind, off, Math.min(REFRESH_PAGE, next - off))
          out.push(...r.items)
          total = r.total
          if (r.items.length === 0) break
        }
        if (n !== seq.current) return
        const end = Math.min(off, next)
        setS({ kind, items: dedupe(kind, out), total, next: end, done: end >= total, loading: false, error: null })
      } catch {
        /* keep what is shown */
      }
    }, 2000)
    return () => clearTimeout(t)
  }, [version, kind])

  const st = s.kind === kind ? s : fresh(kind)
  const hasMore = st.total != null && !st.done
  return { ...st, hasMore, more: () => load(st.next), retry: () => load(st.items.length ? st.next : 0) }
}

const NOUN: Record<TidalFavoriteKind, string> = { albums: 'albums', tracks: 'tracks', playlists: 'playlists', artists: 'artists' }
const EMPTY: Record<TidalFavoriteKind, { icon: 'albums' | 'songs' | 'playlist' | 'artists'; title: string; body: string }> = {
  albums: { icon: 'albums', title: 'No favorite albums', body: 'Albums you add to My Collection on TIDAL show up here.' },
  tracks: { icon: 'songs', title: 'No favorite tracks', body: 'Tracks you favorite on TIDAL show up here.' },
  playlists: { icon: 'playlist', title: 'No playlists', body: 'Your own and favorited TIDAL playlists show up here.' },
  artists: { icon: 'artists', title: 'No favorite artists', body: 'Artists you follow on TIDAL show up here.' },
}

export function Favorites({ kind }: { kind: TidalFavoriteKind }) {
  const f = useFavorites(kind)
  if (!f.items.length) {
    if (f.loading) return <CenterSpin label={`Loading your ${NOUN[kind]}…`} />
    if (f.error) return <ErrorState source="tidal" error={f.error} onRetry={f.retry} onLogin={() => void tidalLogin()} />
    const e = EMPTY[kind]
    return (
      <Empty icon={e.icon} title={e.title}>
        {e.body}
      </Empty>
    )
  }
  return (
    <>
      {kind === 'tracks' ? (
        <TidalTrackList tracks={f.items as TidalTrackSummary[]} mode="list" />
      ) : (
        <div className="src-grid">
          {kind === 'albums' && (f.items as TidalAlbumSummary[]).map((a) => <AlbumTile key={a.id} a={a} />)}
          {kind === 'playlists' && (f.items as TidalPlaylistSummary[]).map((p) => <PlaylistTile key={p.uuid} p={p} />)}
          {kind === 'artists' && (f.items as TidalArtistSummary[]).map((a) => <ArtistTile key={a.id} a={a} />)}
        </div>
      )}
      <LoadMore hasMore={f.hasMore} loading={f.loading} error={!!f.error} onMore={f.error ? f.retry : f.more} shown={f.items.length} total={f.total ?? undefined} noun={NOUN[kind]} />
    </>
  )
}
