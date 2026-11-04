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

export type ThumbarGlyph = 'prev' | 'play' | 'pause' | 'next'

export interface ThumbarSpec {
  tooltip: string
  glyph: ThumbarGlyph
  command: 'prev' | 'toggle' | 'next'
  flags: string[]
}

/**
 * The three thumbnail-toolbar buttons for a playback state. Usable buttons get no flags: Windows
 * rejects the whole update (setThumbarButtons returns false) when a button says 'enabled'.
 */
export function thumbarSpecs(p: Pick<PlaybackChrome, 'playing' | 'hasTrack'>): ThumbarSpec[] {
  const flags = p.hasTrack ? [] : ['disabled']
  return [
    { tooltip: 'Previous', glyph: 'prev', command: 'prev', flags },
    { tooltip: p.playing ? 'Pause' : 'Play', glyph: p.playing ? 'pause' : 'play', command: 'toggle', flags },
    { tooltip: 'Next', glyph: 'next', command: 'next', flags },
  ]
}

/** Thumbnail-toolbar glyphs: the same Material Icons (Rounded) the app and the phone use. */
export function thumbarSvg(kind: 'prev' | 'play' | 'pause' | 'next', color: string, px: number): string {
  const paths: Record<typeof kind, string> = {
    prev: 'M7 6c.55 0 1 .45 1 1v10c0 .55-.45 1-1 1s-1-.45-1-1V7c0-.55.45-1 1-1zm3.66 6.82 5.77 4.07c.66.47 1.58-.01 1.58-.82V7.93c0-.81-.91-1.28-1.58-.82l-5.77 4.07a1 1 0 0 0 0 1.64z',
    play: 'M8 6.82v10.36c0 .79.87 1.27 1.54.84l8.14-5.18a1 1 0 0 0 0-1.69L9.54 5.98A.998.998 0 0 0 8 6.82z',
    pause: 'M8 19c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2s-2 .9-2 2v10c0 1.1.9 2 2 2zm6-12v10c0 1.1.9 2 2 2s2-.9 2-2V7c0-1.1-.9-2-2-2s-2 .9-2 2z',
    next: 'm7.58 16.89 5.77-4.07c.56-.4.56-1.24 0-1.63L7.58 7.11C6.91 6.65 6 7.12 6 7.93v8.14c0 .81.91 1.28 1.58.82zM16 7v10c0 .55.45 1 1 1s1-.45 1-1V7c0-.55-.45-1-1-1s-1 .45-1 1z',
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}" viewBox="0 0 24 24"><path fill="${color}" d="${paths[kind]}"/></svg>`
}
