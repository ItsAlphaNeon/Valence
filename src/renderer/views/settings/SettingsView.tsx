// Settings: a sticky section list on the left (a scrolling pill strip when narrow) and one section at a time.

import type { ComponentType } from 'react'
import { cx } from '../../lib/format'
import { useUi } from '../../state/ui'
import { Icon, type IconName } from '../../components/Icon'
import { LibrarySection } from './sections/LibrarySection'
import { ArchiveSection } from './sections/ArchiveSection'
import { InboxSection } from './sections/InboxSection'
import { ArtworkSection, MetadataSection, TranscodingSection } from './sections/PipelineSections'
import { AccountsSection } from './sections/AccountsSection'
import { PlaybackSection } from './sections/PlaybackSection'
import { AppearanceSection } from './sections/AppearanceSection'
import { AboutSection, DiscordSection } from './sections/AboutSections'
import { SiIvaGunnerSection } from './sections/SiIvaGunnerSection'
import './settings.css'

interface SectionDef {
  id: string
  label: string
  icon: IconName
  group: string
  Component: ComponentType
}

const SECTIONS: SectionDef[] = [
  { id: 'library', label: 'Library', icon: 'songs', group: 'Library', Component: LibrarySection },
  { id: 'archive', label: 'Archive', icon: 'disc', group: 'Library', Component: ArchiveSection },
  { id: 'inbox', label: 'Inbox', icon: 'inbox', group: 'Library', Component: InboxSection },
  { id: 'transcoding', label: 'Transcoding', icon: 'wave', group: 'Importing', Component: TranscodingSection },
  { id: 'artwork', label: 'Artwork', icon: 'albums', group: 'Importing', Component: ArtworkSection },
  { id: 'metadata', label: 'Metadata', icon: 'tag', group: 'Importing', Component: MetadataSection },
  { id: 'accounts', label: 'Accounts', icon: 'user', group: 'Importing', Component: AccountsSection },
  { id: 'siivagunner', label: 'SiIvaGunner', icon: 'star', group: 'Importing', Component: SiIvaGunnerSection },
  { id: 'playback', label: 'Playback', icon: 'volume', group: 'App', Component: PlaybackSection },
  { id: 'appearance', label: 'Appearance', icon: 'smart', group: 'App', Component: AppearanceSection },
  { id: 'discord', label: 'Discord', icon: 'link', group: 'App', Component: DiscordSection },
  { id: 'about', label: 'About', icon: 'info', group: 'App', Component: AboutSection },
]

const ALIASES: Record<string, string> = { devices: 'about', device: 'about', eq: 'playback', equalizer: 'playback', theme: 'appearance', tidal: 'accounts', bandcamp: 'accounts', transcode: 'transcoding', art: 'artwork', lyrics: 'metadata', rips: 'siivagunner', seasons: 'siivagunner', youtube: 'siivagunner' }

export function SettingsView({ section }: { section?: string }) {
  const id = section && SECTIONS.some((s) => s.id === section) ? section : ((section && ALIASES[section]) ?? 'library')
  const cur = SECTIONS.find((s) => s.id === id) ?? SECTIONS[0]
  // (The shell resets/restores the scroll position per route, so each section starts at the top.)
  const go = (s: string) => useUi.getState().navigate({ view: 'settings', section: s }, { replace: true })
  const groups = [...new Set(SECTIONS.map((s) => s.group))]
  const { Component } = cur

  return (
    <div className="view settings-view">
      <div className="view-head">
        <div>
          <h1 className="view-title">Settings</h1>
          <div className="view-sub">Changes take effect right away.</div>
        </div>
      </div>
      <div className="settings-layout">
        <nav className="settings-nav" aria-label="Settings sections">
          {groups.map((g) => (
            <div key={g} className="settings-nav-group">
              <div className="settings-nav-head">{g}</div>
              {SECTIONS.filter((s) => s.group === g).map((s) => (
                <button key={s.id} className={cx('settings-nav-item', s.id === cur.id && 'on')} aria-current={s.id === cur.id ? 'page' : undefined} onClick={() => go(s.id)}>
                  <Icon name={s.icon} size={16} />
                  <span>{s.label}</span>
                </button>
              ))}
            </div>
          ))}
        </nav>
        <div className="settings-content" key={cur.id}>
          <Component />
        </div>
      </div>
    </div>
  )
}

export default SettingsView
