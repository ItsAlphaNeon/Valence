import { useEffect, useState, type ReactNode } from 'react'
import { invoke, errorMessage, on } from '../../../lib/ipc'
import { useLib } from '../../../state/library'
import { toast } from '../../../state/ui'
import { TIDAL_IPC, type TidalStatus } from '@shared/ipc/tidal'
import { BANDCAMP_CHANNELS, type BandcampStatus } from '@shared/ipc/bandcamp'
import { IMPORT } from '@shared/ipc/import'
import { Button, Spinner } from '../../../components/ui'
import { Icon } from '../../../components/Icon'
import { Card, Disclosure, SectionHead, StackRow, TextSetting } from '../controls'

/** Strips the "[kind] " prefix main puts in front of source errors. */
function sourceError(e: unknown): string {
  return errorMessage(e).replace(/^\[\w[\w-]*\]\s*/, '')
}

function PausedNotice({ source }: { source: string }) {
  const reason = useLib((s) => s.pausedSources[source])
  if (!reason) return null
  return (
    <div className="set-callout warn row">
      <Icon name="warning" size={14} />
      <span className="grow">Downloads are paused: {reason}</span>
      <Button
        small
        onClick={() =>
          invoke(IMPORT.resumeSource, source).then(
            () => toast('Downloads resumed', 'ok'),
            (e) => toast(errorMessage(e), 'error'),
          )
        }
      >
        Resume
      </Button>
    </div>
  )
}

function AccountCard({
  name,
  mark,
  loading,
  loggedIn,
  detail,
  busy,
  onLogin,
  onLogout,
  children,
}: {
  name: string
  mark: string
  loading: boolean
  loggedIn: boolean
  detail?: ReactNode
  busy: null | 'login' | 'logout'
  onLogin: () => void
  onLogout: () => void
  children?: ReactNode
}) {
  return (
    <Card>
      <div className="set-account">
        <div className="set-account-mark" aria-hidden>
          {mark}
        </div>
        <div className="grow">
          <div className="set-account-name">{name}</div>
          <div className="set-account-status">
            {loading ? (
              <span className="faint">Checking…</span>
            ) : loggedIn ? (
              <>
                <span className="set-dot ok" /> Signed in{detail ? <span className="faint"> · {detail}</span> : null}
              </>
            ) : (
              <>
                <span className="set-dot" /> Not signed in
              </>
            )}
          </div>
        </div>
        {busy ? (
          <Spinner size={16} />
        ) : loggedIn ? (
          <Button onClick={onLogout} disabled={loading}>
            Log Out
          </Button>
        ) : (
          <Button kind="primary" onClick={onLogin} disabled={loading}>
            Log In…
          </Button>
        )}
      </div>
      {children}
    </Card>
  )
}

function TidalAccount() {
  const [status, setStatus] = useState<TidalStatus | null>(null)
  const [busy, setBusy] = useState<null | 'login' | 'logout'>(null)
  useEffect(() => {
    let live = true
    invoke<TidalStatus>(TIDAL_IPC.status).then(
      (s) => live && setStatus(s),
      (e) => {
        if (!live) return
        setStatus({ loggedIn: false, userId: null, countryCode: null })
        toast(`TIDAL: ${sourceError(e)}`, 'error')
      },
    )
    const off = on<[TidalStatus]>(TIDAL_IPC.statusChanged, (s) => s && setStatus(s))
    return () => {
      live = false
      off()
    }
  }, [])
  const run = async (kind: 'login' | 'logout') => {
    setBusy(kind)
    try {
      const s = await invoke<TidalStatus | undefined>(kind === 'login' ? TIDAL_IPC.login : TIDAL_IPC.logout)
      if (s) setStatus(s)
      else if (kind === 'logout') setStatus({ loggedIn: false, userId: null, countryCode: null })
      if (kind === 'login' && s?.loggedIn) toast('Signed in to TIDAL', 'ok')
    } catch (e) {
      toast(`TIDAL ${kind === 'login' ? 'login' : 'logout'} failed: ${sourceError(e)}`, 'error')
    } finally {
      setBusy(null)
    }
  }
  const detail = status?.loggedIn ? [status.countryCode, status.userId ? `user ${status.userId}` : null].filter(Boolean).join(' · ') : undefined
  return (
    <AccountCard
      name="TIDAL"
      mark="T"
      loading={!status}
      loggedIn={!!status?.loggedIn}
      detail={detail || undefined}
      busy={busy}
      onLogin={() => void run('login')}
      onLogout={() => void run('logout')}
    >
      <p className="set-card-note">Browse your TIDAL favorites and download albums in lossless quality. Logging in opens TIDAL’s own sign-in page in a separate window.</p>
      <PausedNotice source="tidal" />
      <Disclosure title="Advanced">
        <p className="set-card-note">
          TIDAL occasionally retires the app credentials Valence signs in with. If logins start failing, paste a newer client ID and secret here; leave both empty to use the built-in pair. Log out and
          back in after changing them.
        </p>
        <StackRow label="Client ID">
          <TextSetting k="tidal.clientId" mono placeholder="Built-in" ariaLabel="TIDAL client ID" width="100%" />
        </StackRow>
        <StackRow label="Client secret">
          <TextSetting k="tidal.clientSecret" type="password" mono placeholder="Built-in" ariaLabel="TIDAL client secret" width="100%" />
        </StackRow>
      </Disclosure>
    </AccountCard>
  )
}

function BandcampAccount() {
  const [status, setStatus] = useState<BandcampStatus | null>(null)
  const [busy, setBusy] = useState<null | 'login' | 'logout'>(null)
  useEffect(() => {
    let live = true
    invoke<BandcampStatus>(BANDCAMP_CHANNELS.status).then(
      (s) => live && setStatus(s),
      (e) => {
        if (!live) return
        setStatus({ loggedIn: false, fanId: null })
        toast(`Bandcamp: ${sourceError(e)}`, 'error')
      },
    )
    return () => {
      live = false
    }
  }, [])
  const run = async (kind: 'login' | 'logout') => {
    setBusy(kind)
    try {
      const s = await invoke<BandcampStatus>(kind === 'login' ? BANDCAMP_CHANNELS.login : BANDCAMP_CHANNELS.logout)
      setStatus(s)
      if (kind === 'login' && s.loggedIn) toast('Signed in to Bandcamp', 'ok')
    } catch (e) {
      toast(`Bandcamp ${kind === 'login' ? 'login' : 'logout'} failed: ${sourceError(e)}`, 'error')
    } finally {
      setBusy(null)
    }
  }
  return (
    <AccountCard
      name="Bandcamp"
      mark="b"
      loading={!status}
      loggedIn={!!status?.loggedIn}
      detail={status?.username ?? (status?.fanId ? `fan ${status.fanId}` : undefined)}
      busy={busy}
      onLogin={() => void run('login')}
      onLogout={() => void run('logout')}
    >
      <p className="set-card-note">See your Bandcamp purchases and download the ones missing from your library. Valence downloads FLAC and files it like any other import.</p>
      <PausedNotice source="bandcamp" />
    </AccountCard>
  )
}

export function AccountsSection() {
  return (
    <>
      <SectionHead icon="user" title="Accounts">
        Sign-ins stay on this computer — they aren’t synced to your other devices with the library.
      </SectionHead>
      <TidalAccount />
      <BandcampAccount />
    </>
  )
}
