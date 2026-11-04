// The like (heart) button for tracks, albums and artists.

import { useState } from 'react'
import { cx } from '../lib/format'
import { setLiked, useLiked } from '../state/favorites'
import { IconButton } from './ui'

type Target = { kind: 'track' | 'album'; id: number } | { kind: 'artist'; name: string }

export function HeartButton({ target, liked: server, size = 16, className, quiet }: { target: Target; liked?: boolean; size?: number; className?: string; quiet?: boolean }) {
  // Hooks can't branch on the overload, so resolve the key first.
  const liked = useLiked(target.kind as 'track', (target.kind === 'artist' ? target.name : target.id) as never, server)
  const [pop, setPop] = useState(0)
  const title = liked ? 'Remove from Favorites' : 'Add to Favorites'
  return (
    <IconButton
      key={pop}
      icon="heart"
      filled={liked}
      size={size}
      active={liked}
      title={title}
      className={cx('heart-btn', liked && pop > 0 && 'pop', className)}
      onClick={(e) => {
        e.stopPropagation()
        if (!liked) setPop((n) => n + 1)
        void setLiked(target.kind === 'artist' ? { kind: 'artist', names: [target.name] } : { kind: target.kind, ids: [target.id] }, !liked, { quiet })
      }}
    />
  )
}
