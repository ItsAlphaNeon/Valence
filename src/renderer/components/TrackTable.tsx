// Virtualized track list. Either `rows` (album/playlist) or a paged `query` (Songs: 50k+ rows are
// fetched 300 at a time as they scroll into view).

import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import type { TrackQuery, TrackRow } from '@shared/types'
import { LIB } from '@shared/ipc/library'
import type { QueueSource } from '../audio'
import { invoke, revealLabel } from '../lib/ipc'
import { cx, duration, quality, relativeTime } from '../lib/format'
import { useLib } from '../state/library'
import { addToQueue, cmd, playQuery, playNext, playTracks, usePlayer } from '../state/player'
import { setLiked } from '../state/favorites'
import { Artwork, IconButton, Stars, showMenu, type MenuItem } from './ui'
import { Icon } from './Icon'
import { HeartButton } from './Heart'
import { albumRoute, navigate, toast, useUi } from '../state/ui'

export const ScrollParent = createContext<React.RefObject<HTMLElement | null> | null>(null)

export type ColumnKey =
  | 'index' | 'title' | 'artist' | 'album' | 'albumArtist' | 'time' | 'genre' | 'year' | 'rating' | 'plays' | 'added' | 'lastPlayed' | 'quality'
  | 'game' | 'composer' | 'heart' | 'likedAt'

interface Column {
  key: ColumnKey
  label: string
  width: string
  sort?: keyof TrackRow
  align?: 'right' | 'center'
}

const COLUMNS: Record<ColumnKey, Column> = {
  index: { key: 'index', label: '#', width: '40px', align: 'right', sort: 'trackNo' },
  heart: { key: 'heart', label: '', width: '40px', align: 'center', sort: 'likedAt' },
  title: { key: 'title', label: 'Title', width: 'minmax(180px, 3fr)', sort: 'title' },
  artist: { key: 'artist', label: 'Artist', width: 'minmax(120px, 2fr)', sort: 'artist' },
  album: { key: 'album', label: 'Album', width: 'minmax(120px, 2fr)', sort: 'album' },
  albumArtist: { key: 'albumArtist', label: 'Album Artist', width: 'minmax(120px, 1.5fr)', sort: 'albumArtist' },
  time: { key: 'time', label: 'Time', width: '64px', align: 'right', sort: 'durationMs' },
  genre: { key: 'genre', label: 'Genre', width: 'minmax(90px, 1fr)', sort: 'genre' },
  game: { key: 'game', label: 'Game', width: 'minmax(120px, 2fr)', sort: 'ripGame' },
  composer: { key: 'composer', label: 'Composer', width: 'minmax(110px, 1.5fr)', sort: 'composer' },
  year: { key: 'year', label: 'Year', width: '56px', align: 'right', sort: 'year' },
  rating: { key: 'rating', label: 'Rating', width: '86px', sort: 'rating' },
  plays: { key: 'plays', label: 'Plays', width: '56px', align: 'right', sort: 'playCount' },
  added: { key: 'added', label: 'Added', width: '96px', sort: 'addedAt' },
  likedAt: { key: 'likedAt', label: 'Added to Favorites', width: '136px', sort: 'likedAt' },
  lastPlayed: { key: 'lastPlayed', label: 'Last Played', width: '104px', sort: 'lastPlayed' },
  quality: { key: 'quality', label: 'Format', width: '104px', sort: 'bitrate' },
}

const PAGE = 300

function useTrackPages(query: TrackQuery | undefined, version: number) {
  const [total, setTotal] = useState(0)
  const [, force] = useState(0)
  const pages = useRef(new Map<number, TrackRow[]>())
  const loading = useRef(new Set<number>())
  const key = JSON.stringify(query ?? null)
  const gen = useRef(0)
  const lastKey = useRef<string | null>(null)
  useEffect(() => {
    if (!query) return
    const g = ++gen.current
    // A new query starts over; a library change refreshes loaded pages in place (no flash).
    const fresh = lastKey.current !== key
    lastKey.current = key
    loading.current.clear()
    const want = fresh || !pages.current.size ? [0] : [...pages.current.keys()]
    if (fresh) pages.current = new Map()
    for (const p of want) {
      loading.current.add(p)
      void invoke<{ rows: TrackRow[]; total: number }>(LIB.tracks, { ...query, limit: PAGE, offset: p * PAGE }).then((r) => {
        if (g !== gen.current) return
        loading.current.delete(p)
        pages.current.set(p, r.rows)
        setTotal(r.total)
        force((n) => n + 1)
      })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, version])
  const ensure = useCallback(
    (start: number, end: number) => {
      if (!query) return
      for (let p = Math.floor(start / PAGE); p <= Math.floor(end / PAGE); p++) {
        if (pages.current.has(p) || loading.current.has(p)) continue
        loading.current.add(p)
        const g = gen.current
        void invoke<{ rows: TrackRow[]; total: number }>(LIB.tracks, { ...query, limit: PAGE, offset: p * PAGE }).then((r) => {
          if (g !== gen.current) return
          loading.current.delete(p)
          pages.current.set(p, r.rows)
          force((n) => n + 1)
        })
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key],
  )
  const get = (i: number): TrackRow | undefined => pages.current.get(Math.floor(i / PAGE))?.[i % PAGE]
  return { total, get, ensure }
}

export interface TrackTableProps {
  rows?: TrackRow[]
  query?: TrackQuery
  columns: ColumnKey[]
  source: QueueSource
  /** Sorting for query mode is controlled by the parent. */
  sort?: TrackQuery['sort']
  onSort?: (s: TrackQuery['sort']) => void
  playlistId?: string
  /** Show disc headers between discs (album view). */
  discHeaders?: boolean
  showArt?: boolean
  header?: ReactNode
  emptyText?: string
}

export function TrackTable(props: TrackTableProps) {
  const { rows, query, columns, source } = props
  const version = useLib((s) => s.version)
  const paged = useTrackPages(rows ? undefined : query, version)
  const count = rows ? rows.length : paged.total
  const getRow = useCallback((i: number) => (rows ? rows[i] : paged.get(i)), [rows, paged])
  const scrollRef = useContext(ScrollParent)
  const bodyRef = useRef<HTMLDivElement>(null)
  const [margin, setMargin] = useState(0)
  const [sel, setSel] = useState<Set<number>>(new Set())
  const anchor = useRef<number | null>(null)
  const currentTrackId = usePlayer((s) => s.currentTrackId)
  const playing = usePlayer((s) => !!s.state?.playing)
  const playlists = useLib((s) => s.playlists)
  const allIds = useRef<number[] | null>(null)

  const rowsKey = rows ? `${rows.length}:${rows[0]?.id ?? ''}` : ''
  useEffect(() => {
    setSel(new Set())
    allIds.current = null
  }, [JSON.stringify(query ?? null), rowsKey])
  useEffect(() => {
    allIds.current = null
  }, [version])

  useLayoutEffect(() => {
    const el = bodyRef.current
    const sp = scrollRef?.current
    if (!el || !sp) return
    const update = () => setMargin(el.getBoundingClientRect().top - sp.getBoundingClientRect().top + sp.scrollTop)
    update()
    const ro = new ResizeObserver(update)
    ro.observe(sp)
    if (el.parentElement) ro.observe(el.parentElement)
    const view = el.closest('.view')
    if (view) ro.observe(view)
    return () => ro.disconnect()
  }, [scrollRef, props.header])

  const compact = useLib((s) => s.settings['ui.density'] === 'compact')
  const rowH = props.showArt ? (compact ? 48 : 56) : compact ? 34 : 42
  // Multi-disc albums get "Disc N" header rows mixed into the virtual list.
  const display = useMemo(() => {
    if (!props.discHeaders || !rows || new Set(rows.map((r) => r.discNo ?? 1)).size < 2) return null
    const out: Array<number | { disc: number }> = []
    let last: number | null = null
    rows.forEach((r, i) => {
      const d = r.discNo ?? 1
      if (d !== last) out.push({ disc: d })
      last = d
      out.push(i)
    })
    return out
  }, [rows, props.discHeaders])
  const v = useVirtualizer({
    count: display ? display.length : count,
    getScrollElement: () => scrollRef?.current ?? null,
    estimateSize: (k) => (display && typeof display[k] !== 'number' ? 40 : rowH),
    overscan: 16,
    scrollMargin: margin,
  })
  const items = v.getVirtualItems()
  useEffect(() => {
    if (!rows && items.length) paged.ensure(items[0].index, items[items.length - 1].index)
  })
  const toDisplay = (i: number) => (display ? display.indexOf(i) : i)

  const ids = async (indices: number[]): Promise<number[]> => {
    if (rows) return indices.map((i) => rows[i]?.id).filter((x): x is number => x != null)
    const missing = indices.some((i) => !paged.get(i))
    if (missing) {
      allIds.current ??= await invoke<number[]>(LIB.trackIds, query)
      return indices.map((i) => allIds.current![i]).filter((x) => x != null)
    }
    return indices.map((i) => paged.get(i)!.id)
  }
  const selectedIndices = () => [...sel].sort((a, b) => a - b)

  const play = async (i: number) => {
    const r = getRow(i)
    if (!r) return
    if (rows) await playTracks(rows.map((x) => x.id), i, source)
    else await playQuery(query ?? {}, r.id, source)
  }

  const onRowClick = (e: React.MouseEvent, i: number) => {
    if (e.shiftKey && anchor.current != null) {
      const [a, b] = [Math.min(anchor.current, i), Math.max(anchor.current, i)]
      const next = new Set(e.ctrlKey || e.metaKey ? sel : [])
      for (let k = a; k <= b; k++) next.add(k)
      setSel(next)
    } else if (e.ctrlKey || e.metaKey) {
      const next = new Set(sel)
      if (next.has(i)) next.delete(i)
      else next.add(i)
      setSel(next)
      anchor.current = i
    } else {
      setSel(new Set([i]))
      anchor.current = i
    }
  }

  const menuFor = async (e: React.MouseEvent, i: number) => {
    e.preventDefault()
    let indices = selectedIndices()
    if (!sel.has(i)) {
      indices = [i]
      setSel(new Set([i]))
      anchor.current = i
    }
    const r = getRow(i)
    const event = { clientX: e.clientX, clientY: e.clientY }
    const chosen = await ids(indices)
    const n = chosen.length
    const items: MenuItem[] = [
      { label: 'Play', icon: 'play', onClick: () => (n === 1 ? void play(i) : void playTracks(chosen, 0, source)) },
      { label: 'Play next', icon: 'queue', onClick: () => void playNext(chosen) },
      { label: 'Add to queue', onClick: () => void addToQueue(chosen) },
      { separator: true },
      n === 1 && r?.liked
        ? { label: 'Remove from Favorites', icon: 'heart', onClick: () => void setLiked({ kind: 'track', ids: chosen }, false) }
        : { label: n > 1 ? `Add ${n} to Favorites` : 'Add to Favorites', icon: 'heart', onClick: () => void setLiked({ kind: 'track', ids: chosen }, true) },
      {
        label: 'Add to playlist',
        icon: 'playlist',
        submenu: [
          {
            label: 'New playlist…',
            icon: 'plus',
            onClick: () => window.dispatchEvent(new CustomEvent('valence:new-playlist', { detail: chosen })),
          },
          ...(playlists.some((p) => p.kind === 'static') ? [{ separator: true } as MenuItem] : []),
          ...playlists
            .filter((p) => p.kind === 'static')
            .map((p) => ({
              label: p.name,
              onClick: () => void invoke(LIB.addToPlaylist, p.id, chosen).then(() => toast(`Added to “${p.name}”`, 'ok')),
            })),
        ],
      },
      {
        label: 'Rating',
        icon: 'star',
        submenu: [0, 1, 2, 3, 4, 5].map((s) => ({
          label: s ? '★'.repeat(s) : 'None',
          checked: n === 1 && r ? Math.round(r.rating / 20) === s : false,
          onClick: () => void invoke(LIB.setRating, chosen, s),
        })),
      },
      { label: n > 1 ? `Get Info (${n})` : 'Get Info', icon: 'info', onClick: () => useUi.getState().openGetInfo(chosen) },
      { separator: true },
    ]
    if (r && n === 1) {
      if (r.albumId != null) items.push({ label: 'Go to album', icon: 'albums', onClick: () => navigate(albumRoute(r.albumId!, r.hqRip)) })
      items.push({ label: 'Go to artist', icon: 'artists', onClick: () => navigate({ view: 'artist', artist: r.albumArtist || r.artist }) })
      items.push({ label: 'View artwork', icon: 'zoomIn', onClick: () => useUi.getState().openArt({ hash: r.artHash, albumId: r.albumId, title: r.album || r.title, sub: r.albumArtist || r.artist }) })
      items.push({ label: revealLabel, icon: 'folder', onClick: () => void invoke(LIB.reveal, r.id) })
    }
    if (props.playlistId && playlists.find((p) => p.id === props.playlistId)?.kind === 'static' && rows) {
      items.push({ separator: true })
      items.push({
        label: n > 1 ? `Remove ${n} from this playlist` : 'Remove from this playlist',
        icon: 'trash',
        danger: true,
        onClick: () => {
          const drop = new Set(indices)
          void invoke(
            LIB.setPlaylistItems,
            props.playlistId,
            rows.filter((_, k) => !drop.has(k)).map((x) => x.id),
          )
        },
      })
    }
    showMenu(event, items)
  }

  const onKey = async (e: React.KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
      e.preventDefault()
      e.stopPropagation()
      setSel(new Set(Array.from({ length: count }, (_, k) => k)))
    } else if (e.key === 'Enter' && sel.size) {
      e.stopPropagation()
      const idx = selectedIndices()
      if (idx.length === 1) void play(idx[0])
      else void playTracks(await ids(idx), 0, source)
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'i' && sel.size) {
      // Get Info for the selection rather than the global "now playing info" panel.
      e.preventDefault()
      e.stopPropagation()
      useUi.getState().openGetInfo(await ids(selectedIndices()))
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const cur = anchor.current ?? -1
      const next = Math.min(count - 1, Math.max(0, cur + (e.key === 'ArrowDown' ? 1 : -1)))
      setSel(new Set([next]))
      anchor.current = next
      v.scrollToIndex(toDisplay(next), { align: 'auto' })
    }
  }

  // The last column holds each row's options button (Musicolet's "•••" square).
  const grid = [...columns.map((c) => COLUMNS[c].width), '40px'].join(' ')
  const sort = props.sort
  const header = (
    <div className="tt-head" style={{ gridTemplateColumns: grid }}>
      {columns.map((c) => {
        const col = COLUMNS[c]
        const active = sort?.key === col.sort
        return (
          <button
            key={c}
            className={cx('tt-hcell', col.align && `al-${col.align}`, active && 'sorted')}
            disabled={!props.onSort || !col.sort}
            onClick={() => props.onSort?.(active && sort?.dir === 'asc' ? { key: col.sort!, dir: 'desc' } : { key: col.sort!, dir: 'asc' })}
          >
            {col.label}
            {active && <Icon name="chevronDown" size={14} style={{ transform: sort?.dir === 'asc' ? 'rotate(180deg)' : undefined }} />}
          </button>
        )
      })}
      <span />
    </div>
  )


  if (!count && (rows || paged.total === 0)) {
    return (
      <div className="tt">
        {props.header}
        {header}
        <div className="tt-empty">{props.emptyText ?? 'No songs'}</div>
      </div>
    )
  }

  return (
    <div className="tt" tabIndex={0} onKeyDown={onKey}>
      {props.header}
      {header}
      <div ref={bodyRef} className="tt-body" style={{ height: v.getTotalSize() }}>
        {items.map((it) => {
          const top = it.start - margin
          const entry = display ? display[it.index] : it.index
          if (typeof entry !== 'number')
            return (
              <div key={it.key} className="tt-discrow" style={{ transform: `translateY(${top}px)`, height: 40 }}>
                <Icon name="disc" size={14} /> Disc {entry.disc}
              </div>
            )
          const i = entry
          const r = getRow(i)
          if (!r)
            return (
              <div key={it.key} className="tt-row placeholder" style={{ transform: `translateY(${top}px)`, height: rowH, gridTemplateColumns: grid }}>
                <span className="skeleton" />
              </div>
            )
          const isCur = r.id === currentTrackId
          return (
            <div
              key={it.key}
              className={cx('tt-row', sel.has(i) && 'sel', isCur && 'current')}
              style={{ transform: `translateY(${top}px)`, height: rowH, gridTemplateColumns: grid }}
              onClick={(e) => onRowClick(e, i)}
              onDoubleClick={() => void play(i)}
              onContextMenu={(e) => void menuFor(e, i)}
              draggable
              onDragStart={async (e) => {
                const idx = sel.has(i) ? selectedIndices() : [i]
                const chosen = rows ? idx.map((k) => rows[k].id) : idx.map((k) => paged.get(k)?.id).filter((x): x is number => x != null)
                e.dataTransfer.setData('application/x-valence-tracks', JSON.stringify(chosen))
                e.dataTransfer.effectAllowed = 'copy'
              }}
            >
              {columns.map((c) => (
                <Cell
                  key={c}
                  col={COLUMNS[c]}
                  r={r}
                  num={props.discHeaders ? (r.trackNo ?? i + 1) : i + 1}
                  isCur={isCur}
                  playing={playing}
                  showArt={props.showArt}
                  subArtist={props.showArt && !columns.includes('artist')}
                  onPlay={() => (isCur ? cmd({ type: 'toggle' }) : void play(i))}
                  onRate={(s) => void invoke(LIB.setRating, [r.id], s)}
                />
              ))}
              <span className="tt-cell al-center">
                <IconButton
                  icon="more"
                  size={20}
                  title="Options"
                  className="tt-more"
                  onClick={(e) => {
                    e.stopPropagation()
                    void menuFor(e, i)
                  }}
                />
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function Cell({
  col,
  r,
  num,
  isCur,
  playing,
  showArt,
  subArtist,
  onPlay,
  onRate,
}: {
  col: Column
  r: TrackRow
  num: number
  isCur: boolean
  playing: boolean
  showArt?: boolean
  subArtist?: boolean
  onPlay: () => void
  onRate: (s: number) => void
}) {
  const cls = cx('tt-cell', col.align && `al-${col.align}`, `c-${col.key}`)
  switch (col.key) {
    case 'index':
      return (
        <span className={cls}>
          <span className="tt-num">{isCur && playing ? <Icon name="volume" size={16} /> : num}</span>
          <button
            className="tt-play"
            title={isCur && playing ? 'Pause' : `Play ${r.title}`}
            onClick={(e) => {
              e.stopPropagation()
              onPlay()
            }}
            onDoubleClick={(e) => e.stopPropagation()}
          >
            <Icon name={isCur && playing ? 'pause' : 'play'} size={14} />
          </button>
        </span>
      )
    case 'heart':
      return (
        <span className={cls}>
          <HeartButton className="tt-heart" target={{ kind: 'track', id: r.id }} liked={r.liked} size={16} />
        </span>
      )
    case 'title':
      return (
        <span className={cls}>
          {showArt && (
            <span className="tt-art">
              <Artwork hash={r.artHash} px={96} size={40} radius={2} title={r.album} />
            </span>
          )}
          <span className="tt-title">
            <span className="tt-title-line">
              <span className="ellipsis">{r.title}</span>
              {r.lyricsKind === 'synced' && (
                <span className="tt-flag" title="Synced lyrics">
                  LRC
                </span>
              )}
            </span>
            {subArtist && (
              <a
                className="tt-title-sub ellipsis link-muted"
                onClick={(e) => {
                  e.stopPropagation()
                  navigate({ view: 'artist', artist: r.albumArtist || r.artist })
                }}
              >
                {r.artist}
              </a>
            )}
          </span>
        </span>
      )
    case 'artist':
      return (
        <span className={cls}>
          <a
            className="ellipsis link-muted"
            onClick={(e) => {
              e.stopPropagation()
              navigate({ view: 'artist', artist: r.albumArtist || r.artist })
            }}
          >
            {r.artist}
          </a>
        </span>
      )
    case 'album':
      return (
        <span className={cls}>
          <a
            className="ellipsis link-muted"
            onClick={(e) => {
              e.stopPropagation()
              if (r.albumId != null) navigate(albumRoute(r.albumId, r.hqRip))
            }}
          >
            {r.album}
          </a>
        </span>
      )
    case 'albumArtist':
      return <span className={cx(cls, 'ellipsis')}>{r.albumArtist}</span>
    case 'time':
      return <span className={cx(cls, 'tnum')}>{duration(r.durationMs)}</span>
    case 'genre':
      return <span className={cx(cls, 'ellipsis')}>{r.genre}</span>
    case 'game':
      return <span className={cx(cls, 'ellipsis')}>{r.ripGame ?? ''}</span>
    case 'composer':
      return <span className={cx(cls, 'ellipsis')}>{r.composer ?? ''}</span>
    case 'year':
      return <span className={cx(cls, 'tnum')}>{r.year ?? ''}</span>
    case 'rating':
      return (
        <span className={cls}>
          <Stars rating={r.rating} onRate={onRate} />
        </span>
      )
    case 'plays':
      return <span className={cx(cls, 'tnum')}>{r.playCount || ''}</span>
    case 'added':
      return <span className={cx(cls, 'ellipsis')}>{relativeTime(r.addedAt)}</span>
    case 'likedAt':
      return <span className={cx(cls, 'ellipsis')}>{relativeTime(r.likedAt)}</span>
    case 'lastPlayed':
      return <span className={cx(cls, 'ellipsis')}>{relativeTime(r.lastPlayed)}</span>
    case 'quality':
      return <span className={cx(cls, 'ellipsis', 'muted')}>{quality(r)}</span>
  }
}

export function useSelectionIds(rows: TrackRow[] | undefined): number[] {
  return useMemo(() => (rows ?? []).map((r) => r.id), [rows])
}
