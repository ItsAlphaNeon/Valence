// A virtualized grid of equal-width cards for long lists (artists). Rows of N cards where N follows
// the container width; only the rows near the viewport are rendered.

import { useContext, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { ScrollParent } from './TrackTable'

const GAP = 24

export function VirtualGrid<T>({ items, minTile = 176, extraH, render, keyOf }: { items: T[]; minTile?: number; extraH: number; render: (item: T) => ReactNode; keyOf: (item: T) => string | number }) {
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
  }, [scrollRef])
  const cols = Math.max(2, Math.floor((width + GAP) / (minTile + GAP)))
  const tile = (width - GAP * (cols - 1)) / cols
  const rowH = Math.round(tile + extraH + GAP)
  const v = useVirtualizer({
    count: Math.ceil(items.length / cols),
    getScrollElement: () => scrollRef?.current ?? null,
    estimateSize: () => rowH,
    overscan: 3,
    scrollMargin: margin,
  })
  useLayoutEffect(() => {
    v.measure()
  }, [rowH, v])
  return (
    <div ref={bodyRef} className="grid-body" style={{ height: v.getTotalSize() }}>
      {v.getVirtualItems().map((r) => (
        <div key={r.key} className="grid-row" style={{ transform: `translateY(${r.start - margin}px)`, gridTemplateColumns: `repeat(${cols}, ${tile}px)`, columnGap: GAP }}>
          {items.slice(r.index * cols, r.index * cols + cols).map((it) => (
            <div key={keyOf(it)} style={{ minWidth: 0 }}>
              {render(it)}
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}
