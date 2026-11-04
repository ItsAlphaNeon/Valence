// First-run welcome: a few short steps (library, look, playback, where music comes from, tips).
// Every choice applies live and stays editable in Settings; Settings → Appearance can run it again.

import { useEffect, useState, type ReactNode } from 'react'
import { SETTINGS, type AppInfo } from '@shared/ipc/settings'
import { invoke } from '../lib/ipc'
import { cx, plural } from '../lib/format'
import { navigate, useUi } from '../state/ui'
import { useLib, useSetting } from '../state/library'
import { cmd, usePlayer } from '../state/player'
import { AccentPicker, ArtThemePicker, PalettePicker } from '../views/settings/AppearancePickers'
import { Icon, type IconName } from '../components/Icon'
import { Slider } from '../components/ui'
import { MOD } from './TopBar'

const STEPS = ['welcome', 'library', 'look', 'playback', 'sources', 'tips'] as const
type Step = (typeof STEPS)[number]

export function Onboarding() {
  const open = useUi((s) => s.onboarding)
  if (!open) return null
  return <Flow />
}

function Flow() {
  const [i, setI] = useState(0)
  const [, setOnboarded] = useSetting('ui.onboarded', false)
  const step: Step = STEPS[i]
  const finish = (then?: () => void) => {
    setOnboarded(true)
    useUi.getState().setOnboarding(false)
    then?.()
  }
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement) return
      if (e.key === 'ArrowRight' && i < STEPS.length - 1) setI(i + 1)
      if (e.key === 'ArrowLeft' && i > 0) setI(i - 1)
      if (e.key === 'Escape') finish()
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  })
  return (
    <div className="onboard-scrim">
      <div className="onboard" role="dialog" aria-label="Welcome to Valence">
        <div className="onboard-body" key={step}>
          {step === 'welcome' && <Welcome />}
          {step === 'library' && <LibraryStep />}
          {step === 'look' && <LookStep />}
          {step === 'playback' && <PlaybackStep />}
          {step === 'sources' && <SourcesStep finish={finish} />}
          {step === 'tips' && <TipsStep />}
        </div>
        <div className="onboard-foot">
          <div className="onboard-dots" aria-hidden>
            {STEPS.map((s, n) => (
              <button key={s} className={cx(n === i && 'on')} onClick={() => setI(n)} title={`Step ${n + 1}`} />
            ))}
          </div>
          <span className="grow" />
          {i < STEPS.length - 1 && (
            <button className="btn btn-ghost" onClick={() => finish()}>
              Skip
            </button>
          )}
          {i > 0 && (
            <button className="btn" onClick={() => setI(i - 1)}>
              Back
            </button>
          )}
          {i < STEPS.length - 1 ? (
            <button className="btn btn-primary" onClick={() => setI(i + 1)} autoFocus>
              {i === 0 ? "Let's go" : 'Next'}
            </button>
          ) : (
            <button className="btn btn-primary" onClick={() => finish(() => navigate({ view: 'albums' }))} autoFocus>
              Start listening
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

function Head({ icon, kicker, title, children }: { icon?: IconName; kicker?: string; title: string; children?: ReactNode }) {
  return (
    <div className="onboard-head">
      {icon && (
        <span className="onboard-icon">
          <Icon name={icon} size={26} />
        </span>
      )}
      {kicker && <div className="hero-kicker">{kicker}</div>}
      <h1>{title}</h1>
      {children && <p className="muted">{children}</p>}
    </div>
  )
}

function Welcome() {
  return (
    <div className="onboard-welcome">
      <span className="brand-mark big" />
      <h1>Welcome to Valence</h1>
      <p className="muted">
        Your music, kept tidy and played beautifully. A minute of setup and you're listening. Everything here can be changed later in Settings.
      </p>
    </div>
  )
}

function LibraryStep() {
  const stats = useLib((s) => s.stats)
  const scan = useLib((s) => s.scan)
  const [info, setInfo] = useState<AppInfo | null>(null)
  useEffect(() => void invoke<AppInfo>(SETTINGS.appInfo).then(setInfo, () => {}), [])
  return (
    <>
      <Head icon="folder" kicker="Step 1" title="Your library">
        Valence keeps one clean folder of music, sorted Artist / Album, that other players and your phone can read too.
      </Head>
      <div className="onboard-cards">
        <div className="card onboard-card">
          <Icon name="albums" size={20} />
          <div className="grow">
            <div className="strong">Music folder</div>
            <div className="faint mono ellipsis" title={info?.libraryRoot}>
              {info?.libraryRoot ?? '…'}
            </div>
            <div className="muted small">
              {scan && scan.total ? `Scanning… ${scan.done.toLocaleString()} of ${scan.total.toLocaleString()}` : stats ? `${plural(stats.tracks, 'song')} in ${plural(stats.albums, 'album')}` : ''}
            </div>
          </div>
          {info && (
            <button className="btn btn-sm" onClick={() => void invoke(SETTINGS.openPath, info.libraryRoot)}>
              Open
            </button>
          )}
        </div>
        <div className="card onboard-card">
          <Icon name="inbox" size={20} />
          <div className="grow">
            <div className="strong">Inbox</div>
            <div className="faint mono ellipsis" title={info?.inboxDir}>
              {info?.inboxDir ?? '…'}
            </div>
            <div className="muted small">Drop files, folders or zips here (or anywhere on the window) and they're tagged, organized and added.</div>
          </div>
          {info && (
            <button className="btn btn-sm" onClick={() => void invoke(SETTINGS.openPath, info.inboxDir)}>
              Open
            </button>
          )}
        </div>
        <div className="card onboard-card">
          <Icon name="disc" size={20} />
          <div className="grow">
            <div className="strong">Lossless archive</div>
            <div className="faint mono ellipsis">{info?.archiveDir ?? 'Not set — FLAC masters wait until you pick a drive'}</div>
            <div className="muted small">Optional. Pick a big drive in Settings → Archive to keep the originals.</div>
          </div>
        </div>
      </div>
    </>
  )
}

function LookStep() {
  return (
    <>
      <Head icon="image" kicker="Step 2" title="Make it yours">
        Pick a palette and an accent. Valence can also take its colors from the album that's playing.
      </Head>
      <div className="onboard-section">
        <div className="onboard-label">Palette</div>
        <PalettePicker withUser={false} />
      </div>
      <div className="onboard-section">
        <div className="onboard-label">Accent</div>
        <AccentPicker custom={false} />
      </div>
      <div className="onboard-section">
        <div className="onboard-label">Album art colors</div>
        <ArtThemePicker />
      </div>
    </>
  )
}

function PlaybackStep() {
  const crossfade = usePlayer((s) => s.state?.crossfadeSec ?? 0)
  const rg = usePlayer((s) => s.state?.rgMode ?? 'auto')
  const [autoplay, setAutoplay] = useSetting('playback.autoplay', true)
  const [notify, setNotify] = useSetting('ui.notifications.trackChange', false)
  const [x, setX] = useState<number | null>(null)
  return (
    <>
      <Head icon="eq" kicker="Step 3" title="How it plays">
        Albums play gaplessly. These are the few things people like to choose up front.
      </Head>
      <div className="onboard-cards">
        <div className="card onboard-card">
          <Icon name="wave" size={20} />
          <div className="grow">
            <div className="strong">Crossfade</div>
            <div className="muted small">Blend songs together. Albums that flow into the next track are never crossfaded.</div>
            <div className="row" style={{ marginTop: 8 }}>
              <Slider value={x ?? crossfade} max={12} label="Crossfade seconds" onChange={setX} onCommit={(v) => (setX(null), cmd({ type: 'setCrossfade', sec: Math.round(v) }))} />
              <span className="tnum" style={{ minWidth: 48, textAlign: 'right' }}>
                {Math.round(x ?? crossfade) ? `${Math.round(x ?? crossfade)} s` : 'Off'}
              </span>
            </div>
          </div>
        </div>
        <div className="card onboard-card">
          <Icon name="volume" size={20} />
          <div className="grow">
            <div className="strong">Even out loudness</div>
            <div className="muted small">ReplayGain keeps quiet and loud records at the same volume.</div>
          </div>
          <select value={rg} onChange={(e) => cmd({ type: 'setRgMode', mode: e.target.value as 'off' | 'track' | 'album' | 'auto' })}>
            <option value="auto">Smart (album when playing albums)</option>
            <option value="track">Per song</option>
            <option value="album">Per album</option>
            <option value="off">Off</option>
          </select>
        </div>
        <label className="card onboard-card">
          <Icon name="sparkle" size={20} />
          <div className="grow">
            <div className="strong">Autoplay</div>
            <div className="muted small">When your music ends, keep going with similar songs from your library.</div>
          </div>
          <input type="checkbox" className="toggle" checked={autoplay} onChange={(e) => setAutoplay(e.target.checked)} />
        </label>
        <label className="card onboard-card">
          <Icon name="info" size={20} />
          <div className="grow">
            <div className="strong">Song change notifications</div>
            <div className="muted small">A quiet notification when a new song starts while Valence is in the background.</div>
          </div>
          <input type="checkbox" className="toggle" checked={notify} onChange={(e) => setNotify(e.target.checked)} />
        </label>
      </div>
    </>
  )
}

function SourcesStep({ finish }: { finish: (then?: () => void) => void }) {
  const items: Array<[IconName, string, string, () => void]> = [
    ['inbox', 'Import files', 'Drag in folders, files or zips. Valence tags them, finds artwork and lyrics, and files them neatly.', () => navigate({ view: 'import' })],
    ['wave', 'TIDAL', 'Sign in to browse your favorites and save albums to your library.', () => navigate({ view: 'tidal' })],
    ['disc', 'Bandcamp', 'Sign in to bring in your purchases in lossless.', () => navigate({ view: 'bandcamp' })],
    ['download', 'SiIvaGunner rips', 'High Quality Rips, kept in their own section.', () => navigate({ view: 'hqrip' })],
  ]
  return (
    <>
      <Head icon="download" kicker="Step 4" title="Where your music comes from">
        Add music whenever you like. You can do this now or come back later.
      </Head>
      <div className="onboard-grid">
        {items.map(([icon, title, sub, go]) => (
          <button key={title} className="card onboard-tile" onClick={() => finish(go)}>
            <span className="onboard-icon sm">
              <Icon name={icon} size={20} />
            </span>
            <span className="strong">{title}</span>
            <span className="muted small">{sub}</span>
          </button>
        ))}
      </div>
    </>
  )
}

function TipsStep() {
  const tips: Array<[IconName, ReactNode, string]> = [
    ['search', <><span className="kbd">{MOD}</span> <span className="kbd">K</span></>, 'Command palette: find any song or action from the keyboard.'],
    ['heart', <Icon name="heart" size={16} filled />, 'Heart songs, albums and artists. They gather in Favorites and sync to your phone and other computers.'],
    ['zoomIn', 'Click the art', 'Album covers open full size. Scroll to zoom in on the details.'],
    ['moon', 'Sleep timer', 'The moon in the player bar stops playback after a while or at the end of a song.'],
    ['keyboard', <span className="kbd">?</span>, 'Shows every keyboard shortcut.'],
  ]
  return (
    <>
      <Head icon="sparkle" kicker="All set" title="A few things worth knowing" />
      <div className="onboard-tips">
        {tips.map(([icon, key, text], n) => (
          <div className="onboard-tip" key={n}>
            <span className="onboard-icon sm">
              <Icon name={icon} size={18} />
            </span>
            <span className="onboard-tip-key">{key}</span>
            <span className="muted">{text}</span>
          </div>
        ))}
      </div>
    </>
  )
}
