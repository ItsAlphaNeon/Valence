// The queue as a list: what's playing, your "next" songs (drag to reorder), the rest of the source
// you're playing from, autoplay and recently played. Used by the right panel's Queue tab and by the
// Queue page, which shows the phone's bigger rows (handle, cover, three lines, options button).

import { useState } from 'react'
import type { PlayItem } from '../audio'
import { cx, duration } from '../lib/format'
import { cmd, playTracks, trackIdOf, usePlayer } from '../state/player'
import { useUi } from '../state/ui'
import { Artwork, Button, Empty, IconButton, showMenu } from './ui'
import { Icon } from './Icon'

/** Everything left to play, starting with the current song. */
export function queueItems(): PlayItem[] {
  const state = usePlayer.getState().state
  if (!state) return []
  const q = state.queue
  return [state.current, ...q.upNext, ...q.context.upcoming].filter(Boolean) as PlayItem[]
}

/** Asks the sidebar to make a playlist of the queue (it owns the name prompt). */
export function saveQueueAsPlaylist(): void {
  const ids = queueItems()
    .map(trackIdOf)
    .filter((x): x is number => x != null)
  if (ids.length) window.dispatchEvent(new CustomEvent('valence:new-playlist', { detail: ids }))
}

function QueueItem({
  item,
  current,
  page,
  onPlay,
  onRemove,
  drag,
}: {
  item: PlayItem
  current?: boolean
  page?: boolean
  onPlay?: () => void
  onRemove?: () => void
  drag?: { index: number; over: number | null; setOver: (i: number | null) => void; from: number | null; setFrom: (i: number | null) => void }
}) {
  const menu = (e: { clientX: number; clientY: number }) =>
    showMenu(e, [
      ...(onPlay ? [{ label: 'Play now', icon: 'play' as const, onClick: onPlay }] : []),
      ...(onRemove ? [{ label: 'Remove from queue', icon: 'close' as const, onClick: onRemove }] : []),
      ...(trackIdOf(item) != null ? [{ label: 'Get Info', icon: 'info' as const, onClick: () => useUi.getState().openGetInfo([trackIdOf(item)!]) }] : []),
    ])
  return (
    <div
      className={cx('q-item', page && 'page', current && 'current', drag && drag.from === drag.index && 'dragging', drag && drag.over === drag.index && drag.from !== drag.index && 'drop-before')}
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
      onContextMenu={menu}
    >
      {page && <span className={cx('q-handle', !drag && 'off')}>{drag ? <Icon name="dragHandle" size={22} /> : null}</span>}
      <span className="q-art">
        <Artwork url={item.artUrl} px={page ? 120 : 96} title={item.album || item.title} />
        {onPlay && (
          <button className="q-play" title="Play" onClick={onPlay}>
            <Icon name="play" size={16} />
          </button>
        )}
      </span>
      <div className="list-main">
        <div className="list-title">{item.title}</div>
        <div className="list-sub">{item.artist}</div>
        {page && item.album && <div className="list-sub">{item.album}</div>}
      </div>
      <span className="tnum q-dur">{duration(item.durationMs)}</span>
      {page ? (
        <IconButton icon="more" size={22} title="Options" className="q-more" onClick={(e) => menu(e)} />
      ) : (
        onRemove && (
          <span className="q-actions">
            <IconButton icon="close" size={16} title="Remove" onClick={onRemove} />
          </span>
        )
      )}
    </div>
  )
}

export function QueueList({ page }: { page?: boolean }) {
  const state = usePlayer((s) => s.state)
  const [from, setFrom] = useState<number | null>(null)
  const [over, setOver] = useState<number | null>(null)
  const [showHistory, setShowHistory] = useState(false)
  if (!state) return null
  const q = state.queue
  const src = q.context.source
  const cont = q.continuation
  const total = [state.current, ...q.upNext, ...q.context.upcoming].filter(Boolean).length
  return (
    <div className={cx('q-list', page && 'page')}>
      {state.current && (
        <>
          <div className="q-section">Now playing</div>
          <QueueItem item={state.current} current page={page} />
        </>
      )}
      {q.upNext.length > 0 && (
        <>
          <div className="q-section">
            <span>Next in queue</span>
            <Button kind="ghost" small onClick={() => cmd({ type: 'clearUpNext' })}>
              Clear
            </Button>
          </div>
          {q.upNext.map((it, i) => (
            <QueueItem
              key={`${it.id}-${i}`}
              item={it}
              page={page}
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
            <QueueItem key={`${it.id}-c${i}`} item={it} page={page} onPlay={() => cmd({ type: 'jumpTo', position: q.context.position + 1 + i })} />
          ))}
        </>
      )}
      {cont && cont.upcoming.length > 0 && (
        <>
          <div className="q-section">
            <span className="row" style={{ gap: 6 }}>
              <Icon name="sparkle" size={15} /> Autoplay · similar music
            </span>
          </div>
          {cont.upcoming.slice(0, 10).map((it, i) => (
            <QueueItem key={`${it.id}-a${i}`} item={it} page={page} />
          ))}
        </>
      )}
      {!state.current && !q.upNext.length && !q.context.upcoming.length && (
        <Empty icon="queue" title="Your queue is empty">
          Play an album, a playlist or a song. Right-click a song for Play Next and Add to Queue.
        </Empty>
      )}
      {!page && total > 1 && (
        <div className="q-foot">
          <Button small icon="playlistAdd" onClick={saveQueueAsPlaylist}>
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
                  page={page}
                  onPlay={() => {
                    const id = trackIdOf(it)
                    if (id != null) void playTracks([id], 0, { kind: 'other', title: 'Recently played' })
                  }}
                />
              ))}
        </>
      )}
    </div>
  )
}
