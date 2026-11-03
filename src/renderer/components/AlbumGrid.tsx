// Virtualized album tile grid. Rows of N tiles where N follows the container width.

import { useContext, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import type { AlbumRow } from '@shared/types'
import { LIB } from '@shared/ipc/library'
import { invoke } from '../lib/ipc'
import { albumRoute, navigate, useUi } from '../state/ui'
import { addToQueue, playNext, playQuery, usePlayer } from '../state/player'
import { Artwork, showMenu } from './ui'
import { Icon } from './Icon'
import { ScrollParent } from './TrackTable'

const MIN_TILE = 168
const GAP = 22

export function albumMenu(e: React.MouseEvent, a: AlbumRow): void {
  e.preventDefault()
  const ids = () => invoke<number[]>(LIB.trackIds, { albumId: a.id })
  showMenu(e, [
    { label: 'Play', icon: 'play', onClick: () => void playQuery({ albumId: a.id }, undefined, { kind: 'album', id: String(a.id), title: a.title }) },
    { label: 'Shuffle', icon: 'shuffle', onClick: () => void playQuery({ albumId: a.id }, undefined, { kind: 'album', id: String(a.id), title: a.title }, true) },
    { label: 'Play Next', icon: 'queue', onClick: () => void ids().then(playNext) },
    { label: 'Add to Up Next', onClick: () => void ids().then(addToQueue) },
    { separator: true },
    { label: 'Get Info', icon: 'info', onClick: () => void ids().then((x) => useUi.getState().openGetInfo(x)) },
    { label: 'Go to Artist', icon: 'artists', onClick: () => navigate({ view: 'artist', artist: a.albumArtist }) },
  ])
}

export function AlbumTile({ a, sub }: { a: AlbumRow; sub?: ReactNode }) {
  const playingAlbum = usePlayer((s) => s.state?.current?.albumKey)
  return (
    <div className="tile" onClick={() => navigate(albumRoute(a.id, a.hqRip))} onContextMenu={(e) => albumMenu(e, a)}>
      <div className="tile-art">
        <Artwork hash={a.artHash} px={300} radius={10} title={a.title} />
        <button
          className="tile-play glass"
          title="Play"
          onClick={(e) => {
            e.stopPropagation()
            void playQuery({ albumId: a.id }, undefined, { kind: 'album', id: String(a.id), title: a.title })
          }}
        >
          <Icon name="play" size={16} />
        </button>
        {playingAlbum && playingAlbum === `a${a.id}` && <span className="tile-now" />}
      </div>
      <div className="tile-title ellipsis" title={a.title}>
        {a.title}
      </div>
      <div className="tile-sub ellipsis">{sub ?? a.albumArtist}</div>
    </div>
  )
}

export function AlbumGrid({ albums, header, subtitle }: { albums: AlbumRow[]; header?: ReactNode; subtitle?: (a: AlbumRow) => ReactNode }) {
  const scrollRef = useContext(ScrollParent)
  const bodyRef = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(800)
  const [margin, setMargin] = useState(0)
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
  const cols = Math.max(2, Math.floor((width + GAP) / (MIN_TILE + GAP)))
  const tile = (width - GAP * (cols - 1)) / cols
  const rowH = tile + 54 + GAP
  const rows = Math.ceil(albums.length / cols)
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
  return (
    <>
      {header}
      <div ref={bodyRef} className="grid-body" style={{ height: v.getTotalSize() }}>
        {v.getVirtualItems().map((r) => (
          <div
            key={r.key}
            className="grid-row"
            style={{ transform: `translateY(${r.start - margin}px)`, gridTemplateColumns: `repeat(${cols}, ${tile}px)`, columnGap: GAP }}
          >
            {albums.slice(r.index * cols, r.index * cols + cols).map((a) => (
              <AlbumTile key={a.id} a={a} sub={subtitle?.(a)} />
            ))}
          </div>
        ))}
      </div>
    </>
  )
}
