// Views tell the main panel's sticky header what color and title to use.

import { useEffect, useRef } from 'react'
import { useUi } from '../state/ui'

/**
 * `color` is `"r g b"` (null = the accent). `strong` paints a full album-style color block behind a
 * hero. `play` adds a play button to the header once the hero has scrolled away.
 */
export function useViewHeader(h: { color: string | null; strong?: boolean; title?: string; play?: () => void }): void {
  const play = useRef(h.play)
  play.current = h.play
  const hasPlay = !!h.play
  useEffect(() => {
    useUi.getState().setHeader({
      key: JSON.stringify(useUi.getState().route),
      color: h.color,
      strong: h.strong,
      title: h.title,
      play: hasPlay ? stablePlay(play) : undefined,
    })
  }, [h.color, h.strong, h.title, hasPlay])
}

const plays = new WeakMap<object, () => void>()
function stablePlay(ref: { current: (() => void) | undefined }): () => void {
  let fn = plays.get(ref)
  if (!fn) {
    fn = () => ref.current?.()
    plays.set(ref, fn)
  }
  return fn
}
