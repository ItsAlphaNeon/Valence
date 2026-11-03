// Discord Rich Presence and About / Devices.

import { useState } from 'react'
import { cx } from '../../../lib/format'
import { toast } from '../../../state/ui'
import { Button } from '../../../components/ui'
import { Icon } from '../../../components/Icon'
import { Card, Disclosure, ExternalLink, PathLine, Row, SectionHead, StackRow, TextSetting, ToggleRow, openPath, useAppInfo, useSettingValue } from '../controls'

export function DiscordSection() {
  const [enabled] = useSettingValue<boolean>('discord.enabled', false)
  const [clientId] = useSettingValue<string>('discord.clientId', '')
  return (
    <>
      <SectionHead icon="link" title="Discord">
        Show what you’re listening to on your Discord profile — song, artist, album and time remaining.
      </SectionHead>
      <Card>
        <ToggleRow
          k="discord.enabled"
          fallback={false}
          label="Share listening activity"
          desc="Needs the Discord desktop app running on this computer."
          note={enabled && !clientId ? 'Add an Application ID below to start sharing.' : undefined}
        />
        <StackRow label="Application ID" desc="Discord shows your activity under the name of a Discord application you own.">
          <TextSetting
            k="discord.clientId"
            mono
            placeholder="e.g. 112233445566778899"
            ariaLabel="Discord Application ID"
            width={260}
            validate={(v) => (v && !/^\d{15,22}$/.test(v) ? 'An Application ID is a long number — copy it from the General Information page.' : null)}
          />
        </StackRow>
      </Card>
      <Card title="Setting up the application">
        <ol className="set-steps">
          <li>
            Open <ExternalLink href="https://discord.com/developers/applications" /> in your browser and sign in.
          </li>
          <li>
            Choose <b>New Application</b> and name it <b>Valence</b> — this is the name your friends see (“Listening to Valence”).
          </li>
          <li>
            On <b>General Information</b>, copy the <b>Application ID</b> and paste it above.
          </li>
          <li>
            Optional: under <b>Rich Presence → Art Assets</b>, upload the Valence icon named <b>valence</b>. It's shown for songs without a MusicBrainz release; the rest use the Cover Art Archive picture.
          </li>
        </ol>
      </Card>
    </>
  )
}

const PLATFORM: Record<string, string> = { win32: 'Windows', darwin: 'macOS', linux: 'Linux' }

function prettyFeature(k: string): string {
  return k.replace(/_/g, ' ').replace(/\b\w/, (c) => c.toUpperCase())
}

function featureKind(v: string): 'ok' | 'warn' | 'err' {
  if (v.startsWith('enabled')) return 'ok'
  if (v.includes('software') || v === 'unavailable_off_ok') return 'warn'
  return 'err'
}

export function AboutSection() {
  const { info } = useAppInfo()
  const [copied, setCopied] = useState(false)
  const gpu = Object.entries(info?.gpu ?? {}).sort(([a], [b]) => a.localeCompare(b))
  const accelerated = (info?.gpu?.gpu_compositing ?? '').startsWith('enabled')
  const enabledCount = gpu.filter(([, v]) => featureKind(v) === 'ok').length

  const copyId = async () => {
    if (!info) return
    try {
      await navigator.clipboard.writeText(info.deviceId)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      toast('Couldn’t copy to the clipboard', 'error')
    }
  }

  return (
    <>
      <SectionHead icon="info" title="About">
        Valence {info ? info.version : ''} — a personal music library and player.
      </SectionHead>

      <Card title="This device">
        <Row label="Device ID" desc="Identifies this computer in the shared library’s sync ledger. Every device has its own.">
          <div className="row">
            <span className="mono selectable set-devid">{info?.deviceId ?? '—'}</span>
            <Button small kind="ghost" icon={copied ? 'check' : undefined} onClick={() => void copyId()} disabled={!info}>
              {copied ? 'Copied' : 'Copy'}
            </Button>
          </div>
        </Row>
        <div className="kv set-kv">
          <span>Version</span>
          <span className="tnum selectable">{info?.version ?? '—'}</span>
          <span>Platform</span>
          <span>{info ? (PLATFORM[info.platform] ?? info.platform) : '—'}</span>
          <span>Graphics</span>
          <span className={cx(accelerated ? 'set-ok' : 'set-warn')}>{info ? (accelerated ? 'Hardware accelerated' : 'Software rendering') : '—'}</span>
        </div>
      </Card>

      <Card title="Folders">
        <div className="set-folders">
          <div className="set-folder-label">Library</div>
          <PathLine path={info?.libraryRoot} empty="—" />
          <div className="set-folder-label">Inbox</div>
          <PathLine path={info?.inboxDir} empty="—" />
          <div className="set-folder-label">Archive</div>
          <PathLine path={info?.archiveDir} empty="Not set" />
          <div className="set-folder-label">App data</div>
          <PathLine path={info?.dataDir} empty="—" onOpen={() => void openPath(info?.dataDir)} />
        </div>
        <p className="set-card-note">App data holds this device’s database, caches, settings and pending archive files. The library folder is the only one meant to be synced.</p>
      </Card>

      <Card title="Graphics features" aside={info ? <span className="faint tnum">{enabledCount} of {gpu.length} accelerated</span> : null}>
        {gpu.length ? (
          <Disclosure title="Details">
            <div className="set-gpu">
              {gpu.map(([k, v]) => (
                <div key={k} className="set-gpu-row">
                  <span className="grow">{prettyFeature(k)}</span>
                  <span className={cx('chip', featureKind(v))}>{v.replace(/_/g, ' ')}</span>
                </div>
              ))}
            </div>
          </Disclosure>
        ) : (
          <p className="set-card-note">{info ? 'No GPU information reported.' : 'Loading…'}</p>
        )}
        {!accelerated && info && (
          <p className="set-callout warn">
            <Icon name="warning" size={13} /> Compositing isn’t hardware accelerated, so the Automatic effects level stays at Flat or below.
          </p>
        )}
      </Card>
    </>
  )
}
