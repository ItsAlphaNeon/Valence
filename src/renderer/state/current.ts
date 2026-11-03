// The library row and lyrics of whatever is playing, refreshed on track change and library edits.

import { useEffect, useState } from 'react'
import type { TrackRow, TrackTags } from '@shared/types'
import { LIB } from '@shared/ipc/library'
import { invoke } from '../lib/ipc'
import { parseLyrics, type Lyrics } from '../lib/lrc'
import { useLib } from './library'
import { usePlayer } from './player'

export function useCurrentTrack(): TrackRow | null {
  const id = usePlayer((s) => s.currentTrackId)
  const version = useLib((s) => s.version)
  const [row, setRow] = useState<TrackRow | null>(null)
  useEffect(() => {
    if (id == null) return setRow(null)
    let live = true
    void invoke<TrackRow | null>(LIB.track, id).then((r) => live && setRow(r))
    return () => {
      live = false
    }
  }, [id, version])
  return row
}

const lyricsCache = new Map<string, Lyrics | null>()

export function useCurrentLyrics(): { lyrics: Lyrics | null; loading: boolean; trackId: number | null } {
  const id = usePlayer((s) => s.currentTrackId)
  const version = useLib((s) => s.version)
  const [state, setState] = useState<{ lyrics: Lyrics | null; loading: boolean; trackId: number | null }>({ lyrics: null, loading: false, trackId: null })
  useEffect(() => {
    if (id == null) return setState({ lyrics: null, loading: false, trackId: null })
    const key = `${id}:${version}`
    if (lyricsCache.has(key)) return setState({ lyrics: lyricsCache.get(key)!, loading: false, trackId: id })
    let live = true
    // Keep showing the old lyrics while a library change re-reads the same track.
    setState((s) => (s.trackId === id ? s : { lyrics: null, loading: true, trackId: id }))
    void invoke<{ tags: TrackTags } | null>(LIB.getTags, id)
      .then((r) => parseLyrics(r?.tags.lyrics))
      .catch(() => null)
      .then((lyrics) => {
        if (lyricsCache.size > 200) lyricsCache.clear()
        lyricsCache.set(key, lyrics)
        if (live) setState({ lyrics, loading: false, trackId: id })
      })
    return () => {
      live = false
    }
  }, [id, version])
  return state
}
