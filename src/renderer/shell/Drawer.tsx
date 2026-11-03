// Right-hand drawer: Up Next queue (drag to reorder) or lyrics.

import { useState } from 'react'
import type { PlayItem } from '../audio'
import { cx, duration } from '../lib/format'
import { cmd, usePlayer } from '../state/player'
import { useUi } from '../state/ui'
import { Artwork, Button, IconButton, Segmented, showMenu } from '../components/ui'
import { LyricsView } from './LyricsView'

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
          ...(onPlay ? [{ label: 'Play Now', icon: 'play' as const, onClick: onPlay }] : []),
          ...(onRemove ? [{ label: 'Remove from Up Next', icon: 'close' as const, onClick: onRemove }] : []),
        ])
      }
    >
      <Artwork url={item.artUrl} title={item.album || item.title} />
      <div className="list-main">
        <div className="list-title">{item.title}</div>
        <div className="list-sub">{item.artist}</div>
      </div>
      <span className="faint tnum" style={{ fontSize: 11 }}>
        {duration(item.durationMs)}
      </span>
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
  return (
    <>
      {state.current && (
        <>
          <div className="q-section">Now Playing</div>
          <QueueItem item={state.current} current />
        </>
      )}
      {q.upNext.length > 0 && (
        <>
          <div className="q-section">
            <span>Up Next</span>
            <Button kind="ghost" small onClick={() => cmd({ type: 'clearUpNext' })}>
              Clear
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
            <span className="ellipsis">{src?.title ? `Continuing from ${src.title}` : 'Continuing'}</span>
            <span className="tnum">{q.context.length - q.context.position - 1}</span>
          </div>
          {q.context.upcoming.map((it, i) => (
            <QueueItem key={`${it.id}-c${i}`} item={it} onPlay={() => cmd({ type: 'jumpTo', position: q.context.position + 1 + i })} />
          ))}
        </>
      )}
      {!state.current && !q.upNext.length && !q.context.upcoming.length && <div className="empty">Nothing queued</div>}
      {q.history.length > 0 && (
        <>
          <div className="q-section">
            <span>History</span>
            <Button kind="ghost" small onClick={() => setShowHistory(!showHistory)}>
              {showHistory ? 'Hide' : 'Show'}
            </Button>
          </div>
          {showHistory && q.history.slice().reverse().map((it, i) => <QueueItem key={`${it.id}-h${i}`} item={it} />)}
        </>
      )}
    </>
  )
}

export function Drawer() {
  const drawer = useUi((s) => s.drawer)
  const setDrawer = useUi((s) => s.setDrawer)
  const [last, setLast] = useState<'queue' | 'lyrics'>('queue')
  const tab = drawer ?? last
  if (drawer && drawer !== last) setLast(drawer)
  return (
    <aside className={cx('drawer', drawer && 'open')} aria-hidden={!drawer}>
      <div className="drawer-inner">
        <div className="drawer-head drag">
          <Segmented
            value={tab}
            options={[
              { value: 'queue', label: 'Up Next' },
              { value: 'lyrics', label: 'Lyrics' },
            ]}
            onChange={(v) => setDrawer(v)}
          />
          <span className="grow" />
          <IconButton icon="close" title="Close" onClick={() => setDrawer(null)} />
        </div>
        <div className="drawer-body lyrics-scroll">{tab === 'queue' ? <QueuePanel /> : <LyricsView />}</div>
      </div>
    </aside>
  )
}
