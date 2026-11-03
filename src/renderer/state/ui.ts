// UI state: routing with back/forward history, drawers, Get Info, toasts.

import { create } from 'zustand'

export type Route =
  | { view: 'songs' }
  | { view: 'albums' }
  | { view: 'album'; id: number }
  | { view: 'artists' }
  | { view: 'artist'; artist: string }
  | { view: 'genres' }
  | { view: 'genre'; genre: string }
  | { view: 'recent' }
  | { view: 'playlist'; id: string }
  | { view: 'smart'; id?: string }
  | { view: 'nowplaying' }
  | { view: 'search'; q: string }
  | { view: 'settings'; section?: string }
  | { view: 'import'; tab?: 'queue' | 'review' | 'reports'; reportId?: string }
  | { view: 'tidal'; tab?: string; id?: string }
  | { view: 'bandcamp'; id?: string }

export interface Toast {
  id: number
  text: string
  kind: 'info' | 'ok' | 'error'
  action?: { label: string; run: () => void }
}

interface UiState {
  route: Route
  back: Route[]
  fwd: Route[]
  drawer: 'queue' | 'lyrics' | null
  getInfo: number[] | null
  toasts: Toast[]
  sidebarCollapsed: boolean
  navigate(r: Route, opts?: { replace?: boolean }): void
  goBack(): void
  goForward(): void
  setDrawer(d: UiState['drawer']): void
  toggleDrawer(d: 'queue' | 'lyrics'): void
  openGetInfo(ids: number[] | null): void
  toast(text: string, kind?: Toast['kind'], action?: Toast['action']): void
  dismiss(id: number): void
}

const KEY = 'valence.ui.route'

function loadRoute(): Route {
  try {
    const r = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Route | null
    if (r && typeof r.view === 'string' && r.view !== 'search') return r
  } catch {
    /* ignore */
  }
  return { view: 'albums' }
}

function saveRoute(r: Route): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(r))
  } catch {
    /* ignore */
  }
}

let toastId = 0

export const useUi = create<UiState>((set, get) => ({
  route: loadRoute(),
  back: [],
  fwd: [],
  drawer: null,
  getInfo: null,
  toasts: [],
  sidebarCollapsed: false,
  navigate(r, opts) {
    const cur = get().route
    if (JSON.stringify(cur) === JSON.stringify(r)) return
    saveRoute(r)
    if (opts?.replace) set({ route: r })
    else set({ route: r, back: [...get().back.slice(-50), cur], fwd: [] })
  },
  goBack() {
    const { back, route, fwd } = get()
    const prev = back[back.length - 1]
    if (!prev) return
    saveRoute(prev)
    set({ route: prev, back: back.slice(0, -1), fwd: [route, ...fwd] })
  },
  goForward() {
    const { back, route, fwd } = get()
    const next = fwd[0]
    if (!next) return
    saveRoute(next)
    set({ route: next, back: [...back, route], fwd: fwd.slice(1) })
  },
  setDrawer: (d) => set({ drawer: d }),
  toggleDrawer: (d) => set({ drawer: get().drawer === d ? null : d }),
  openGetInfo: (ids) => set({ getInfo: ids && ids.length ? ids : null }),
  toast(text, kind = 'info', action) {
    const id = ++toastId
    set({ toasts: [...get().toasts, { id, text, kind, action }] })
    setTimeout(() => get().dismiss(id), action ? 8000 : 4000)
  },
  dismiss: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),
}))

export const navigate = (r: Route) => useUi.getState().navigate(r)
export const toast = (text: string, kind?: Toast['kind'], action?: Toast['action']) => useUi.getState().toast(text, kind, action)
