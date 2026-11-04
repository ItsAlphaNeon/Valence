// Mini player window. Mirrors the main window's player via RemotePlayer (state at ~4 Hz) and
// sends commands back; it has no audio of its own.

import { useEffect, useState, useSyncExternalStore } from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource-variable/roboto'
import '../theme/theme.css'
import '../app.css'
import './mini.css'
import { RemotePlayer, type PlayerCommand, type PlayerState } from '../audio'
import { SETTINGS } from '@shared/ipc/settings'
import { invoke, on, send } from '../lib/ipc'
import { cx, duration } from '../lib/format'
import { Artwork, IconButton, Slider } from '../components/ui'
import { accentHex, applyAccent, artThemeSetting, configureAccent } from '../theme/accent'
import { applyTheme, findTheme, watchUserThemes } from '../theme/themes'

const remote = new RemotePlayer()
const subscribe = (cb: () => void) => remote.on('state', cb)
const cmd = (c: PlayerCommand) => remote.command(c)

function artHash(s: PlayerState | null): string | null {
  const m = s?.current?.artUrl ? /valence-art:\/\/img\/([0-9a-f]+)/i.exec(s.current.artUrl) : null
  return m ? m[1] : null
}

async function initAppearance(): Promise<void> {
  const apply = (all: Record<string, unknown>) => {
    const th = findTheme(all['ui.theme'])
    applyTheme(th)
    const chosen = all['ui.accent']
    const accent = typeof chosen === 'string' && chosen !== 'art' ? accentHex(chosen) : (th.accent ?? accentHex(null))
    // Small enough that a full album-colored wash always looks right, unless art theming is off.
    configureAccent({ accent, artTheme: th.artTint === false || artThemeSetting(all) === 'off' ? 'off' : 'full' })
  }
  let all = await invoke<Record<string, unknown>>(SETTINGS.all).catch(() => ({}) as Record<string, unknown>)
  await watchUserThemes(() => apply(all))
  apply(all)
  on<[string, unknown]>(SETTINGS.changed, (k, v) => {
    if (!k.startsWith('ui.')) return
    all = { ...all, [k]: v }
    apply(all)
  })
}

function Seek({ s }: { s: PlayerState }) {
  const [drag, setDrag] = useState<number | null>(null)
  const dur = s.durationMs || s.current?.durationMs || 0
  const pos = drag ?? s.positionMs
  return (
    <div className="mini-seek" title={`${duration(pos)} / ${duration(dur)}`}>
      <Slider
        value={pos}
        max={Math.max(1, dur)}
        label="Seek"
        onChange={setDrag}
        onCommit={(v) => {
          setDrag(null)
          cmd({ type: 'seek', positionMs: v })
        }}
      />
    </div>
  )
}

function Mini() {
  const s = useSyncExternalStore(subscribe, () => remote.getState())
  const hash = artHash(s)
  useEffect(() => {
    void applyAccent(hash)
  }, [hash])
  const cur = s?.current
  const volume = s?.volume ?? 1
  const muted = !!s?.muted
  return (
    <div className={cx('mini', !cur && 'mini-idle')} onDoubleClick={(e) => e.target === e.currentTarget && send('app:showMain')}>
      <button className="mini-art" title="Show Valence" onClick={() => send('app:showMain')}>
        <Artwork hash={hash} px={300} title={cur?.album ?? 'Valence'} />
      </button>
      <div className="mini-body">
        <div className="mini-top">
          <div className="mini-meta">
            <div className="mini-title">{cur?.title ?? 'Not playing'}</div>
            <div className="mini-sub">{cur ? [cur.artist, cur.album].filter(Boolean).join(' — ') : 'Pick something in Valence'}</div>
          </div>
          <div className="mini-win">
            <IconButton icon="expand" size={16} title="Show Valence" onClick={() => send('app:showMain')} />
            <IconButton icon="close" size={16} title="Close mini player" onClick={() => send('mini:close')} />
          </div>
        </div>
        <div className="mini-controls">
          <IconButton icon="prev" size={24} title="Previous" disabled={!cur} onClick={() => cmd({ type: 'prev' })} />
          <IconButton className="mini-play" icon={s?.playing ? 'pause' : 'play'} size={32} title={s?.playing ? 'Pause' : 'Play'} disabled={!cur} onClick={() => cmd({ type: 'toggle' })} />
          <IconButton icon="next" size={24} title="Next" disabled={!cur} onClick={() => cmd({ type: 'next' })} />
          <div className="mini-spacer" />
          <IconButton icon={muted || volume === 0 ? 'mute' : volume < 0.5 ? 'volumeLow' : 'volume'} size={18} title={muted ? 'Unmute' : 'Mute'} onClick={() => cmd({ type: 'setMuted', muted: !muted })} />
          <div className="mini-volume" onWheel={(e) => cmd({ type: 'setVolume', volume: Math.min(1, Math.max(0, volume - Math.sign(e.deltaY) * 0.05)) })}>
            <Slider value={muted ? 0 : volume} max={1} label="Volume" onChange={(v) => cmd({ type: 'setVolume', volume: v })} onCommit={(v) => cmd({ type: 'setVolume', volume: v })} />
          </div>
        </div>
        {s && cur && <Seek s={s} />}
      </div>
    </div>
  )
}

window.addEventListener('keydown', (e) => {
  if (e.key === ' ') {
    e.preventDefault()
    cmd({ type: 'toggle' })
  } else if (e.key === 'ArrowRight' && (e.ctrlKey || e.metaKey)) cmd({ type: 'next' })
  else if (e.key === 'ArrowLeft' && (e.ctrlKey || e.metaKey)) cmd({ type: 'prev' })
  else if (e.key === 'Escape') send('mini:close')
})

document.documentElement.classList.add(`platform-${window.valence.platform}`)
void initAppearance().finally(() => createRoot(document.getElementById('root')!).render(<Mini />))
