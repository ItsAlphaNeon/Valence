// Blurred album art of the playing track behind the whole window, crossfading between tracks.

import { useEffect, useState } from 'react'
import { artUrl } from '../lib/ipc'
import { usePlayer } from '../state/player'

export function Backdrop() {
  const hash = usePlayer((s) => s.currentArtHash)
  const [layers, setLayers] = useState<Array<{ key: number; url: string }>>([])
  useEffect(() => {
    const url = artUrl(hash, 300)
    if (!url) return setLayers([])
    setLayers((l) => [...l.slice(-1), { key: Date.now(), url }])
  }, [hash])
  return (
    <div className="backdrop" aria-hidden>
      {layers.map((l, i) => (
        <div key={l.key} className={i === layers.length - 1 ? 'backdrop-art next' : 'backdrop-art'} style={{ backgroundImage: `url("${l.url}")` }} />
      ))}
      <div className="backdrop-veil" />
    </div>
  )
}
