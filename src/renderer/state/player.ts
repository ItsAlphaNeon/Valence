// Bridges the audio Player (src/renderer/audio) to React: state store, play helpers that resolve
// library track ids into PlayItems, play logging, and queue restore across restarts.

import { create } from 'zustand'
import { Player, attachPlayerRelay, type PlayItem, type PlayerCommand, type PlayerState, type QueueSource } from '../audio'
import { invoke } from '../lib/ipc'
import { LIB, type LibraryPlayItem } from '@shared/ipc/library'
import type { TrackQuery } from '@shared/types'
import { applyAccent } from '../theme/accent'
import { toast } from './ui'

interface PlayerStore {
  state: PlayerState | null
  positionMs: number
  durationMs: number
  ready: boolean
  /** Library track id of the current item (for ratings, Get Info, lyrics). */
  currentTrackId: number | null
  currentArtHash: string | null
}

export const usePlayer = create<PlayerStore>(() => ({ state: null, positionMs: 0, durationMs: 0, ready: false, currentTrackId: null, currentArtHash: null }))

let player: Player | null = null
const trackIds = new Map<string, number>()
let lastContext: { ids: number[]; source?: QueueSource } | null = null
const RESUME_KEY = 'valence.player.resume'

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
  player = await Player.create({
    onPlayLogged: (e) => {
      const id = trackIdOf(e.item)
      if (id != null) void invoke(LIB.recordPlay, { trackId: id, playedAt: e.startedAt, ms: Math.round(e.playedMs), completed: e.completed, skipped: false })
    },
    onSkip: (e) => {
      const id = trackIdOf(e.item)
      if (id != null) void invoke(LIB.recordPlay, { trackId: id, playedAt: e.startedAt, ms: Math.round(e.playedMs), completed: false, skipped: true })
    },
  })
  attachPlayerRelay(player)
  let lastItem: string | null = null
  player.on('state', (state) => {
    const cur = state.current
    const patch: Partial<PlayerStore> = { state, durationMs: state.durationMs }
    if ((cur?.id ?? null) !== lastItem) {
      lastItem = cur?.id ?? null
      patch.currentTrackId = trackIdOf(cur)
      patch.currentArtHash = artHashOf(cur)
      void applyAccent(patch.currentArtHash)
    }
    usePlayer.setState(patch)
    saveResume()
  })
  player.on('position', (p) => {
    usePlayer.setState({ positionMs: p.positionMs, durationMs: p.durationMs })
    saveResume()
  })
  player.on('error', (e) => toast(`Playback error: ${e.message}`, 'error'))
  usePlayer.setState({ state: player.getState(), ready: true })
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
