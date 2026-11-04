import { useState } from 'react'
import { SETTINGS } from '@shared/ipc/settings'
import { errorMessage, invoke } from '../../../lib/ipc'
import { toast, useUi } from '../../../state/ui'
import { useThemes } from '../../../theme/themes'
import { Button, Segmented } from '../../../components/ui'
import { Icon } from '../../../components/Icon'
import { Card, openPath, PathLine, Row, SectionHead, Select, ToggleRow, useSettingValue } from '../controls'
import { AccentPicker, ArtThemePicker, PalettePicker } from '../AppearancePickers'

const ZOOMS = [0.75, 0.8, 0.9, 1, 1.1, 1.2, 1.3, 1.4, 1.5]

function SegSetting<T extends string>({ k, fallback, label, desc, options }: { k: string; fallback: T; label: string; desc?: string; options: Array<{ value: T; label: string }> }) {
  const [v, set] = useSettingValue<T>(k, fallback)
  return (
    <Row label={label} desc={desc}>
      <Segmented value={v} onChange={set} options={options} />
    </Row>
  )
}

function SelectSetting<T extends string>({ k, fallback, label, desc, options }: { k: string; fallback: T; label: string; desc?: string; options: Array<{ value: T; label: string }> }) {
  const [v, set] = useSettingValue<T>(k, fallback)
  return (
    <Row label={label} desc={desc}>
      <Select value={v} onChange={set} options={options} ariaLabel={label} />
    </Row>
  )
}

function ZoomRow() {
  const [zoom, setZoom] = useSettingValue<number>('ui.zoom', 1)
  const z = Number(zoom) || 1
  const i = ZOOMS.reduce((best, v, k) => (Math.abs(v - z) < Math.abs(ZOOMS[best] - z) ? k : best), 0)
  return (
    <Row label="Zoom" desc="Scales the whole window. Ctrl + and Ctrl − work anywhere; Ctrl 0 resets.">
      <div className="row">
        <Button small kind="ghost" icon="zoomOut" disabled={i === 0} onClick={() => setZoom(ZOOMS[i - 1])} aria-label="Zoom out" />
        <span className="tnum zoom-val">{Math.round(z * 100)}%</span>
        <Button small kind="ghost" icon="zoomIn" disabled={i === ZOOMS.length - 1} onClick={() => setZoom(ZOOMS[i + 1])} aria-label="Zoom in" />
        {z !== 1 && (
          <Button small kind="ghost" onClick={() => setZoom(1)}>
            Reset
          </Button>
        )}
      </div>
    </Row>
  )
}

function UserThemesCard() {
  const { user } = useThemes()
  const [busy, setBusy] = useState(false)
  const createExample = async () => {
    setBusy(true)
    try {
      await invoke<string>(SETTINGS.themeExample)
      toast('Example theme added. Edit it and the changes apply right away')
      void openPath(user.dir)
    } catch (e) {
      toast(errorMessage(e), 'error')
    } finally {
      setBusy(false)
    }
  }
  return (
    <Card
      title="Your themes"
      aside={
        <Button small kind="ghost" onClick={() => void createExample()} disabled={busy}>
          {user.themes.length ? 'Add example' : 'Create example'}
        </Button>
      }
    >
      <p className="set-card-note">Theme files (.json) in the themes folder inside your library show up as palettes above. They sync to your other computers, and edits apply live.</p>
      <PathLine path={user.dir || null} empty="—" onOpen={() => void openPath(user.dir)} />
      {user.errors.map((e) => (
        <p key={e.file} className="set-callout warn">
          <Icon name="warning" size={13} /> <span className="mono">{e.file}</span>: {e.error}
        </p>
      ))}
    </Card>
  )
}

export function AppearanceSection() {
  return (
    <>
      <SectionHead icon="sparkle" title="Appearance">
        Make Valence feel like yours. Everything applies right away.
      </SectionHead>
      <Card title="Palette">
        <PalettePicker />
      </Card>
      <Card title="Color">
        <Row label="Accent" desc="Play buttons, sliders, selections and highlights." top>
          <AccentPicker />
        </Row>
        <Row label="Album art colors" desc="Let the album that's playing color the app." top />
        <ArtThemePicker />
        <ToggleRow k="ui.headerColors" fallback={true} label="Colorful page headers" desc="Album, artist and playlist pages fade in from their artwork's color." />
      </Card>
      <UserThemesCard />
      <Card title="Layout">
        <SegSetting
          k="ui.density"
          fallback="comfortable"
          label="Density"
          desc="Compact fits more songs on screen."
          options={[
            { value: 'comfortable', label: 'Comfortable' },
            { value: 'compact', label: 'Compact' },
          ]}
        />
        <SegSetting
          k="ui.textSize"
          fallback="default"
          label="Text size"
          options={[
            { value: 'small', label: 'Small' },
            { value: 'default', label: 'Default' },
            { value: 'large', label: 'Large' },
            { value: 'larger', label: 'Larger' },
          ]}
        />
        <ZoomRow />
        <SegSetting
          k="ui.tileSize"
          fallback="medium"
          label="Album art size in grids"
          options={[
            { value: 'small', label: 'Small' },
            { value: 'medium', label: 'Medium' },
            { value: 'large', label: 'Large' },
          ]}
        />
        <ToggleRow k="ui.songs.art" fallback={true} label="Artwork in song lists" desc="Shows a small cover next to each song in Songs." />
        <SelectSetting
          k="ui.startPage"
          fallback="last"
          label="Open Valence to"
          options={[
            { value: 'last', label: 'Where I left off' },
            { value: 'albums', label: 'Albums' },
            { value: 'songs', label: 'Songs' },
            { value: 'liked', label: 'Liked Songs' },
          ]}
        />
      </Card>
      <Card title="Motion">
        <SegSetting
          k="ui.motion"
          fallback="system"
          label="Animations"
          desc="Follow system respects your operating system's reduce-motion setting."
          options={[
            { value: 'system', label: 'Follow system' },
            { value: 'on', label: 'On' },
            { value: 'off', label: 'Reduced' },
          ]}
        />
        <ToggleRow k="ui.np.spin" fallback={false} label="Spin the cover while playing" desc="A slow vinyl-style turn on the Now Playing page." />
      </Card>
      <Card title="Player">
        <ToggleRow k="ui.player.remaining" fallback={false} label="Show time remaining" desc="The player bar counts down instead of showing the song length. You can also click the time." />
        <ToggleRow k="ui.panel.facts" fallback={true} label="Song details in the side panel" desc="Album, format, plays, loudness and more under the cover art." />
        <SegSetting
          k="ui.lyrics.size"
          fallback="default"
          label="Lyrics text"
          options={[
            { value: 'small', label: 'Small' },
            { value: 'default', label: 'Default' },
            { value: 'large', label: 'Large' },
          ]}
        />
        <ToggleRow k="ui.notifications.trackChange" fallback={false} label="Notify when the song changes" desc="A quiet desktop notification, only while Valence isn't the active window." />
      </Card>
      <Card title="Windows">
        {window.valence.platform !== 'darwin' && (
          <ToggleRow k="ui.closeToTray" fallback={false} label="Keep playing when the window is closed" desc="Closing the window hides Valence in the tray instead of quitting. Quit from the tray menu." />
        )}
        <ToggleRow k="ui.mini.onTop" fallback={true} label="Mini player stays on top" desc="Open it from the player bar, the tray, Ctrl+Shift+M inside Valence, or Ctrl+Alt+M from anywhere (⌘⌥M on a Mac)." />
      </Card>
      <Card title="Welcome tour">
        <Row label="Run setup again" desc="Walks through your library folders, look, playback and sources, with tips at the end.">
          <Button icon="sparkle" onClick={() => useUi.getState().setOnboarding(true)}>
            Start tour
          </Button>
        </Row>
      </Card>
    </>
  )
}
