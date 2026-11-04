// Page building blocks shared by album, artist, playlist and home views: the colored hero header
// (art opens the zoomable viewer), the action bar with the big play button, and shelves.

import type { ReactNode } from 'react'
import { cx } from '../lib/format'
import { useUi } from '../state/ui'
import { cmd, usePlayer } from '../state/player'
import type { QueueSource } from '../audio'
import { useHeaderColor } from '../theme/accent'
import { useViewHeader } from '../shell/header'
import { Artwork } from './ui'
import { Icon } from './Icon'

/** Whether `source` is what's playing now (so its play button shows pause). */
export function useSourcePlaying(match: (s: QueueSource | null | undefined) => boolean): { current: boolean; playing: boolean } {
  const current = usePlayer((s) => !!s.state?.current && match(s.state?.queue.context.source))
  const playing = usePlayer((s) => current && !!s.state?.playing)
  return { current, playing }
}

export function PlayButton({ onPlay, current, playing, size, title }: { onPlay: () => void; current?: boolean; playing?: boolean; size?: 'sm' | 'xs'; title?: string }) {
  return (
    <button
      className={cx('play-btn', size)}
      title={playing ? 'Pause' : (title ?? 'Play')}
      onClick={(e) => {
        e.stopPropagation()
        if (current) cmd({ type: 'toggle' })
        else onPlay()
      }}
    >
      <Icon name={playing ? 'pause' : 'play'} size={size === 'xs' ? 14 : size === 'sm' ? 20 : 24} />
    </button>
  )
}

/** Album-colored hero; also tells the sticky header its color and title. */
export function Hero({
  art,
  kicker,
  title,
  sub,
  info,
  play,
  round,
  tile,
}: {
  art?: { hash: string | null | undefined; albumId?: number | null; title?: string; sub?: string }
  kicker?: ReactNode
  title: string
  sub?: ReactNode
  info?: ReactNode
  play?: () => void
  round?: boolean
  /** Shown in place of artwork (Liked Songs, playlists without art). */
  tile?: ReactNode
}) {
  const color = useHeaderColor(art?.hash)
  useViewHeader({ color, strong: true, title, play })
  const long = title.length > 28
  return (
    <div className="hero">
      {tile ??
        (art && (
          <button
            className={cx('hero-art-btn', round && 'round')}
            title="View artwork"
            onClick={() => useUi.getState().openArt({ hash: art.hash ?? null, albumId: art.albumId, title: art.title ?? title, sub: art.sub })}
          >
            <Artwork hash={art.hash} px={600} className={cx('hero-art', round && 'round')} title={title} />
          </button>
        ))}
      <div className="hero-meta">
        {kicker && <span className="hero-kicker">{kicker}</span>}
        <h1 className={cx('hero-title', long && 'long')} title={title}>
          {title}
        </h1>
        {sub && <span className="hero-sub">{sub}</span>}
        {info && <span className="hero-info">{info}</span>}
      </div>
    </div>
  )
}

export function ActionBar({ children }: { children: ReactNode }) {
  return <div className="action-bar">{children}</div>
}

/** A titled row of cards; "Show all" when it overflows. */
export function Shelf({ title, sub, onMore, children }: { title: ReactNode; sub?: ReactNode; onMore?: () => void; children: ReactNode }) {
  return (
    <section className="section">
      <div className="section-head">
        <div>
          <h2 className="section-title">{onMore ? <a onClick={onMore}>{title}</a> : title}</h2>
          {sub && <div className="section-sub">{sub}</div>}
        </div>
        {onMore && (
          <button className="section-more" onClick={onMore}>
            Show all
          </button>
        )}
      </div>
      <div className="shelf">{children}</div>
    </section>
  )
}
