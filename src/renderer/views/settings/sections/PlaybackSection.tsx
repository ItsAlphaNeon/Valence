import { useEffect, useState } from 'react'
import { cmd, getPlayer, usePlayer } from '../../../state/player'
import type { EngineKind, OutputDevice, RgMode } from '../../../audio'
import { Segmented, Slider, Spinner } from '../../../components/ui'
import { Card, Row, SectionHead, Select, ToggleRow } from '../controls'
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
