// Floating Liquid Glass player bar: now playing, transport + seek, rating, volume, drawers.

import { useState } from 'react'
import { LIB } from '@shared/ipc/library'
import { invoke } from '../lib/ipc'
import { cx, duration } from '../lib/format'
import { cmd, usePlayer } from '../state/player'
import { useCurrentTrack } from '../state/current'
import { navigate, useUi } from '../state/ui'
import { Artwork, IconButton, Slider, Stars } from '../components/ui'
import { Icon } from '../components/Icon'

function Seek() {
  const pos = usePlayer((s) => s.positionMs)
  const dur = usePlayer((s) => s.durationMs || s.state?.current?.durationMs || 0)
  const [drag, setDrag] = useState<number | null>(null)
  const shown = drag ?? pos
  return (
    <div className="pb-seek">
      <span>{duration(shown)}</span>
      <Slider
        value={shown}
        max={Math.max(1, dur)}
        label="Seek"
        onChange={setDrag}
        onCommit={(v) => {
          setDrag(null)
          cmd({ type: 'seek', positionMs: v })
        }}
      />
      <span>-{duration(Math.max(0, dur - shown))}</span>
    </div>
  )
}

function Volume() {
  const volume = usePlayer((s) => s.state?.volume ?? 1)
  const muted = usePlayer((s) => !!s.state?.muted)
  const icon = muted || volume === 0 ? 'mute' : volume < 0.5 ? 'volumeLow' : 'volume'
  return (
    <>
      <IconButton icon={icon} size={17} title={muted ? 'Unmute' : 'Mute'} onClick={() => cmd({ type: 'setMuted', muted: !muted })} />
      <div className="pb-volume" onWheel={(e) => cmd({ type: 'setVolume', volume: Math.min(1, Math.max(0, volume - Math.sign(e.deltaY) * 0.05)) })}>
        <Slider value={muted ? 0 : volume} max={1} label="Volume" onChange={(v) => cmd({ type: 'setVolume', volume: v })} onCommit={(v) => cmd({ type: 'setVolume', volume: v })} />
      </div>
    </>
  )
}

export function PlayerBar() {
  const state = usePlayer((s) => s.state)
  const artHash = usePlayer((s) => s.currentArtHash)
  const drawer = useUi((s) => s.drawer)
  const toggleDrawer = useUi((s) => s.toggleDrawer)
  const route = useUi((s) => s.route)
  const track = useCurrentTrack()
  const cur = state?.current
  const playing = !!state?.playing
  const repeat = state?.repeat ?? 'off'
  return (
    <div className="playerbar glass liquid">
      <div className="pb-now">
        {cur ? (
          <>
            <button className="pb-art" title={route.view === 'nowplaying' ? 'Back' : 'Now Playing'} onClick={() => (route.view === 'nowplaying' ? useUi.getState().goBack() : navigate({ view: 'nowplaying' }))}>
              <Artwork hash={artHash} url={artHash ? undefined : cur.artUrl} px={128} title={cur.album || cur.title} />
              <span className="pb-art-hover">
                <Icon name="expand" size={16} />
              </span>
            </button>
            <div className="pb-meta">
              <span className="pb-title ellipsis link-muted" onClick={() => navigate({ view: 'nowplaying' })}>
                {cur.title}
              </span>
              <span className="pb-artist ellipsis">
                <a className="link-muted" onClick={() => navigate({ view: 'artist', artist: track?.albumArtist || cur.artist })}>
                  {cur.artist}
                </a>
                {cur.album && (
                  <>
                    {' — '}
                    <a className="link-muted" onClick={() => track?.albumId != null && navigate({ view: 'album', id: track.albumId })}>
                      {cur.album}
                    </a>
                  </>
                )}
              </span>
              {track && (
                <span style={{ marginTop: 2 }}>
                  <Stars rating={track.rating} size={11} onRate={(s) => void invoke(LIB.setRating, [track.id], s)} />
                </span>
              )}
            </div>
          </>
        ) : (
          <span className="pb-idle">Not playing</span>
        )}
      </div>
      <div className="pb-center">
        <div className="pb-transport">
          <IconButton icon="shuffle" size={16} active={state?.shuffle} title="Shuffle" onClick={() => cmd({ type: 'setShuffle', shuffle: !state?.shuffle })} />
          <IconButton icon="prev" size={20} title="Previous" onClick={() => cmd({ type: 'prev' })} disabled={!cur} />
          <IconButton className="pb-play" icon={playing ? 'pause' : 'play'} size={26} title={playing ? 'Pause' : 'Play'} onClick={() => cmd({ type: 'toggle' })} disabled={!cur} />
          <IconButton icon="next" size={20} title="Next" onClick={() => cmd({ type: 'next' })} disabled={!cur} />
          <IconButton
            icon="repeat"
            size={16}
            active={repeat !== 'off'}
            className={cx(repeat === 'one' && 'pb-repeat-one')}
            title={repeat === 'off' ? 'Repeat' : repeat === 'all' ? 'Repeat All' : 'Repeat One'}
            onClick={() => cmd({ type: 'cycleRepeat' })}
          />
        </div>
        <Seek />
      </div>
      <div className="pb-right">
        {state?.buffering && <span className="spinner" style={{ width: 14, height: 14, marginRight: 6 }} />}
        <IconButton icon="lyrics" size={17} title="Lyrics" active={drawer === 'lyrics'} onClick={() => toggleDrawer('lyrics')} />
        <IconButton icon="queue" size={17} title="Up Next" active={drawer === 'queue'} onClick={() => toggleDrawer('queue')} />
        <IconButton icon="mini" size={17} title="Mini Player" onClick={() => window.valence.send('mini:toggle')} />
        <Volume />
      </div>
    </div>
  )
}
