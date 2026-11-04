// UI state: routing with back/forward history, panels, Get Info, the art viewer, overlays, toasts.

import { create } from 'zustand'
import type { StatsRange } from '@shared/ipc/library'

export type Route =
  | { view: 'home' }
  | { view: 'songs' }
  | { view: 'albums' }
  /** `rip` remembers which SiIvaGunner list the album belongs to, so the sidebar highlights it. */
  | { view: 'album'; id: number; rip?: RipTab }
  | { view: 'rips'; tab?: RipTab }
  | { view: 'hqrip'; tab?: 'albums' | 'sgfr' | 'youtube' }
  | { view: 'artists' }
  | { view: 'artist'; artist: string }
  | { view: 'genres' }
  | { view: 'genre'; genre: string }
  | { view: 'recent' }
  | { view: 'liked'; tab?: 'songs' | 'albums' | 'artists' }
  | { view: 'stats'; range?: StatsRange }
  | { view: 'playlist'; id: string }
  | { view: 'smart'; id?: string }
  | { view: 'nowplaying' }
  | { view: 'search'; q: string }
  | { view: 'settings'; section?: string }
  | { view: 'import'; tab?: 'queue' | 'review' | 'reports'; reportId?: string }
  | { view: 'tidal'; tab?: string; id?: string }
  | { view: 'bandcamp'; id?: string }

export type RipTab = 'seasons' | 'albums' | 'songs'
export type { StatsRange }
export type Panel = 'info' | 'queue' | 'lyrics'

/** Route to an album page; rip albums keep the SiIvaGunner section highlighted. */
export function albumRoute(id: number, hqRip?: string | null): Route {
  return hqRip ? { view: 'album', id, rip: hqRip === 'YouTube' ? 'seasons' : 'albums' } : { view: 'album', id }
}

export interface Toast {
  id: number
  text: string
  kind: 'info' | 'ok' | 'error'
  action?: { label: string; run: () => void }
}

/** What the current view wants in the main panel's sticky header. */
export interface ViewHeader {
  /** The route this header belongs to (JSON); stale headers are ignored. */
  key?: string
  /** `"r g b"`; null = the accent. */
  color: string | null
  /** Album-style full-bleed color behind a hero. */
  strong?: boolean
  title?: string
  play?: () => void
}

export interface ArtView {
  hash: string | null
  /** Album whose full-size original to show (archive cover-original or full embedded art). */
  albumId?: number | null
  url?: string | null
  title?: string
  sub?: string
}

interface UiState {
  route: Route
  back: Route[]
  fwd: Route[]
  /** Right panel tab; null = closed. */
  drawer: Panel | null
  getInfo: number[] | null
  toasts: Toast[]
  sidebarCollapsed: boolean
  sidebarW: number
  rightW: number
  header: ViewHeader
  artView: ArtView | null
  palette: boolean
  shortcuts: boolean
  onboarding: boolean
  navigate(r: Route, opts?: { replace?: boolean }): void
  goBack(): void
  goForward(): void
  setDrawer(d: UiState['drawer']): void
  toggleDrawer(d: Panel): void
  setSidebar(p: { collapsed?: boolean; width?: number }): void
  setRightW(w: number): void
  setHeader(h: ViewHeader): void
  openArt(a: ArtView | null): void
  setPalette(open: boolean): void
  setShortcuts(open: boolean): void
  setOnboarding(open: boolean): void
  openGetInfo(ids: number[] | null): void
  toast(text: string, kind?: Toast['kind'], action?: Toast['action']): void
  dismiss(id: number): void
}

const KEY = 'valence.ui.route'
const LAYOUT = 'valence.ui.layout'

function read<T>(key: string, fallback: T): T {
  try {
    const v = JSON.parse(localStorage.getItem(key) ?? 'null') as T | null
    return v ?? fallback
  } catch {
    return fallback
  }
}

function write(key: string, v: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(v))
  } catch {
    /* storage unavailable */
  }
}

function loadRoute(): Route {
  const r = read<Route | null>(KEY, null)
  if (r && typeof r.view === 'string' && r.view !== 'search') return r
  return { view: 'home' }
}

interface Layout {
  drawer: Panel | null
  collapsed: boolean
  sidebarW: number
  rightW: number
}
const layout = read<Layout>(LAYOUT, { drawer: null, collapsed: false, sidebarW: 300, rightW: 340 })
const saveLayout = (s: Pick<UiState, 'drawer' | 'sidebarCollapsed' | 'sidebarW' | 'rightW'>) =>
  write(LAYOUT, { drawer: s.drawer, collapsed: s.sidebarCollapsed, sidebarW: s.sidebarW, rightW: s.rightW } satisfies Layout)

export const SIDEBAR_MIN = 240
export const SIDEBAR_MAX = 460
export const RIGHT_MIN = 280
export const RIGHT_MAX = 480

let toastId = 0

export const useUi = create<UiState>((set, get) => ({
  route: loadRoute(),
  back: [],
  fwd: [],
  drawer: layout.drawer ?? null,
  getInfo: null,
  toasts: [],
  sidebarCollapsed: !!layout.collapsed,
  sidebarW: Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, layout.sidebarW || 300)),
  rightW: Math.min(RIGHT_MAX, Math.max(RIGHT_MIN, layout.rightW || 340)),
  header: { color: null },
  artView: null,
  palette: false,
  shortcuts: false,
  onboarding: false,
  navigate(r, opts) {
    const cur = get().route
    if (JSON.stringify(cur) === JSON.stringify(r)) return
    write(KEY, r)
    if (opts?.replace) set({ route: r })
    else set({ route: r, back: [...get().back.slice(-50), cur], fwd: [] })
  },
  goBack() {
    const { back, route, fwd } = get()
    const prev = back[back.length - 1]
    if (!prev) return
    write(KEY, prev)
    set({ route: prev, back: back.slice(0, -1), fwd: [route, ...fwd] })
  },
  goForward() {
    const { back, route, fwd } = get()
    const next = fwd[0]
    if (!next) return
    write(KEY, next)
    set({ route: next, back: [...back, route], fwd: fwd.slice(1) })
  },
  setDrawer(d) {
    set({ drawer: d })
    saveLayout(get())
  },
  toggleDrawer(d) {
    set({ drawer: get().drawer === d ? null : d })
    saveLayout(get())
  },
  setSidebar(p) {
    set({
      sidebarCollapsed: p.collapsed ?? get().sidebarCollapsed,
      sidebarW: p.width != null ? Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, Math.round(p.width))) : get().sidebarW,
    })
    saveLayout(get())
  },
  setRightW(w) {
    set({ rightW: Math.min(RIGHT_MAX, Math.max(RIGHT_MIN, Math.round(w))) })
    saveLayout(get())
  },
  setHeader(h) {
    const cur = get().header
    if (cur.key === h.key && cur.color === h.color && cur.strong === h.strong && cur.title === h.title && cur.play === h.play) return
    set({ header: h })
  },
  openArt: (a) => set({ artView: a }),
  setPalette: (open) => set({ palette: open }),
  setShortcuts: (open) => set({ shortcuts: open }),
  setOnboarding: (open) => set({ onboarding: open }),
  openGetInfo: (ids) => set({ getInfo: ids && ids.length ? ids : null }),
  toast(text, kind = 'info', action) {
    const id = ++toastId
    set({ toasts: [...get().toasts.slice(-3), { id, text, kind, action }] })
    setTimeout(() => get().dismiss(id), action ? 8000 : 4000)
  },
  dismiss: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),
}))

export const navigate = (r: Route) => useUi.getState().navigate(r)
export const toast = (text: string, kind?: Toast['kind'], action?: Toast['action']) => useUi.getState().toast(text, kind, action)
