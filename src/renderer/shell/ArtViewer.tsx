// Full-screen album art viewer: the archived original (or the full embedded art), wheel / pinch to
// zoom around the cursor, drag to pan, double-click for 100%, keys + − 0 1 and arrows.

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { LIB, type ArtOriginal } from '@shared/ipc/library'
import { artUrl, invoke } from '../lib/ipc'
import { cx } from '../lib/format'
import { useUi } from '../state/ui'
import { IconButton } from '../components/ui'

interface View {
  s: number
  x: number
  y: number
}

const MAX_ZOOM = 16

export function ArtViewer() {
  const art = useUi((s) => s.artView)
  if (!art) return null
  return <Viewer key={`${art.hash}:${art.albumId}:${art.url}`} />
}

function Viewer() {
  const art = useUi((s) => s.artView)!
  const close = () => useUi.getState().openArt(null)
  const preview = art.url ?? artUrl(art.hash, 640)
  const [src, setSrc] = useState<string | null>(null)
  const [source, setSource] = useState<ArtOriginal['source'] | null>(null)
  const [nat, setNat] = useState<{ w: number; h: number } | null>(null)
  const [view, setView] = useState<View>({ s: 1, x: 0, y: 0 })
  const [dragging, setDragging] = useState(false)
  const stage = useRef<HTMLDivElement>(null)
  const fitRef = useRef(1)

  // Find the best source: the album's archived original, else full-size embedded art.
  useEffect(() => {
    let live = true
    const fallback = art.url ?? artUrl(art.hash, 0) ?? null
    if (art.albumId != null)
      void invoke<ArtOriginal | null>(LIB.artOriginal, art.albumId)
        .catch(() => null)
        .then((o) => {
          if (!live) return
          setSrc(o?.url ?? fallback)
          setSource(o?.source ?? (fallback ? 'embedded' : null))
        })
    else {
      setSrc(fallback)
      setSource(fallback ? 'embedded' : null)
    }
    return () => {
      live = false
    }
  }, [art.albumId, art.hash, art.url])

  const fit = useCallback((n = nat) => {
    const el = stage.current
    if (!el || !n) return 1
    return Math.min((el.clientWidth * 0.92) / n.w, (el.clientHeight * 0.92) / n.h)
  }, [nat])

  const reset = useCallback(
    (n = nat) => {
      if (!n) return
      const f = fit(n)
      fitRef.current = f
      setView({ s: f, x: (-n.w * f) / 2, y: (-n.h * f) / 2 })
    },
    [fit, nat],
  )

  useLayoutEffect(() => {
    const onResize = () => reset()
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [reset])

  /** Zoom to `ns`, keeping the stage point (cx, cy) — relative to the centre — where it is. */
  const zoomTo = useCallback(
    (ns: number, cx = 0, cy = 0) => {
      setView((v) => {
        const s = Math.min(MAX_ZOOM, Math.max(fitRef.current * 0.5, ns))
        const px = (cx - v.x) / v.s
        const py = (cy - v.y) / v.s
        return { s, x: cx - px * s, y: cy - py * s }
      })
    },
    [],
  )

  const center = (e: { clientX: number; clientY: number }) => {
    const r = stage.current!.getBoundingClientRect()
    return [e.clientX - r.left - r.width / 2, e.clientY - r.top - r.height / 2] as const
  }

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === '+' || e.key === '=') zoomTo(view.s * 1.25)
      else if (e.key === '-') zoomTo(view.s / 1.25)
      else if (e.key === '0') reset()
      else if (e.key === '1') zoomTo(1)
      else if (e.key.startsWith('Arrow')) {
        const d = e.shiftKey ? 120 : 40
        setView((v) => ({ ...v, x: v.x + (e.key === 'ArrowLeft' ? d : e.key === 'ArrowRight' ? -d : 0), y: v.y + (e.key === 'ArrowUp' ? d : e.key === 'ArrowDown' ? -d : 0) }))
      } else return
      e.preventDefault()
      e.stopPropagation()
    }
    window.addEventListener('keydown', key, true)
    return () => window.removeEventListener('keydown', key, true)
  }, [view.s, zoomTo, reset])

  // Wheel needs a non-passive listener to stop the page from scrolling/zooming.
  useEffect(() => {
    const el = stage.current
    if (!el) return
    const wheel = (e: WheelEvent) => {
      e.preventDefault()
      const [cx, cy] = center(e)
      const k = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0018))
      setView((v) => {
        const s = Math.min(MAX_ZOOM, Math.max(fitRef.current * 0.5, v.s * k))
        const px = (cx - v.x) / v.s
        const py = (cy - v.y) / v.s
        return { s, x: cx - px * s, y: cy - py * s }
      })
    }
    el.addEventListener('wheel', wheel, { passive: false })
    return () => el.removeEventListener('wheel', wheel)
  }, [])

  const shown = src ?? preview
  const pct = nat ? Math.round(view.s * 100) : 100
  const pixel = view.s >= 3

  return (
    <div className="art-viewer" role="dialog" aria-label="Artwork">
      <div
        ref={stage}
        className={cx('av-stage', dragging && 'dragging', pixel && 'pixel')}
        onPointerDown={(e) => {
          if (e.button !== 0) return
          const el = e.currentTarget
          el.setPointerCapture(e.pointerId)
          const start = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y }
          let moved = false
          const onTarget = e.target === el
          const move = (ev: PointerEvent) => {
            const dx = ev.clientX - start.x
            const dy = ev.clientY - start.y
            if (!moved && Math.hypot(dx, dy) > 4) {
              moved = true
              setDragging(true)
            }
            if (moved) setView((v) => ({ ...v, x: start.vx + dx, y: start.vy + dy }))
          }
          const up = () => {
            setDragging(false)
            el.removeEventListener('pointermove', move)
            el.removeEventListener('pointerup', up)
            // A plain click on the backdrop closes.
            if (!moved && onTarget) close()
          }
          el.addEventListener('pointermove', move)
          el.addEventListener('pointerup', up)
        }}
        onDoubleClick={(e) => {
          const [cx, cy] = center(e)
          const f = fitRef.current
          if (Math.abs(view.s - f) < 0.01) zoomTo(Math.max(1, f * 2), cx, cy)
          else reset()
        }}
      >
        {shown && (
          <img
            src={shown}
            alt=""
            draggable={false}
            style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.s})`, transition: dragging ? 'none' : 'transform 90ms linear' }}
            onLoad={(e) => {
              const img = e.currentTarget
              const n = { w: img.naturalWidth, h: img.naturalHeight }
              // The preview and the original differ in size; keep the on-screen size steady.
              if (nat && (nat.w !== n.w || nat.h !== n.h)) {
                const ratio = nat.w / n.w
                fitRef.current = fit(n)
                setView((v) => ({ ...v, s: v.s * ratio }))
              } else reset(n)
              setNat(n)
            }}
            onError={() => src && preview && src !== preview && setSrc(preview)}
          />
        )}
        <div className="av-hint">Scroll to zoom · drag to move · double-click for 100%</div>
      </div>
      <div className="av-top">
        <IconButton icon="close" size={18} title="Close (Esc)" onClick={close} />
      </div>
      <div className="av-bar">
        <div className="av-meta">
          {art.title && <div className="av-title ellipsis">{art.title}</div>}
          <div className="av-sub ellipsis">
            {[art.sub, nat && `${nat.w} × ${nat.h}`, source === 'archive' ? 'Archived original' : source === 'embedded' ? 'Embedded artwork' : null].filter(Boolean).join(' · ')}
          </div>
        </div>
        <IconButton icon="zoomOut" size={18} title="Zoom out (−)" onClick={() => zoomTo(view.s / 1.25)} />
        <span className="av-zoom">{pct}%</span>
        <IconButton icon="zoomIn" size={18} title="Zoom in (+)" onClick={() => zoomTo(view.s * 1.25)} />
        <IconButton icon="fit" size={18} title="Fit to screen (0)" onClick={() => reset()} />
        <button className="btn btn-sm av-one" title="Actual size (1)" onClick={() => zoomTo(1)}>
          1:1
        </button>
      </div>
    </div>
  )
}
