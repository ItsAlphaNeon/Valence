// Right panel: what's playing (big art you can open full size, like, rating, track facts, next up),
// the queue (drag to reorder) and lyrics. Resizable from its left edge.

import { useState } from 'react'
import { LIB } from '@shared/ipc/library'
import { errorMessage, invoke } from '../lib/ipc'
import { cx, duration, plural, quality, relativeTime } from '../lib/format'
import { cmd, usePlayer } from '../state/player'
import { useCurrentTrack } from '../state/current'
import { useSetting } from '../state/library'
import { albumRoute, navigate, toast, useUi, RIGHT_MIN, type Panel } from '../state/ui'
import { Artwork, Empty, IconButton, Stars, showMenu } from '../components/ui'
import { HeartButton } from '../components/Heart'
import { Icon } from '../components/Icon'
import { LyricsView } from './LyricsView'
import { QueueList } from '../components/QueueList'
import { sleepLabel, sleepMenuItems } from './PlayerBar'

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
                <dt>Favorited</dt>
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
        <div className={cx('rp-body', 'lyrics-scroll', tab === 'lyrics' && 'rp-lyrics')}>{tab === 'queue' ? <QueueList /> : tab === 'lyrics' ? <LyricsView /> : <InfoPanel />}</div>
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
