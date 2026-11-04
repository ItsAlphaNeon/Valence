// Pure helpers behind the window chrome (no Electron imports, so they unit-test in Node).

import { TOPBAR_HEIGHT } from '@shared/types'

export const MAIN_BACKGROUND = '#121212'
export const MINI_BACKGROUND = '#181818'
export const DEFAULT_SYMBOL_COLOR = '#ffffff'
export const ZOOM_MIN = 0.7
export const ZOOM_MAX = 1.6

export interface WindowChrome {
  symbolColor: string
  background: string
}

export interface PlaybackChrome {
  playing: boolean
  hasTrack: boolean
  title?: string
  artist?: string
}

const COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i

/** A CSS hex colour Electron accepts, or null. */
export function validColor(v: unknown): string | null {
  return typeof v === 'string' && COLOR.test(v.trim()) ? v.trim() : null
}

export function parseChrome(v: unknown, fallback: WindowChrome = { symbolColor: DEFAULT_SYMBOL_COLOR, background: MAIN_BACKGROUND }): WindowChrome {
  const o = (v ?? {}) as Partial<WindowChrome>
  return { symbolColor: validColor(o.symbolColor) ?? fallback.symbolColor, background: validColor(o.background) ?? fallback.background }
}

export function clampZoom(v: unknown): number | null {
  const n = Number(v)
  if (!Number.isFinite(n) || n <= 0) return null
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, n))
}

/** Height of the native caption-button overlay: the renderer's top bar scales with the zoom. */
export function overlayHeight(zoom = 1): number {
  return Math.round(TOPBAR_HEIGHT * zoom)
}

/** macOS traffic lights (about 16 px tall), vertically centred in the top bar. */
export function trafficLightPosition(zoom = 1): { x: number; y: number } {
  return { x: 18, y: Math.max(0, Math.round((overlayHeight(zoom) - 16) / 2)) }
}

/** Window (and taskbar) title: "<title> • <artist>" while a track is loaded. */
export function playbackTitle(p: Partial<PlaybackChrome> | null | undefined): string {
  if (!p?.hasTrack || !p.title?.trim()) return 'Valence'
  const t = `${p.title.trim()}${p.artist?.trim() ? ` • ${p.artist.trim()}` : ''}`
  return t.length > 200 ? `${t.slice(0, 199)}…` : t
}

/**
 * Overall progress of the current burst of import work, for the taskbar. Jobs seen active since
 * the burst began count as done once they leave the queue, so the bar only moves forward as jobs
 * finish. Returns null (no bar) while nothing is running.
 */
export class TaskbarBatch {
  private seen = new Map<string, number>()

  update(active: Array<{ id: string; status: string; progress: number }>): number | null {
    if (!active.some((j) => j.status === 'running')) {
      this.seen.clear()
      return null
    }
    const ids = new Set<string>()
    for (const j of active) {
      ids.add(j.id)
      this.seen.set(j.id, j.status === 'running' ? Math.max(0, Math.min(1, Number(j.progress) || 0)) : 0)
    }
    let sum = 0
    for (const [id, p] of this.seen) {
      if (!ids.has(id)) this.seen.set(id, 1)
      sum += ids.has(id) ? p : 1
    }
    return this.seen.size ? sum / this.seen.size : null
  }
}

/** 16x16 thumbnail-toolbar glyphs. */
export function thumbarSvg(kind: 'prev' | 'play' | 'pause' | 'next', color: string, px: number): string {
  const paths: Record<typeof kind, string> = {
    prev: 'M3 3h1.8v10H3zM13 3.3v9.4L5.9 8z',
    play: 'M4.6 2.6v10.8L13.2 8z',
    pause: 'M3.8 3h2.9v10H3.8zM9.3 3h2.9v10H9.3z',
    next: 'M11.2 3H13v10h-1.8zM3 3.3v9.4L10.1 8z',
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}" viewBox="0 0 16 16"><path fill="${color}" d="${paths[kind]}"/></svg>`
}
