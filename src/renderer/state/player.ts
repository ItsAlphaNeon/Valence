// Bridges the audio Player (src/renderer/audio) to React: state store, play helpers that resolve
// library track ids into PlayItems, play logging, queue restore across restarts, playback
// preferences from Settings, the sleep timer and autoplay (similar tracks from the library).

import { create } from 'zustand'
import { Player, SLEEP_OFF, attachPlayerRelay, type AutoplayRequest, type PlaybackPrefs, type PlayItem, type PlayerCommand, type PlayerState, type QueueSource, type SleepTimer } from '../audio'
import { invoke } from '../lib/ipc'
import { LIB, type LibraryPlayItem } from '@shared/ipc/library'
import type { TrackQuery } from '@shared/types'
import { applyAccent } from '../theme/accent'
import { setting, useLib } from './library'
import { toast } from './ui'

export type { SleepTimer }

interface PlayerStore {
  state: PlayerState | null
  positionMs: number
  durationMs: number
  ready: boolean
  /** Library track id of the current item (for ratings, Get Info, lyrics). */
  currentTrackId: number | null
  currentArtHash: string | null
  /** Active sleep timer; not persisted, back to 'off' once it fires. */
  sleep: SleepTimer
  /** Pause at the end of the current track (turns itself off). */
  stopAfterCurrent: boolean
}

export const usePlayer = create<PlayerStore>(() => ({
  state: null,
  positionMs: 0,
  durationMs: 0,
  ready: false,
  currentTrackId: null,
  currentArtHash: null,
  sleep: SLEEP_OFF,
  stopAfterCurrent: false,
}))

/** Settings keys (and defaults) of the playback preferences the Player follows live. */
export const PLAYBACK_SETTINGS = {
  autoplay: { key: 'playback.autoplay', fallback: true },
  sleepFade: { key: 'playback.sleepFade', fallback: true },
  mono: { key: 'playback.mono', fallback: false },
  balance: { key: 'playback.balance', fallback: 0 },
  fadePauseMs: { key: 'playback.fadePauseMs', fallback: 120 },
  prevRestartSec: { key: 'playback.prevRestartSec', fallback: 3 },
} as const

/** 'time' pauses at endsAt (fading over the last 20 s when playback.sleepFade is on); 'track' / 'album' at that boundary. */
export function setSleepTimer(t: SleepTimer): void {
  cmd({ type: 'setSleepTimer', timer: t })
}

/** Pause at the end of the current track; turns itself off when it does. */
export function setStopAfterCurrent(on: boolean): void {
  cmd({ type: 'setStopAfterCurrent', on })
}

let player: Player | null = null
const trackIds = new Map<string, number>()
let lastContext: { ids: number[]; source?: QueueSource } | null = null
const RESUME_KEY = 'valence.player.resume'
const SIMILAR = 'library:similar'
/** Library ids of recently played tracks, most recent last (autoplay seeds and exclusions). */
const recent: number[] = []
const RECENT_MAX = 300

export function getPlayer(): Player | null {
  return player
}

function trackIdOf(item: PlayItem | null | undefined): number | null {
  if (!item) return null
  const known = trackIds.get(item.id) ?? (item as unknown as { trackId?: number }).trackId
  if (known) return known
  const m = /^t(\d+)$/.exec(item.id)
  return m ? Number(m[1]) : null
}

function artHashOf(item: PlayItem | null | undefined): string | null {
  const m = item?.artUrl ? /valence-art:\/\/img\/([0-9a-f]+)/i.exec(item.artUrl) : null
  return m ? m[1] : null
}

function toPlayItems(items: LibraryPlayItem[]): PlayItem[] {
  for (const i of items) trackIds.set(i.id, i.trackId)
  return items as unknown as PlayItem[]
}

const idsOf = (items: readonly PlayItem[]) => items.map(trackIdOf).filter((x): x is number => x != null)

/** The newest `n` distinct values, oldest first. */
function lastDistinct(xs: number[], n: number): number[] {
  const out: number[] = []
  for (let i = xs.length - 1; i >= 0 && out.length < n; i--) if (!out.includes(xs[i])) out.push(xs[i])
  return out.reverse()
}

/** Autoplay: similar library tracks for the last few played (main: library:similar). */
async function similarItems(req: AutoplayRequest): Promise<PlayItem[]> {
  const seed = lastDistinct([...recent, ...idsOf(req.seed)], 5)
  if (!seed.length) return []
  const exclude = [...new Set([...idsOf(req.exclude), ...recent])].slice(-1000)
  const found = await invoke<number[]>(SIMILAR, seed, exclude, 20)
  if (!Array.isArray(found) || !found.length) return []
  return toPlayItems(await invoke<LibraryPlayItem[]>(LIB.playItems, found))
}

function readPrefs(): Partial<PlaybackPrefs> {
  const S = PLAYBACK_SETTINGS
  const get = (k: { key: string; fallback: unknown }) => setting<unknown>(k.key, k.fallback)
  const num = (v: unknown) => (typeof v === 'number' ? v : Number(v))
  return {
    autoplay: get(S.autoplay) !== false,
    sleepFade: get(S.sleepFade) !== false,
    mono: get(S.mono) === true,
    balance: num(get(S.balance)),
    fadeMs: num(get(S.fadePauseMs)),
    prevRestartMs: num(get(S.prevRestartSec)) * 1000,
  }
}

let resumeTimer: ReturnType<typeof setTimeout> | null = null
function saveResume(): void {
  if (resumeTimer) return
  resumeTimer = setTimeout(() => {
    resumeTimer = null
    const s = usePlayer.getState()
    const cur = s.currentTrackId
    if (!lastContext || cur == null) return
    try {
      localStorage.setItem(RESUME_KEY, JSON.stringify({ ...lastContext, current: cur, positionMs: s.positionMs }))
    } catch {
      /* ignore */
    }
  }, 2000)
}

export async function initPlayer(): Promise<void> {
  const p = await Player.create({
    onPlayLogged: (e) => {
      const id = trackIdOf(e.item)
      if (id != null) void invoke(LIB.recordPlay, { trackId: id, playedAt: e.startedAt, ms: Math.round(e.playedMs), completed: e.completed, skipped: false })
    },
    onSkip: (e) => {
      const id = trackIdOf(e.item)
      if (id != null) void invoke(LIB.recordPlay, { trackId: id, playedAt: e.startedAt, ms: Math.round(e.playedMs), completed: false, skipped: true })
    },
    autoplay: similarItems,
  })
  player = p
  p.setPrefs(readPrefs())
  useLib.subscribe((s, prev) => {
    if (s.settings !== prev.settings) p.setPrefs(readPrefs())
  })
  attachPlayerRelay(p)
  let lastItem: string | null = null
  let lastCtx: readonly PlayItem[] | null = null
  p.on('state', (state) => {
    const cur = state.current
    const patch: Partial<PlayerStore> = { state, durationMs: state.durationMs }
    if ((cur?.id ?? null) !== lastItem) {
      lastItem = cur?.id ?? null
      patch.currentTrackId = trackIdOf(cur)
      patch.currentArtHash = artHashOf(cur)
      void applyAccent(patch.currentArtHash)
      if (patch.currentTrackId != null && recent.at(-1) !== patch.currentTrackId) {
        recent.push(patch.currentTrackId)
        if (recent.length > RECENT_MAX) recent.splice(0, recent.length - RECENT_MAX)
      }
    }
    const prev = usePlayer.getState()
    if (state.sleep !== prev.sleep) patch.sleep = state.sleep
    if (state.stopAfterCurrent !== prev.stopAfterCurrent) patch.stopAfterCurrent = state.stopAfterCurrent
    // autoplay builds its context inside the Player and the queue can be edited there; keep the
    // resume point in step with it
    const ctx = p.queue.contextItems
    if (ctx !== lastCtx) {
      lastCtx = ctx
      const ids = idsOf(ctx)
      if (ids.length) lastContext = { ids, source: state.queue.context.source ?? undefined }
    }
    usePlayer.setState(patch)
    saveResume()
  })
  p.on('position', (pos) => {
    usePlayer.setState({ positionMs: pos.positionMs, durationMs: pos.durationMs })
    saveResume()
  })
  p.on('error', (e) => toast(`Playback error: ${e.message}`, 'error'))
  const s0 = p.getState()
  usePlayer.setState({ state: s0, ready: true, sleep: s0.sleep, stopAfterCurrent: s0.stopAfterCurrent })
  void restore()
}

async function restore(): Promise<void> {
  try {
    const r = JSON.parse(localStorage.getItem(RESUME_KEY) ?? 'null') as { ids: number[]; source?: QueueSource; current: number; positionMs: number } | null
    if (!r?.ids?.length || !player) return
    const items = toPlayItems(await invoke<LibraryPlayItem[]>(LIB.playItems, r.ids))
    if (!items.length) return
    const idx = Math.max(0, items.findIndex((i) => trackIds.get(i.id) === r.current))
    lastContext = { ids: r.ids, source: r.source }
    player.setQueue(items, idx, r.source, r.positionMs ?? 0, false)
  } catch {
    /* nothing to restore */
  }
}

export function cmd(c: PlayerCommand): void {
  player?.command(c)
}

/** Replaces the queue with these library tracks and starts at `startIndex`. */
export async function playTracks(ids: number[], startIndex = 0, source?: QueueSource): Promise<void> {
  if (!player || !ids.length) return
  const items = toPlayItems(await invoke<LibraryPlayItem[]>(LIB.playItems, ids))
  // playItems drops ids that vanished; keep the intended start track.
  const wanted = ids[startIndex]
  const idx = Math.max(0, items.findIndex((i) => trackIds.get(i.id) === wanted))
  lastContext = { ids: items.map((i) => trackIds.get(i.id)!).filter(Boolean), source }
  player.setQueue(items, idx, source)
}

export async function playShuffled(ids: number[], source?: QueueSource): Promise<void> {
  if (!ids.length) return
  cmd({ type: 'setShuffle', shuffle: true })
  await playTracks(ids, Math.floor(Math.random() * ids.length), source)
}

export async function playQuery(q: TrackQuery, startTrackId?: number, source?: QueueSource, shuffle = false): Promise<void> {
  const ids = await invoke<number[]>(LIB.trackIds, q)
  if (shuffle) return playShuffled(ids, source)
  await playTracks(ids, startTrackId != null ? Math.max(0, ids.indexOf(startTrackId)) : 0, source)
}

export async function playNext(ids: number[]): Promise<void> {
  if (!ids.length) return
  const items = toPlayItems(await invoke<LibraryPlayItem[]>(LIB.playItems, ids))
  if (!usePlayer.getState().state?.current) return playTracks(ids)
  cmd({ type: 'playNext', items })
  toast(ids.length === 1 ? `Playing “${items[0]?.title}” next` : `Playing ${ids.length} songs next`)
}

export async function addToQueue(ids: number[]): Promise<void> {
  if (!ids.length) return
  const items = toPlayItems(await invoke<LibraryPlayItem[]>(LIB.playItems, ids))
  if (!usePlayer.getState().state?.current) return playTracks(ids)
  cmd({ type: 'addToQueue', items })
  toast(ids.length === 1 ? `Added “${items[0]?.title}” to Up Next` : `Added ${ids.length} songs to Up Next`)
}

export { trackIdOf }
