import { useEffect, useState } from 'react'
import { PLAYBACK_SETTINGS as PS, cmd, getPlayer, usePlayer } from '../../../state/player'
import type { EngineKind, OutputDevice, RgMode } from '../../../audio'
import { Segmented, Slider, Spinner } from '../../../components/ui'
import { Card, Row, SectionHead, Select, ToggleRow, useSettingValue } from '../controls'
import { Equalizer } from './Equalizer'

const ENGINE_DESC: Record<EngineKind, string> = {
  worklet: 'Valence’s own engine: every format ffmpeg can decode, sample-accurate gapless playback and crossfades.',
  element: 'Chromium’s built-in media player. Near-gapless, fewer formats. Try it if playback stutters or a device misbehaves.',
}

const RG_DESC: Record<RgMode, string> = {
  off: 'Play files at their mastered loudness.',
  track: 'Level every track to the same loudness.',
  album: 'Level whole albums, keeping quiet and loud songs as the artist intended.',
  auto: 'Album gain while an album plays in order, track gain on shuffle and in playlists.',
}

function useOutputDevices(ready: boolean): OutputDevice[] | null {
  const [devices, setDevices] = useState<OutputDevice[] | null>(null)
  useEffect(() => {
    if (!ready) return
    let live = true
    const load = () => {
      const p = getPlayer()
      if (!p) return
      p.listOutputDevices().then(
        (ds) => live && setDevices(ds.filter((d) => d.deviceId !== 'communications')),
        () => live && setDevices([]),
      )
    }
    load()
    navigator.mediaDevices?.addEventListener('devicechange', load)
    return () => {
      live = false
      navigator.mediaDevices?.removeEventListener('devicechange', load)
    }
  }, [ready])
  return devices
}

function fmtDb(db: number): string {
  const r = Math.round(db * 2) / 2
  return `${r > 0 ? '+' : r < 0 ? '−' : ''}${Math.abs(r).toFixed(1)} dB`
}

/** Settings values arrive untyped; numbers may be stored as strings. */
function num(v: unknown, d: number): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN
  return Number.isFinite(n) ? n : d
}

/** Balance snaps to center within this distance (keyboard steps are 0.04, so they still leave it). */
const BALANCE_DETENT = 0.035

function fmtBalance(b: number): string {
  const pct = Math.round(Math.abs(b) * 100)
  return pct === 0 ? 'Centered' : `${b < 0 ? 'Left' : 'Right'} ${pct}%`
}

function BalanceRow() {
  const [stored, setStored] = useSettingValue<unknown>(PS.balance.key, PS.balance.fallback)
  const [drag, setDrag] = useState<number | null>(null)
  const snap = (v: number) => {
    const b = Math.max(-1, Math.min(1, v - 1))
    return Math.abs(b) < BALANCE_DETENT ? 0 : Math.round(b * 100) / 100
  }
  const b = drag ?? Math.max(-1, Math.min(1, num(stored, 0)))
  return (
    <Row label="Balance" desc="Shift the sound toward the left or right speaker. Double-click to center.">
      <div className="set-slider" onDoubleClick={() => setStored(0)}>
        <Slider value={b + 1} max={2} label="Balance" onChange={(v) => setDrag(snap(v))} onCommit={(v) => {
          setDrag(null)
          setStored(snap(v))
        }} />
        <span className="set-slider-value tnum">{fmtBalance(b)}</span>
      </div>
    </Row>
  )
}

const FADE_MAX = 500

function PauseFadeRow() {
  const [stored, setStored] = useSettingValue<unknown>(PS.fadePauseMs.key, PS.fadePauseMs.fallback)
  const [drag, setDrag] = useState<number | null>(null)
  const round = (v: number) => Math.round(Math.max(0, Math.min(FADE_MAX, v)) / 10) * 10
  const ms = drag ?? Math.max(0, Math.min(FADE_MAX, num(stored, PS.fadePauseMs.fallback)))
  return (
    <Row label="Pause fade" desc="Fade briefly on play, pause, stop and skip instead of cutting off.">
      <div className="set-slider">
        <Slider value={ms} max={FADE_MAX} label="Pause fade milliseconds" onChange={(v) => setDrag(round(v))} onCommit={(v) => {
          setDrag(null)
          setStored(round(v))
        }} />
        <span className="set-slider-value tnum">{Math.round(ms) === 0 ? 'Off' : `${Math.round(ms)} ms`}</span>
      </div>
    </Row>
  )
}

const PREV_CHOICES = [0, 2, 3, 5, 10]

function PrevRestartRow() {
  const [stored, setStored] = useSettingValue<unknown>(PS.prevRestartSec.key, PS.prevRestartSec.fallback)
  const sec = Math.max(0, num(stored, PS.prevRestartSec.fallback))
  const choices = PREV_CHOICES.includes(sec) ? PREV_CHOICES : [...PREV_CHOICES, sec].sort((a, b) => a - b)
  return (
    <Row label="Previous restarts the song" desc={sec === 0 ? 'Previous always goes to the song before.' : `After ${sec} seconds, Previous starts the song over instead of going back.`}>
      <Segmented<string>
        value={String(sec)}
        options={choices.map((c) => ({ value: String(c), label: c === 0 ? 'Off' : `${c} s` }))}
        onChange={(v) => setStored(Number(v))}
      />
    </Row>
  )
}

export function PlaybackSection() {
  const state = usePlayer((s) => s.state)
  const ready = usePlayer((s) => s.ready)
  const devices = useOutputDevices(ready)
  const [xf, setXf] = useState<number | null>(null)
  const [pre, setPre] = useState<number | null>(null)

  if (!state) {
    return (
      <>
        <SectionHead icon="volume" title="Playback" />
        <div className="center-spin">
          <Spinner />
        </div>
      </>
    )
  }

  const crossfade = xf ?? state.crossfadeSec
  const preamp = pre ?? state.preampDb
  const deviceOptions = (devices ?? []).map((d) => ({ value: d.deviceId, label: d.deviceId === 'default' && !/default/i.test(d.label) ? `System default (${d.label})` : d.label }))
  if (!deviceOptions.some((d) => d.value === state.outputDeviceId)) deviceOptions.unshift({ value: state.outputDeviceId, label: state.outputDeviceId === 'default' ? 'System default' : 'Unavailable device' })

  return (
    <>
      <SectionHead icon="volume" title="Playback">
        Engine, output and sound. Changes apply instantly, even mid-song.
      </SectionHead>

      <Card title="Output">
        <Row label="Audio engine" desc={ENGINE_DESC[state.engine]}>
          <Segmented<EngineKind>
            value={state.engine}
            options={[
              { value: 'worklet', label: 'Gapless' },
              { value: 'element', label: 'Compatibility' },
            ]}
            onChange={(engine) => cmd({ type: 'setEngine', engine })}
          />
        </Row>
        <Row label="Output device" desc="Valence can play to a different device than the rest of the system.">
          {devices ? (
            <Select value={state.outputDeviceId} options={deviceOptions} onChange={(deviceId) => cmd({ type: 'setOutputDevice', deviceId })} ariaLabel="Output device" className="set-select-wide" />
          ) : (
            <Spinner size={14} />
          )}
        </Row>
        {state.error && <p className="set-callout warn">{state.error}</p>}
      </Card>

      <Card title="Channels">
        <ToggleRow k={PS.mono.key} fallback={PS.mono.fallback} label="Mono" desc="Mix both channels into one, so nothing is missed with a single earbud or speaker." />
        <BalanceRow />
      </Card>

      <Card title="Transitions">
        <Row
          label="Crossfade"
          desc="Blend the end of one song into the next. Consecutive tracks from the same album always play gapless, and a repeated song never fades into itself."
        >
          <div className="set-slider">
            <Slider value={crossfade} max={12} label="Crossfade seconds" onChange={setXf} onCommit={(v) => {
              setXf(null)
              cmd({ type: 'setCrossfade', sec: Math.round(v) })
            }} />
            <span className="set-slider-value tnum">{Math.round(crossfade) === 0 ? 'Off' : `${Math.round(crossfade)} s`}</span>
          </div>
        </Row>
        <PauseFadeRow />
      </Card>

      <Card title="Queue">
        <ToggleRow k={PS.autoplay.key} fallback={PS.autoplay.fallback} label="Autoplay" desc="When the queue runs out, keep playing similar songs from your library." />
        <PrevRestartRow />
      </Card>

      <Card title="Sleep timer">
        <ToggleRow k={PS.sleepFade.key} fallback={PS.sleepFade.fallback} label="Fade out" desc="Lower the volume over the last 20 seconds before a timed sleep timer pauses." />
      </Card>

      <Card title="Volume leveling">
        <Row label="ReplayGain" desc={RG_DESC[state.rgMode]}>
          <Segmented<RgMode>
            value={state.rgMode}
            options={[
              { value: 'off', label: 'Off' },
              { value: 'track', label: 'Track' },
              { value: 'album', label: 'Album' },
              { value: 'auto', label: 'Auto' },
            ]}
            onChange={(mode) => cmd({ type: 'setRgMode', mode })}
          />
        </Row>
        <Row label="Preamp" desc="Extra gain on top of ReplayGain. ReplayGain targets are quiet, so +3 to +6 dB often matches other apps.">
          <div className="set-slider">
            <Slider value={preamp + 12} max={24} label="Preamp" onChange={(v) => setPre(v - 12)} onCommit={(v) => {
              setPre(null)
              cmd({ type: 'setPreamp', db: Math.round((v - 12) * 2) / 2 })
            }} />
            <span className="set-slider-value tnum">{fmtDb(preamp)}</span>
          </div>
        </Row>
      </Card>

      <Card>
        <Equalizer eq={state.eq} />
      </Card>

      <Card title="Media keys">
        <ToggleRow
          k="playback.globalMediaKeys"
          fallback={false}
          label="Always grab media keys"
          desc="Media keys normally reach Valence through the system's media controls. Turn this on only if they don't; other apps then stop receiving them."
        />
      </Card>
    </>
  )
}
