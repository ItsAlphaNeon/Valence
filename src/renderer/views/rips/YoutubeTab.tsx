// YouTube tab of Get Rips: your public SiIvaGunner playlist, synced into one album per channel season.

import { useEffect, useMemo, useState } from 'react'
import { HQRIP_IPC, type YoutubeEntryState, type YoutubeStatus } from '@shared/ipc/hqrip'
import { errorMessage, invoke, on } from '../../lib/ipc'
import { cx, duration, plural, relativeTime } from '../../lib/format'
import { navigate, toast } from '../../state/ui'
import { Button, Empty, Segmented, Spinner } from '../../components/ui'
import { Icon } from '../../components/Icon'
import { CommitInput, useSettingValue } from '../settings/controls'
import { PauseBanner, openLink, useProgressive, LoadMore } from '../tidal/source-kit'

export const PLAYLIST_KEY = 'library.rips.youtubePlaylist'
export const AUTOSYNC_KEY = 'rips.youtube.autoSync'

/** Accepts a playlist link (any youtube.com URL with ?list=) or a bare list id. */
export function playlistError(s: string): string | null {
  if (!s) return null
  if (/^(PL|UU|OL|FL|LL|RD)[A-Za-z0-9_-]{10,}$/.test(s)) return null
  try {
    const u = new URL(s)
    if (/(^|\.)youtube\.com$|^youtu\.be$/i.test(u.hostname) && u.searchParams.get('list')) return null
  } catch {
    /* fall through */
  }
  return 'That isn’t a YouTube playlist link (it needs “list=” in it)'
}

/** Live playlist sync status, kept current by main's broadcasts. */
export function useYoutubeStatus(): { status: YoutubeStatus | null; sync: () => Promise<void>; syncing: boolean } {
  const [status, setStatus] = useState<YoutubeStatus | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    let live = true
    invoke<YoutubeStatus>(HQRIP_IPC.youtubeStatus).then((s) => live && setStatus(s), (e) => toast(errorMessage(e), 'error'))
    const off = on<[YoutubeStatus]>(HQRIP_IPC.youtubeChanged, (s) => setStatus(s))
    return () => {
      live = false
      off()
    }
  }, [])
  const sync = async () => {
    setBusy(true)
    try {
      const s = await invoke<YoutubeStatus>(HQRIP_IPC.youtubeSync)
      setStatus(s)
      if (s.error) toast(s.error, 'error')
      else if (s.summary) toast(s.summary, 'ok', { label: 'View Queue', run: () => navigate({ view: 'import', tab: 'queue' }) })
    } catch (e) {
      toast(errorMessage(e), 'error')
    } finally {
      setBusy(false)
    }
  }
  return { status, sync, syncing: busy || !!status?.syncing }
}

const STATE_LABEL: Record<YoutubeEntryState, { label: string; cls: string }> = {
  'in-library': { label: 'In Library', cls: 'ok' },
  queued: { label: 'Queued', cls: 'accent' },
  running: { label: 'Downloading', cls: 'accent' },
  missing: { label: 'Not downloaded', cls: '' },
  'not-siivagunner': { label: 'Other channel', cls: 'warn' },
  unavailable: { label: 'Unavailable', cls: 'warn' },
}

type Scope = 'all' | 'missing' | 'in-library' | 'skipped'

export function YoutubeTab() {
  const { status, sync, syncing } = useYoutubeStatus()
  const [url, setUrl] = useSettingValue<string | null>(PLAYLIST_KEY, null)
  const [scope, setScope] = useState<Scope>('all')
  const entries = status?.entries ?? []
  const shown = useMemo(
    () =>
      entries.filter((e) =>
        scope === 'all'
          ? true
          : scope === 'in-library'
            ? e.state === 'in-library'
            : scope === 'skipped'
              ? e.state === 'not-siivagunner' || e.state === 'unavailable'
              : e.state === 'missing' || e.state === 'queued' || e.state === 'running',
      ),
    [entries, scope],
  )
  const p = useProgressive(shown, 200, scope)
  const inLib = entries.filter((e) => e.state === 'in-library').length
  return (
    <>
      <PauseBanner source="youtube" loggedIn />
      <div className="card glass yt-panel">
        <div className="yt-url">
          <Icon name="link" size={16} />
          <CommitInput
            value={url ?? ''}
            placeholder="Paste your public SiIvaGunner playlist link (youtube.com/playlist?list=…)"
            ariaLabel="SiIvaGunner YouTube playlist"
            validate={playlistError}
            onCommit={(v) => setUrl(v || null)}
            className="grow"
          />
          <Button kind="primary" icon="refresh" disabled={!status?.playlistUrl || syncing} onClick={() => void sync()}>
            {syncing ? 'Syncing…' : 'Sync Now'}
          </Button>
          <Button icon="settings" onClick={() => navigate({ view: 'settings', section: 'siivagunner' })}>
            Seasons…
          </Button>
        </div>
        <div className="yt-meta faint">
          {status?.playlistTitle && (
            <>
              <b>{status.playlistTitle}</b> ·{' '}
            </>
          )}
          {status?.lastSync ? `synced ${relativeTime(status.lastSync)}` : 'not synced yet'}
          {status?.summary ? ` · ${status.summary}` : ''}
          {status?.autoSync === false ? ' · automatic sync is off' : ' · syncs on its own every 6 hours'}
          {status?.ytDlpVersion ? ` · yt-dlp ${status.ytDlpVersion}` : ''}
        </div>
        {status?.error && <p className="set-callout warn">{status.error}</p>}
        <p className="faint yt-note">
          Only uploads from the SiIvaGunner channel are downloaded (best audio, kept as-is). Each goes into its season’s album, numbered by upload date, so
          an older rip added later slots in where it was released.
        </p>
      </div>
      {!status ? (
        <div className="center-spin">
          <Spinner />
        </div>
      ) : !entries.length ? (
        <Empty icon="star" title={status.playlistUrl ? 'No entries yet' : 'No playlist yet'}>
          <span>{status.playlistUrl ? 'Press Sync Now to read your playlist.' : 'Paste the link to your public SiIvaGunner playlist above.'}</span>
        </Empty>
      ) : (
        <>
          <div className="bc-toolbar">
            <Segmented<Scope>
              value={scope}
              onChange={setScope}
              options={[
                { value: 'all', label: 'All' },
                { value: 'missing', label: 'Not Yet' },
                { value: 'in-library', label: 'In Library' },
                { value: 'skipped', label: 'Skipped' },
              ]}
            />
            <span className="faint bc-count">
              {plural(entries.length, 'video')} · {inLib} in library
            </span>
          </div>
          <div className="card glass yt-list">
            {p.visible.map((e) => (
              <div key={e.id} className="yt-row" onDoubleClick={() => openLink(`https://www.youtube.com/watch?v=${e.id}`)} title="Double-click to open on YouTube">
                <span className="grow ellipsis">{e.title}</span>
                {e.state !== 'not-siivagunner' && e.channel && e.channel !== 'SiIvaGunner' ? <span className="faint ellipsis">{e.channel}</span> : null}
                {e.state === 'not-siivagunner' && <span className="faint ellipsis">{e.channel ?? 'unknown channel'}</span>}
                <span className="faint tnum">{e.durationSec ? duration(e.durationSec * 1000) : ''}</span>
                <span className={cx('chip', STATE_LABEL[e.state].cls)}>{STATE_LABEL[e.state].label}</span>
              </div>
            ))}
          </div>
          <LoadMore hasMore={p.more} loading={false} onMore={p.showMore} shown={p.visible.length} total={shown.length} noun="videos" />
        </>
      )}
    </>
  )
}
