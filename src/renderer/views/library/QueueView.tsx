// The phone's Queues page: the song playing and everything after it, with a counter ("12 / 40",
// time left), save as playlist, clear and options. Every song still to come can be dragged or removed.

import { cx, duration } from '../../lib/format'
import { cmd, usePlayer } from '../../state/player'
import { useViewHeader } from '../../shell/header'
import { QueueList, queueItems, saveQueueAsPlaylist } from '../../components/QueueList'
import { IconButton, showMenu } from '../../components/ui'
import { Icon } from '../../components/Icon'

export function QueueView() {
  const state = usePlayer((s) => s.state)
  // Whole seconds, so the page doesn't re-render on every position tick.
  const posSec = usePlayer((s) => Math.floor(s.positionMs / 1000))
  useViewHeader({ color: null, title: 'Queue' })
  const q = state?.queue
  const items = state ? queueItems() : []
  const done = q ? q.context.position + 1 : 0
  const total = q ? q.context.length + q.upNext.length : 0
  const left = Math.max(0, items.reduce((n, it) => n + (it.durationMs ?? 0), 0) - posSec * 1000)
  const title = q?.context.source?.title ?? (state?.current ? 'Now playing' : 'Queue')
  return (
    <div className="view queue-view">
      <div className="qv-head">
        <div className="qv-title">
          <Icon name="queue" size={24} />
          <span className="ellipsis">{title}</span>
        </div>
        <div className="qv-bar">
          <IconButton icon={state?.playing ? 'pause' : 'play'} size={24} title={state?.playing ? 'Pause' : 'Play'} disabled={!state?.current} onClick={() => cmd({ type: 'toggle' })} />
          <div className="qv-count">
            <b className="tnum">{state?.current ? `${Math.min(done, total)} / ${total}` : '0 / 0'}</b>
            <span className={cx('faint', 'tnum')}>
              <Icon name="timer" size={13} /> {duration(left)} left
            </span>
          </div>
          <IconButton icon="save" size={22} title="Save the queue as a playlist" disabled={items.length < 2} onClick={saveQueueAsPlaylist} />
          <IconButton
            icon="more"
            size={22}
            title="Options"
            onClick={(e) =>
              showMenu(e, [
                { label: 'Save as playlist', icon: 'playlistAdd', disabled: items.length < 2, onClick: saveQueueAsPlaylist },
                { label: 'Clear songs you queued', icon: 'close', disabled: !q?.upNext.length, onClick: () => cmd({ type: 'clearUpNext' }) },
              ])
            }
          />
        </div>
      </div>
      <QueueList page />
    </div>
  )
}
