// Right panel: what's playing (big art you can open full size, like, rating, track facts, next up),
// the queue (drag to reorder) and lyrics. Resizable from its left edge.

import { useState } from 'react'
import { LIB } from '@shared/ipc/library'
import type { PlayItem } from '../audio'
import { errorMessage, invoke } from '../lib/ipc'
import { cx, duration, plural, quality, relativeTime } from '../lib/format'
import { cmd, playTracks, trackIdOf, usePlayer } from '../state/player'
import { useCurrentTrack } from '../state/current'
import { useSetting } from '../state/library'
import { albumRoute, navigate, toast, useUi, RIGHT_MIN, type Panel } from '../state/ui'
import { Artwork, Button, Empty, IconButton, Stars, showMenu } from '../components/ui'
import { HeartButton } from '../components/Heart'
import { Icon } from '../components/Icon'
import { LyricsView } from './LyricsView'
import { sleepLabel, sleepMenuItems } from './PlayerBar'

function QueueItem({
  item,
  current,
  onPlay,
  onRemove,
  drag,
}: {
  item: PlayItem
  current?: boolean
  onPlay?: () => void
  onRemove?: () => void
  drag?: { index: number; over: number | null; setOver: (i: number | null) => void; from: number | null; setFrom: (i: number | null) => void }
}) {
  const playing = usePlayer((s) => !!s.state?.playing)
  return (
    <div
      className={cx('q-item', current && 'current', drag && drag.from === drag.index && 'dragging', drag && drag.over === drag.index && drag.from !== drag.index && 'drop-before')}
      onDoubleClick={onPlay}
      draggable={!!drag}
      onDragStart={(e) => {
        if (!drag) return
        e.dataTransfer.effectAllowed = 'move'
        e.dataTransfer.setData('text/plain', String(drag.index))
        drag.setFrom(drag.index)
      }}
      onDragOver={(e) => {
        if (!drag || drag.from == null) return
        e.preventDefault()
        drag.setOver(drag.index)
      }}
      onDrop={(e) => {
        if (!drag || drag.from == null) return
        e.preventDefault()
        if (drag.from !== drag.index) cmd({ type: 'moveUpNext', from: drag.from, to: drag.index > drag.from ? drag.index - 1 : drag.index })
        drag.setFrom(null)
        drag.setOver(null)
      }}
      onDragEnd={() => {
        drag?.setFrom(null)
        drag?.setOver(null)
      }}
      onContextMenu={(e) =>
        showMenu(e, [
          ...(onPlay ? [{ label: 'Play now', icon: 'play' as const, onClick: onPlay }] : []),
          ...(onRemove ? [{ label: 'Remove from queue', icon: 'close' as const, onClick: onRemove }] : []),
          ...(trackIdOf(item) != null ? [{ label: 'Get Info', icon: 'info' as const, onClick: () => useUi.getState().openGetInfo([trackIdOf(item)!]) }] : []),
        ])
      }
    >
      <span className="q-art">
        <Artwork url={item.artUrl} px={96} title={item.album || item.title} />
        {onPlay && (
          <button className="q-play" title="Play" onClick={onPlay}>
            <Icon name="play" size={14} />
          </button>
        )}
      </span>
      <div className="list-main">
        <div className={cx('list-title', current && 'accent')}>
          {current && (
            <span className={cx('now-bars', playing && 'on')}>
              <i />
              <i />
              <i />
            </span>
          )}
          {item.title}
        </div>
        <div className="list-sub">{item.artist}</div>
      </div>
      <span className="faint tnum q-dur">{duration(item.durationMs)}</span>
      {onRemove && (
        <span className="q-actions">
          <IconButton icon="close" size={14} title="Remove" onClick={onRemove} />
        </span>
      )}
    </div>
  )
}

function QueuePanel() {
  const state = usePlayer((s) => s.state)
  const [from, setFrom] = useState<number | null>(null)
  const [over, setOver] = useState<number | null>(null)
  const [showHistory, setShowHistory] = useState(false)
  if (!state) return null
  const q = state.queue
  const src = q.context.source
  const cont = q.continuation
  const all = [state.current, ...q.upNext, ...q.context.upcoming].filter(Boolean) as PlayItem[]
  const saveAsPlaylist = () => {
    const ids = all.map(trackIdOf).filter((x): x is number => x != null)
    if (!ids.length) return
    window.dispatchEvent(new CustomEvent('valence:new-playlist', { detail: ids }))
  }
  return (
    <>
      {state.current && (
        <>
          <div className="q-section">Now playing</div>
          <QueueItem item={state.current} current />
        </>
      )}
      {q.upNext.length > 0 && (
        <>
          <div className="q-section">
            <span>Next in queue</span>
            <Button kind="ghost" small onClick={() => cmd({ type: 'clearUpNext' })}>
              Clear queue
            </Button>
          </div>
          {q.upNext.map((it, i) => (
            <QueueItem
              key={`${it.id}-${i}`}
              item={it}
              onPlay={() => cmd({ type: 'playUpNextAt', index: i })}
              onRemove={() => cmd({ type: 'removeUpNext', index: i })}
              drag={{ index: i, over, setOver, from, setFrom }}
            />
          ))}
        </>
      )}
      {q.context.upcoming.length > 0 && (
        <>
          <div className="q-section">
            <span className="ellipsis">{src?.kind === 'autoplay' ? 'Autoplay' : src?.title ? `Next from: ${src.title}` : 'Next up'}</span>
            <span className="tnum faint">{q.context.length - q.context.position - 1}</span>
          </div>
          {q.context.upcoming.map((it, i) => (
            <QueueItem key={`${it.id}-c${i}`} item={it} onPlay={() => cmd({ type: 'jumpTo', position: q.context.position + 1 + i })} />
          ))}
        </>
      )}
      {cont && cont.upcoming.length > 0 && (
        <>
          <div className="q-section">
            <span className="row" style={{ gap: 6 }}>
              <Icon name="sparkle" size={13} /> Autoplay · similar music
            </span>
          </div>
          {cont.upcoming.slice(0, 10).map((it, i) => (
            <QueueItem key={`${it.id}-a${i}`} item={it} />
          ))}
        </>
      )}
      {!state.current && !q.upNext.length && !q.context.upcoming.length && (
        <Empty icon="queue" title="Your queue is empty">
          Right-click a song and choose Play Next or Add to Queue.
        </Empty>
      )}
      {all.length > 1 && (
        <div className="q-foot">
          <Button small icon="playlist" onClick={saveAsPlaylist}>
            Save as playlist
          </Button>
        </div>
      )}
      {q.history.length > 0 && (
        <>
          <div className="q-section">
            <span>Recently played</span>
            <Button kind="ghost" small onClick={() => setShowHistory(!showHistory)}>
              {showHistory ? 'Hide' : 'Show'}
            </Button>
          </div>
          {showHistory &&
            q.history
              .slice()
              .reverse()
              .map((it, i) => (
                <QueueItem
                  key={`${it.id}-h${i}`}
                  item={it}
                  onPlay={() => {
                    const id = trackIdOf(it)
                    if (id != null) void playTracks([id], 0, { kind: 'other', title: 'Recently played' })
                  }}
                />
              ))}
        </>
      )}
    </>
  )
}

function InfoPanel() {
  const cur = usePlayer((s) => s.state?.current ?? null)
  const artHash = usePlayer((s) => s.currentArtHash)
  const q = usePlayer((s) => s.state?.queue)
  const sleep = usePlayer((s) => s.state?.sleep ?? s.sleep)
  const stopAfter = usePlayer((s) => s.state?.stopAfterCurrent ?? s.stopAfterCurrent)
  const track = useCurrentTrack()
  const [showFacts] = useSetting('ui.panel.facts', true)
  if (!cur) return <Empty icon="songs" title="Nothing playing">Play something and it shows up here, with its art, details and what's next.</Empty>
  const next = q?.upNext[0] ?? q?.context.upcoming[0] ?? q?.continuation?.upcoming[0] ?? null
  const sl = sleepLabel(sleep)
  return (
    <div className="rp-info">
      <button
        className="rp-art"
        title="View artwork"
        onClick={() => useUi.getState().openArt({ hash: artHash, albumId: track?.albumId ?? null, url: artHash ? undefined : cur.artUrl, title: cur.album || cur.title, sub: track?.albumArtist || cur.artist })}
      >
        <Artwork hash={artHash} url={artHash ? undefined : cur.artUrl} px={640} title={cur.album || cur.title} />
        <span className="rp-art-zoom">
          <Icon name="zoomIn" size={18} />
        </span>
      </button>
      <div className="rp-title-row">
        <div style={{ minWidth: 0, flex: 1 }}>
          <div className="rp-title ellipsis">
            <a className="link-muted" onClick={() => track?.albumId != null && navigate(albumRoute(track.albumId, track.hqRip))}>
              {cur.title}
            </a>
          </div>
          <div className="rp-sub ellipsis">
            <a className="link-muted" onClick={() => navigate({ view: 'artist', artist: track?.albumArtist || cur.artist })}>
              {cur.artist}
            </a>
          </div>
        </div>
        {track && <HeartButton target={{ kind: 'track', id: track.id }} liked={track.liked} size={20} />}
      </div>
      {track && (
        <div className="rp-rating">
          <Stars rating={track.rating} size={14} onRate={(s) => void invoke(LIB.setRating, [track.id], s).catch((e) => toast(errorMessage(e), 'error'))} />
        </div>
      )}
      {(sl || stopAfter) && (
        <button
          className="rp-card rp-sleep"
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect()
            showMenu({ clientX: r.left, clientY: r.bottom + 4 }, sleepMenuItems(sleep, stopAfter))
          }}
        >
          <Icon name="moon" size={16} />
          <span>{sl ? `Sleep timer · ${sl}` : 'Stopping after this song'}</span>
        </button>
      )}
      {track && showFacts && (
        <div className="rp-card">
          <h4>About this track</h4>
          <dl className="rp-facts">
            {track.album && (
              <>
                <dt>Album</dt>
                <dd>
                  <a className="link-muted" onClick={() => track.albumId != null && navigate(albumRoute(track.albumId, track.hqRip))}>
                    {track.album}
                  </a>
                </dd>
              </>
            )}
            {track.year && (
              <>
                <dt>Year</dt>
                <dd>{track.year}</dd>
              </>
            )}
            {track.genre && (
              <>
                <dt>Genre</dt>
                <dd>
                  <a className="link-muted" onClick={() => navigate({ view: 'genre', genre: track.genre! })}>
                    {track.genre}
                  </a>
                </dd>
              </>
            )}
            {track.composer && (
              <>
                <dt>Composer</dt>
                <dd>{track.composer}</dd>
              </>
            )}
            <dt>Quality</dt>
            <dd>
              <span className={cx('q-badge', track.lossless && 'hi')}>{quality(track)}</span>
            </dd>
            <dt>Plays</dt>
            <dd>
              {track.playCount ? plural(track.playCount, 'play') : 'Never played'}
              {track.lastPlayed ? <span className="faint"> · last {relativeTime(track.lastPlayed)}</span> : null}
            </dd>
            <dt>Added</dt>
            <dd>{relativeTime(track.addedAt)}</dd>
            {track.likedAt && (
              <>
                <dt>Liked</dt>
                <dd>{relativeTime(track.likedAt)}</dd>
              </>
            )}
            {track.rgTrackGain != null && (
              <>
                <dt>Loudness</dt>
                <dd>
                  {track.rgTrackGain > 0 ? '+' : ''}
                  {track.rgTrackGain.toFixed(1)} dB ReplayGain
                </dd>
              </>
            )}
          </dl>
        </div>
      )}
      {next && (
        <div className="rp-card">
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <h4>Next in queue</h4>
            <a className="link-muted small" onClick={() => useUi.getState().setDrawer('queue')}>
              Open queue
            </a>
          </div>
          <div className="rp-next" onDoubleClick={() => cmd({ type: 'next' })}>
            <Artwork url={next.artUrl} px={96} title={next.album || next.title} />
            <div className="list-main">
              <div className="list-title">{next.title}</div>
              <div className="list-sub">{next.artist}</div>
            </div>
            <IconButton icon="next" size={16} title="Skip to it" onClick={() => cmd({ type: 'next' })} />
          </div>
        </div>
      )}
    </div>
  )
}

const TABS: Array<{ value: Panel; label: string }> = [
  { value: 'info', label: 'Now playing' },
  { value: 'queue', label: 'Queue' },
  { value: 'lyrics', label: 'Lyrics' },
]

export function RightPanel() {
  const drawer = useUi((s) => s.drawer)
  const [last, setLast] = useState<Panel>('info')
  const tab = drawer ?? last
  if (drawer && drawer !== last) setLast(drawer)
  return (
    <aside className={cx('rightpanel', drawer && 'open')} aria-hidden={!drawer}>
      <div className="rp-inner">
        <div className="rp-head">
          <div className="rp-tabs" role="tablist">
            {TABS.map((t) => (
              <button key={t.value} role="tab" aria-selected={tab === t.value} className={cx('pill sm', tab === t.value && 'on')} onClick={() => useUi.getState().setDrawer(t.value)}>
                {t.label}
              </button>
            ))}
          </div>
          <IconButton icon="close" size={16} title="Close" onClick={() => useUi.getState().setDrawer(null)} />
        </div>
        <div className={cx('rp-body', 'lyrics-scroll', tab === 'lyrics' && 'rp-lyrics')}>{tab === 'queue' ? <QueuePanel /> : tab === 'lyrics' ? <LyricsView /> : <InfoPanel />}</div>
      </div>
      <ResizeHandle />
    </aside>
  )
}

function ResizeHandle() {
  const [drag, setDrag] = useState(false)
  return (
    <div
      className={cx('rp-resize', drag && 'dragging')}
      title="Drag to resize"
      onPointerDown={(e) => {
        const el = e.currentTarget
        el.setPointerCapture(e.pointerId)
        setDrag(true)
        const right = el.parentElement!.getBoundingClientRect().right
        const move = (ev: PointerEvent) => {
          const w = right - ev.clientX
          if (w < RIGHT_MIN - 80) useUi.getState().setDrawer(null)
          else useUi.getState().setRightW(w)
        }
        const up = () => {
          setDrag(false)
          el.removeEventListener('pointermove', move)
          el.removeEventListener('pointerup', up)
        }
        el.addEventListener('pointermove', move)
        el.addEventListener('pointerup', up)
      }}
    />
  )
}
