// Library-wide renderer state: a version counter bumped on library changes (views refetch), the
// playlist list, settings mirror and import activity.

import { create } from 'zustand'
import { useEffect, useRef, useState } from 'react'
import { invoke, on } from '../lib/ipc'
import { LIB } from '@shared/ipc/library'
import { IMPORT, type JobInfo } from '@shared/ipc/import'
import { SETTINGS } from '@shared/ipc/settings'
import type { LibraryStats } from '@shared/types'
import type { PlaylistInfo } from '@main/library/playlists'

interface LibState {
  version: number
  playlistsVersion: number
  playlists: PlaylistInfo[]
  stats: LibraryStats | null
  scan: { done: number; total: number } | null
  settings: Record<string, unknown>
  jobs: JobInfo[]
  pausedSources: Record<string, string>
}

export const useLib = create<LibState>(() => ({
  version: 0,
  playlistsVersion: 0,
  playlists: [],
  stats: null,
  scan: null,
  settings: {},
  jobs: [],
  pausedSources: {},
}))

export async function refreshPlaylists(): Promise<void> {
  const playlists = await invoke<PlaylistInfo[]>(LIB.playlists).catch(() => [])
  useLib.setState({ playlists })
}

async function refreshStats(): Promise<void> {
  const stats = await invoke<LibraryStats>(LIB.stats).catch(() => null)
  useLib.setState({ stats })
}

let bumpTimer: ReturnType<typeof setTimeout> | null = null

const favoriteListeners = new Set<() => void>()
/** Runs right away whenever favorites change (before the debounced library refresh). */
export function onFavoritesChanged(fn: () => void): () => void {
  favoriteListeners.add(fn)
  return () => favoriteListeners.delete(fn)
}

export function initLibraryState(): void {
  void refreshPlaylists()
  void refreshStats()
  void invoke<Record<string, unknown>>(SETTINGS.all).then((settings) => useLib.setState({ settings }))
  void invoke<JobInfo[]>(IMPORT.jobs).then((jobs) => useLib.setState({ jobs }))
  void invoke<Record<string, string>>(IMPORT.pausedSources).then((pausedSources) => useLib.setState({ pausedSources }))
  on<[{ playlists?: boolean; plays?: boolean; favorites?: boolean } | undefined]>(LIB.changed, (what) => {
    if (what?.favorites) for (const fn of favoriteListeners) fn()
    if (what?.playlists) {
      void refreshPlaylists()
      useLib.setState((s) => ({ playlistsVersion: s.playlistsVersion + 1 }))
      return
    }
    // Coalesce bursts (imports index file by file).
    if (bumpTimer) return
    bumpTimer = setTimeout(() => {
      bumpTimer = null
      useLib.setState((s) => ({ version: s.version + 1 }))
      void refreshStats()
      void refreshPlaylists()
    }, 400)
  })
  on<[{ done: number; total: number } | null]>(LIB.scanProgress, (scan) => useLib.setState({ scan }))
  on<[string, unknown]>(SETTINGS.changed, (k, v) => useLib.setState((s) => ({ settings: { ...s.settings, [k]: v } })))
  on<[JobInfo[]]>(IMPORT.jobsChanged, (jobs) => useLib.setState({ jobs }))
  on<[JobInfo]>(IMPORT.job, (job) =>
    useLib.setState((s) => {
      const i = s.jobs.findIndex((j) => j.id === job.id)
      if (i < 0) return { jobs: [job, ...s.jobs] }
      const jobs = s.jobs.slice()
      jobs[i] = job
      return { jobs }
    }),
  )
  on<[Record<string, string>]>(IMPORT.sourcesChanged, (pausedSources) => useLib.setState({ pausedSources }))
}

export function setting<T>(key: string, fallback: T): T {
  const v = useLib.getState().settings[key]
  return v === undefined || v === null ? fallback : (v as T)
}

export function useSetting<T>(key: string, fallback: T): [T, (v: T) => void] {
  const v = useLib((s) => s.settings[key])
  const value = v === undefined || v === null ? fallback : (v as T)
  return [
    value,
    (nv: T) => {
      useLib.setState((s) => ({ settings: { ...s.settings, [key]: nv } }))
      void invoke(SETTINGS.set, key, nv)
    },
  ]
}

/**
 * Loads data with `fn`, re-running when deps change or the library version bumps. Keeps the
 * previous value while reloading so lists don't flash.
 */
export function useLibData<T>(fn: () => Promise<T>, deps: unknown[], opts: { playlists?: boolean } = {}): { data: T | undefined; loading: boolean; error: string | null; reload: () => void } {
  const version = useLib((s) => s.version)
  const pv = useLib((s) => (opts.playlists ? s.playlistsVersion : 0))
  const [data, setData] = useState<T>()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [tick, setTick] = useState(0)
  const seq = useRef(0)
  useEffect(() => {
    const n = ++seq.current
    setLoading(true)
    fn().then(
      (d) => {
        if (n !== seq.current) return
        setData(d)
        setError(null)
        setLoading(false)
      },
      (e) => {
        if (n !== seq.current) return
        setError(String((e as Error)?.message ?? e))
        setLoading(false)
      },
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, version, pv, tick])
  return { data, loading, error, reload: () => setTick((t) => t + 1) }
}
