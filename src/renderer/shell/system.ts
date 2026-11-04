// Keeps the OS in step with playback: the window title and Windows thumbnail buttons
// ('window:playback'), and an optional notification on track change while the window is in the
// background ('notify:track').

import { useEffect } from 'react'
import { send } from '../lib/ipc'
import { setting } from '../state/library'
import { usePlayer } from '../state/player'

export function usePlaybackChrome(): void {
  useEffect(() => {
    let last = ''
    let lastId: string | null = null
    const push = () => {
      const s = usePlayer.getState()
      const cur = s.state?.current ?? null
      const p = { playing: !!s.state?.playing, hasTrack: !!cur, title: cur?.title, artist: cur?.artist }
      const key = JSON.stringify(p)
      if (key !== last) {
        last = key
        send('window:playback', p)
      }
      // Track-change notification (only when another track starts, not on pause/resume).
      if (cur && cur.id !== lastId) {
        const first = lastId === null
        lastId = cur.id
        if (!first && s.state?.playing && setting('ui.notifications.trackChange', false) && !document.hasFocus()) {
          send('notify:track', { title: cur.title, artist: cur.artist, album: cur.album || undefined, artHash: s.currentArtHash ?? undefined })
        }
      } else if (!cur) lastId = null
    }
    push()
    return usePlayer.subscribe(push)
  }, [])
}
