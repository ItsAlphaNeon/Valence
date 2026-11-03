// Lyrics for the current track: synced LRC scrolls and highlights with playback (click a line to
// seek); plain lyrics render as text.

import { useEffect, useRef } from 'react'
import { activeLine } from '../lib/lrc'
import { cx } from '../lib/format'
import { useCurrentLyrics } from '../state/current'
import { cmd, usePlayer } from '../state/player'
import { Empty, Spinner } from '../components/ui'

/** Lyrics lead the audio slightly so the highlight lands as the line is sung. */
const LEAD_MS = 250

export function LyricsView({ big }: { big?: boolean }) {
  const { lyrics, loading, trackId } = useCurrentLyrics()
  const pos = usePlayer((s) => s.positionMs)
  const ref = useRef<HTMLDivElement>(null)
  const userScrolled = useRef(0)
  const idx = lyrics?.synced ? activeLine(lyrics.lines, pos + LEAD_MS) : -1

  useEffect(() => {
    if (!lyrics?.synced || idx < 0) return
    if (Date.now() - userScrolled.current < 4000) return
    const el = ref.current?.querySelector<HTMLElement>(`[data-i="${idx}"]`)
    const sc = ref.current?.closest<HTMLElement>('.lyrics-scroll')
    if (!el || !sc) return
    const target = el.offsetTop - sc.clientHeight * 0.36
    sc.scrollTo({ top: target, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })
  }, [idx, lyrics])

  useEffect(() => {
    ref.current?.closest<HTMLElement>('.lyrics-scroll')?.scrollTo({ top: 0 })
  }, [trackId])

  if (trackId == null) return <Empty icon="lyrics" title="Nothing playing" />
  if (loading) return <div className="center-spin"><Spinner /></div>
  if (!lyrics) return <Empty icon="lyrics" title="No lyrics">Lyrics are fetched from LRCLIB on import when available.</Empty>

  return (
    <div
      ref={ref}
      className={cx('lyrics', big && 'big', lyrics.synced ? 'synced' : 'plain')}
      onWheel={() => (userScrolled.current = Date.now())}
    >
      {lyrics.lines.map((l, i) => (
        <p
          key={i}
          data-i={i}
          className={cx('lyric-line', lyrics.synced && i === idx && 'on', lyrics.synced && i < idx && 'past')}
          onClick={() => {
            if (l.t == null) return
            userScrolled.current = 0
            cmd({ type: 'seek', positionMs: l.t })
            cmd({ type: 'play' })
          }}
        >
          {l.text || (lyrics.synced ? '♪' : ' ')}
        </p>
      ))}
    </div>
  )
}
