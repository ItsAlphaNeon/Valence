// Player bar along the bottom: now playing (art, title, like) | transport + seek | sleep timer,
// panels, mini player and volume.

import { useEffect, useState } from 'react'
import { cx, duration } from '../lib/format'
import { cmd, setSleepTimer, setStopAfterCurrent, usePlayer, type SleepTimer } from '../state/player'
import { useCurrentTrack } from '../state/current'
import { useSetting } from '../state/library'
import { albumRoute, navigate, useUi, type Panel } from '../state/ui'
import { Artwork, IconButton, Slider, showMenu, type MenuItem } from '../components/ui'
import { HeartButton } from '../components/Heart'
import { Icon } from '../components/Icon'
import { MOD } from './TopBar'

function Seek() {
  const pos = usePlayer((s) => s.positionMs)
  const dur = usePlayer((s) => s.durationMs || s.state?.current?.durationMs || 0)
  const has = usePlayer((s) => !!s.state?.current)
  const [remaining, setRemaining] = useSetting('ui.player.remaining', false)
  const [drag, setDrag] = useState<number | null>(null)
  const shown = drag ?? pos
  return (
    <div className={cx('pb-seek', !has && 'idle')}>
      <span>{has ? duration(shown) : '-:--'}</span>
      <Slider
        value={has ? shown : 0}
        max={Math.max(1, dur)}
        label="Seek"
        onChange={setDrag}
        onCommit={(v) => {
          setDrag(null)
          if (has) cmd({ type: 'seek', positionMs: v })
        }}
      />
      <span className="clickable" title={remaining ? 'Show total time' : 'Show time remaining'} onClick={() => setRemaining(!remaining)}>
        {!has ? '-:--' : remaining ? `-${duration(Math.max(0, dur - shown))}` : duration(dur)}
      </span>
    </div>
  )
}

function Volume() {
  const volume = usePlayer((s) => s.state?.volume ?? 1)
  const muted = usePlayer((s) => !!s.state?.muted)
  const icon = muted || volume === 0 ? 'mute' : volume < 0.5 ? 'volumeLow' : 'volume'
  return (
    <>
      <IconButton icon={icon} size={18} title={muted ? 'Unmute' : `Mute (${Math.round(volume * 100)}%)`} onClick={() => cmd({ type: 'setMuted', muted: !muted })} />
      <div className="pb-volume" title={`Volume ${Math.round((muted ? 0 : volume) * 100)}%`} onWheel={(e) => cmd({ type: 'setVolume', volume: Math.min(1, Math.max(0, volume - Math.sign(e.deltaY) * 0.05)) })}>
        <Slider value={muted ? 0 : volume} max={1} label="Volume" onChange={(v) => cmd({ type: 'setVolume', volume: v })} onCommit={(v) => cmd({ type: 'setVolume', volume: v })} />
      </div>
    </>
  )
}

function useNow(on: boolean): number {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (!on) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [on])
  return now
}

export function sleepLabel(t: SleepTimer, now = Date.now()): string | null {
  if (t.mode === 'time') {
    const left = Math.max(0, t.endsAt - now)
    const m = Math.floor(left / 60000)
    return m >= 60 ? `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')} h` : `${m}:${String(Math.floor((left % 60000) / 1000)).padStart(2, '0')}`
  }
  if (t.mode === 'track') return 'End of song'
  if (t.mode === 'album') return 'End of album'
  return null
}

export function sleepMenuItems(sleep: SleepTimer, stopAfter: boolean): MenuItem[] {
  const timed = (minutes: number): MenuItem => ({
    label: minutes >= 60 ? `${minutes / 60} hour${minutes > 60 ? 's' : ''}` : `${minutes} minutes`,
    checked: sleep.mode === 'time' && sleep.minutes === minutes,
    onClick: () => setSleepTimer({ mode: 'time', minutes, endsAt: Date.now() + minutes * 60_000 }),
  })
  return [
    { label: 'Sleep timer', disabled: true },
    timed(5),
    timed(15),
    timed(30),
    timed(45),
    timed(60),
    timed(120),
    { label: 'End of song', checked: sleep.mode === 'track', onClick: () => setSleepTimer({ mode: 'track' }) },
    { label: 'End of album', checked: sleep.mode === 'album', onClick: () => setSleepTimer({ mode: 'album' }) },
    ...(sleep.mode !== 'off' ? [{ label: 'Turn off timer', icon: 'close' as const, onClick: () => setSleepTimer({ mode: 'off' }) }] : []),
    { separator: true },
    { label: 'Stop after current song', checked: stopAfter, onClick: () => setStopAfterCurrent(!stopAfter) },
  ]
}

function SleepButton() {
  const sleep = usePlayer((s) => s.state?.sleep ?? s.sleep)
  const stopAfter = usePlayer((s) => s.state?.stopAfterCurrent ?? s.stopAfterCurrent)
  const now = useNow(sleep.mode === 'time')
  const label = sleepLabel(sleep, now)
  const on = sleep.mode !== 'off' || stopAfter
  return (
    <button
      className={cx('pb-chip', on && 'on', !label && !stopAfter && 'icon-only')}
      title={label ? `Sleep timer: ${label}` : stopAfter ? 'Stopping after this song' : 'Sleep timer'}
      onClick={(e) => {
        const r = e.currentTarget.getBoundingClientRect()
        showMenu({ clientX: r.left, clientY: r.top - 8 }, sleepMenuItems(sleep, stopAfter))
      }}
    >
      <Icon name={stopAfter && !label ? 'stop' : 'moon'} size={16} filled={stopAfter && !label} />
      {label && <span className="tnum">{label}</span>}
    </button>
  )
}

function PanelButton({ panel, icon, title }: { panel: Panel; icon: 'lyrics' | 'queue' | 'panel'; title: string }) {
  const drawer = useUi((s) => s.drawer)
  return <IconButton icon={icon} size={18} title={title} active={drawer === panel} className="dot" onClick={() => useUi.getState().toggleDrawer(panel)} />
}

export function PlayerBar() {
  const state = usePlayer((s) => s.state)
  const artHash = usePlayer((s) => s.currentArtHash)
  const route = useUi((s) => s.route)
  const track = useCurrentTrack()
  const cur = state?.current
  const playing = !!state?.playing
  const repeat = state?.repeat ?? 'off'
  const autoplay = state?.queue.context.source?.kind === 'autoplay'
  const openNowPlaying = () => (route.view === 'nowplaying' ? useUi.getState().goBack() : navigate({ view: 'nowplaying' }))
  return (
    <footer className="playerbar">
      <div className="pb-now">
        {cur ? (
          <>
            <button className="pb-art" title={route.view === 'nowplaying' ? 'Close Now Playing' : 'Now Playing'} onClick={openNowPlaying}>
              <Artwork hash={artHash} url={artHash ? undefined : cur.artUrl} px={128} title={cur.album || cur.title} />
              <span className="pb-art-hover">
                <Icon name={route.view === 'nowplaying' ? 'chevronDown' : 'expand'} size={16} />
              </span>
            </button>
            <div className="pb-meta">
              <span className="pb-title ellipsis">
                <a className="link-muted" onClick={() => (track?.albumId != null ? navigate(albumRoute(track.albumId, track.hqRip)) : openNowPlaying())}>
                  {cur.title}
                </a>
              </span>
              <span className="pb-artist ellipsis">
                <a className="link-muted" onClick={() => navigate({ view: 'artist', artist: track?.albumArtist || cur.artist })}>
                  {cur.artist}
                </a>
                {autoplay && (
                  <span className="pb-flag" title="Autoplay picked this from similar music in your library">
                    <Icon name="sparkle" size={11} /> Autoplay
                  </span>
                )}
              </span>
            </div>
            {track && <HeartButton className="pb-heart" target={{ kind: 'track', id: track.id }} liked={track.liked} size={18} />}
          </>
        ) : (
          <span className="pb-idle">Pick something to play</span>
        )}
      </div>
      <div className="pb-center">
        <div className="pb-transport">
          <IconButton icon="shuffle" size={18} active={state?.shuffle} className="dot" title={state?.shuffle ? 'Disable shuffle' : 'Enable shuffle'} onClick={() => cmd({ type: 'setShuffle', shuffle: !state?.shuffle })} />
          <IconButton icon="prev" size={18} filled title={`Previous (${MOD}+←)`} onClick={() => cmd({ type: 'prev' })} disabled={!cur} />
          <IconButton className="pb-play" icon={playing ? 'pause' : 'play'} size={18} filled title={playing ? 'Pause (Space)' : 'Play (Space)'} onClick={() => cmd({ type: 'toggle' })} disabled={!cur} />
          <IconButton icon="next" size={18} filled title={`Next (${MOD}+→)`} onClick={() => cmd({ type: 'next' })} disabled={!cur} />
          <IconButton
            icon="repeat"
            size={18}
            active={repeat !== 'off'}
            className={cx('dot', repeat === 'one' && 'pb-repeat-one')}
            title={repeat === 'off' ? 'Enable repeat' : repeat === 'all' ? 'Enable repeat one' : 'Disable repeat'}
            onClick={() => cmd({ type: 'cycleRepeat' })}
          />
        </div>
        <Seek />
      </div>
      <div className="pb-right">
        {state?.buffering && <span className="spinner" style={{ width: 14, height: 14, marginRight: 4 }} />}
        <SleepButton />
        <span className="pb-hide-narrow">
          <IconButton icon="expand" size={18} title="Now Playing view" active={route.view === 'nowplaying'} className="dot" onClick={openNowPlaying} />
        </span>
        <PanelButton panel="lyrics" icon="lyrics" title={`Lyrics (${MOD}+L)`} />
        <PanelButton panel="queue" icon="queue" title={`Queue (${MOD}+U)`} />
        <PanelButton panel="info" icon="panel" title={`Now playing info (${MOD}+I)`} />
        <span className="pb-hide-narrow">
          <IconButton icon="mini" size={18} title="Mini player" onClick={() => window.valence.send('mini:toggle')} />
        </span>
        <Volume />
      </div>
    </footer>
  )
}
