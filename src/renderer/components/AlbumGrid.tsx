// Virtualized album tile grid. Rows of N tiles where N follows the container width. Give it
// `albums` (already loaded) or `query` (pages of 120 are fetched as they scroll into view, with
// skeleton tiles until they arrive — big libraries open instantly).

import { useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import type { AlbumRow } from '@shared/types'
import { LIB, type AlbumQuery, type AlbumsPage } from '@shared/ipc/library'
import { invoke } from '../lib/ipc'
import { cx } from '../lib/format'
import { useLib, useSetting } from '../state/library'
import { albumRoute, navigate, toast, useUi } from '../state/ui'
import { addToQueue, cmd, playNext, playQuery, usePlayer } from '../state/player'
import { setLiked } from '../state/favorites'
import { Artwork, showMenu } from './ui'
import { Icon } from './Icon'
import { HeartButton } from './Heart'
import { ScrollParent } from './TrackTable'

const GAP = 16
const PAGE = 120
/** Tile size presets (Settings → Appearance → Album art size). */
const TILE_MIN: Record<string, number> = { small: 140, medium: 176, large: 220 }

export function albumMenu(e: React.MouseEvent, a: AlbumRow): void {
  e.preventDefault()
  const ids = () => invoke<number[]>(LIB.trackIds, { albumId: a.id })
  const src = { kind: 'album' as const, id: String(a.id), title: a.title }
  showMenu(e, [
    { label: 'Play', icon: 'play', onClick: () => void playQuery({ albumId: a.id }, undefined, src) },
    { label: 'Shuffle', icon: 'shuffle', onClick: () => void playQuery({ albumId: a.id }, undefined, src, true) },
    { label: 'Play next', icon: 'queue', onClick: () => void ids().then(playNext) },
    { label: 'Add to queue', onClick: () => void ids().then(addToQueue) },
    { separator: true },
    a.liked
      ? { label: 'Remove from Favorites', icon: 'heart', onClick: () => void setLiked({ kind: 'album', ids: [a.id] }, false) }
      : { label: 'Add to Favorites', icon: 'heart', onClick: () => void setLiked({ kind: 'album', ids: [a.id] }, true) },
    {
      label: 'Add to playlist',
      icon: 'playlist',
      submenu: [
        { label: 'New playlist…', icon: 'plus', onClick: () => void ids().then((x) => window.dispatchEvent(new CustomEvent('valence:new-playlist', { detail: x }))) },
        ...(useLib.getState().playlists.some((p) => p.kind !== 'smart') ? [{ separator: true }] : []),
        ...useLib
          .getState()
          .playlists.filter((p) => p.kind !== 'smart')
          .map((p) => ({
            label: p.name,
            onClick: () =>
              void ids()
                .then((x) => invoke(LIB.addToPlaylist, p.id, x))
                .then(() => toast(`Added to “${p.name}”`, 'ok')),
          })),
      ],
    },
    { separator: true },
    { label: 'View artwork', icon: 'zoomIn', onClick: () => useUi.getState().openArt({ hash: a.artHash, albumId: a.id, title: a.title, sub: a.albumArtist }) },
    { label: 'Get Info', icon: 'info', onClick: () => void ids().then((x) => useUi.getState().openGetInfo(x)) },
    { label: 'Go to artist', icon: 'artists', onClick: () => navigate({ view: 'artist', artist: a.albumArtist }) },
  ])
}

export function AlbumTile({ a, sub }: { a: AlbumRow; sub?: ReactNode }) {
  const isCurrent = usePlayer((s) => s.state?.current?.albumKey === `a${a.id}`)
  const playing = usePlayer((s) => isCurrent && !!s.state?.playing)
  return (
    <div className={cx('tile', isCurrent && 'playing')} onClick={() => navigate(albumRoute(a.id, a.hqRip))} onContextMenu={(e) => albumMenu(e, a)}>
      <div className="tile-art">
        <Artwork hash={a.artHash} px={300} title={a.title} />
        <HeartButton className="tile-heart" target={{ kind: 'album', id: a.id }} liked={a.liked} size={15} />
        <button
          className="tile-play"
          title={playing ? 'Pause' : `Play ${a.title}`}
          onClick={(e) => {
            e.stopPropagation()
            if (isCurrent) cmd({ type: 'toggle' })
            else void playQuery({ albumId: a.id }, undefined, { kind: 'album', id: String(a.id), title: a.title })
          }}
        >
          <Icon name={playing ? 'pause' : 'play'} size={20} />
        </button>
      </div>
      <div className="tile-title ellipsis" title={a.title}>
        {a.title}
      </div>
      <div className="tile-sub">{sub ?? a.albumArtist}</div>
    </div>
  )
}

function SkeletonTile() {
  return (
    <div className="tile skeleton-tile" aria-hidden>
      <div className="tile-art skeleton" />
      <div className="skeleton skeleton-line" style={{ width: '70%', marginTop: 12 }} />
      <div className="skeleton skeleton-line" style={{ width: '45%', marginTop: 8 }} />
    </div>
  )
}

/** Pages of an album query, fetched on demand; resets when the query or the library changes. */
function useAlbumPages(query: AlbumQuery | undefined): { ready: boolean; total: number; get: (i: number) => AlbumRow | undefined; need: (from: number, to: number) => void } {
  const version = useLib((s) => s.version)
  const key = JSON.stringify(query ?? null)
  const [, bump] = useState(0)
  const st = useRef({ key: '', version: -1, total: 0, pages: new Map<number, AlbumRow[]>(), loading: new Set<number>(), stale: new Set<number>() })
  const s = st.current
  if (s.key !== key) {
    s.key = key
    s.version = version
    s.total = 0
    s.pages = new Map()
    s.loading = new Set()
    s.stale = new Set()
  } else if (s.version !== version) {
    // Keep showing what we have; refetch pages as they're needed.
    s.version = version
    s.stale = new Set(s.pages.keys())
  }
  const load = (p: number) => {
    if (!query || s.loading.has(p) || (s.pages.has(p) && !s.stale.has(p))) return
    s.loading.add(p)
    const k = s.key
    void invoke<AlbumsPage>(LIB.albumsPage, { ...query, offset: p * PAGE, limit: PAGE }).then(
      (r) => {
        if (st.current.key !== k) return
        s.loading.delete(p)
        s.stale.delete(p)
        s.pages.set(p, r.rows)
        s.total = r.total
        bump((n) => n + 1)
      },
      () => s.loading.delete(p),
    )
  }
  useEffect(() => {
    load(0)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, version])
  return {
    ready: s.pages.has(0),
    total: s.total || (s.pages.get(0)?.length ?? 0),
    get: (i) => s.pages.get(Math.floor(i / PAGE))?.[i % PAGE],
    need: (from, to) => {
      for (let p = Math.floor(from / PAGE); p <= Math.floor(Math.max(from, to) / PAGE); p++) load(p)
    },
  }
}

export function AlbumGrid({ albums, query, header, subtitle, loading }: { albums?: AlbumRow[]; query?: AlbumQuery; header?: ReactNode; subtitle?: (a: AlbumRow) => ReactNode; loading?: boolean }) {
  const scrollRef = useContext(ScrollParent)
  const bodyRef = useRef<HTMLDivElement>(null)
  const [size] = useSetting<string>('ui.tileSize', 'medium')
  const [width, setWidth] = useState(800)
  const [margin, setMargin] = useState(0)
  const pages = useAlbumPages(albums ? undefined : query)
  const count = albums ? albums.length : pages.total
  const at = (i: number) => (albums ? albums[i] : pages.get(i))

  useLayoutEffect(() => {
    const el = bodyRef.current
    const sp = scrollRef?.current
    if (!el || !sp) return
    const update = () => {
      setWidth(el.clientWidth)
      setMargin(el.getBoundingClientRect().top - sp.getBoundingClientRect().top + sp.scrollTop)
    }
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    ro.observe(sp)
    return () => ro.disconnect()
  }, [scrollRef, header])

  const minTile = TILE_MIN[size] ?? TILE_MIN.medium
  const cols = Math.max(2, Math.floor((width + GAP) / (minTile + GAP)))
  const tile = (width - GAP * (cols - 1)) / cols
  // Art + title + two lines of subtitle + the row gap.
  // Outlined card: art, then the title and one subtitle line inside the card.
  const rowH = Math.round(tile + 64 + GAP)
  const rows = Math.ceil(count / cols)
  const v = useVirtualizer({
    count: rows,
    getScrollElement: () => scrollRef?.current ?? null,
    estimateSize: () => rowH,
    overscan: 3,
    scrollMargin: margin,
  })
  useLayoutEffect(() => {
    v.measure()
  }, [rowH, v])

  const items = v.getVirtualItems()
  const first = items[0]?.index ?? 0
  const last = items[items.length - 1]?.index ?? 0
  useEffect(() => {
    if (!albums) pages.need(first * cols, (last + 1) * cols + cols * 4)
  })

  const style = useMemo(() => ({ gridTemplateColumns: `repeat(${cols}, ${tile}px)`, columnGap: GAP }), [cols, tile])
  const showSkeleton = albums ? !!loading && !albums.length : !pages.ready

  return (
    <>
      {header}
      <div ref={bodyRef} className="grid-body" style={{ height: showSkeleton ? undefined : v.getTotalSize() }}>
        {showSkeleton ? (
          <div className="grid-row static" style={style}>
            {Array.from({ length: cols * 2 }, (_, i) => (
              <SkeletonTile key={i} />
            ))}
          </div>
        ) : (
          items.map((r) => (
            <div key={r.key} className="grid-row" style={{ ...style, transform: `translateY(${r.start - margin}px)` }}>
              {Array.from({ length: Math.min(cols, count - r.index * cols) }, (_, k) => {
                const a = at(r.index * cols + k)
                return a ? <AlbumTile key={a.id} a={a} sub={subtitle?.(a)} /> : <SkeletonTile key={`s${k}`} />
              })}
            </div>
          ))
        )}
      </div>
    </>
  )
}
