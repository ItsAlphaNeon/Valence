import { useState } from 'react'
import { invoke, errorMessage } from '../../../lib/ipc'
import { bytes, plural } from '../../../lib/format'
import { toast } from '../../../state/ui'
import { IMPORT, type ArchiveStatusInfo } from '@shared/ipc/import'
import { Button, Spinner } from '../../../components/ui'
import { Icon } from '../../../components/Icon'
import { archiveState, useArchiveStatus } from '../../import/useArchive'
import { Card, PathLine, Row, SectionHead, openPath, useAppInfo } from '../controls'

function sep(): string {
  return window.valence?.platform === 'win32' ? '\\' : '/'
}

export function ArchiveSection() {
  const { status, setStatus } = useArchiveStatus()
  const { info } = useAppInfo()
  const [busy, setBusy] = useState<null | 'choose' | 'flush'>(null)
  const state = archiveState(status)
  const pendingDir = info ? `${info.dataDir}${sep()}archive-pending` : null

  const choose = async () => {
    setBusy('choose')
    try {
      const before = status?.dir
      const s = await invoke<ArchiveStatusInfo>(IMPORT.chooseArchiveDir)
      setStatus(s)
      if (s.dir && s.dir !== before) toast(s.online ? 'Archive folder set' : 'Archive folder set, but it isn’t reachable right now', s.online ? 'ok' : 'info')
    } catch (e) {
      toast(`Couldn’t set the archive folder: ${errorMessage(e)}`, 'error')
    } finally {
      setBusy(null)
    }
  }

  const flush = async () => {
    setBusy('flush')
    const before = status?.pendingFiles ?? 0
    try {
      const s = await invoke<ArchiveStatusInfo>(IMPORT.flushArchive)
      setStatus(s)
      const moved = Math.max(0, before - s.pendingFiles)
      if (!s.online) toast('The archive folder isn’t reachable — files stay pending', 'error')
      else toast(moved ? `Moved ${plural(moved, 'file')} into the archive` : 'Nothing left to move', 'ok')
    } catch (e) {
      toast(`Flush failed: ${errorMessage(e)}`, 'error')
    } finally {
      setBusy(null)
    }
  }

  return (
    <>
      <SectionHead icon="disc" title="Lossless Archive">
        Every lossless download or import keeps its original FLAC master here, next to the original cover art and booklets. The library itself holds the smaller transcodes.
      </SectionHead>

      <Card
        title="Archive folder"
        aside={
          state === 'online' ? (
            <span className="chip ok">
              <Icon name="check" size={12} /> Connected
            </span>
          ) : state === 'offline' ? (
            <span className="chip warn">
              <Icon name="warning" size={12} /> Offline
            </span>
          ) : state === 'unset' ? (
            <span className="chip">Not set</span>
          ) : (
            <Spinner size={14} />
          )
        }
      >
        <PathLine path={status?.dir} empty="Not set — FLAC masters wait in pending" onOpen={state === 'online' ? undefined : () => toast('The archive folder isn’t reachable right now', 'error')} />
        {state === 'offline' && <p className="set-callout warn">The folder can’t be reached — is the drive connected? New masters wait in pending and move over automatically once it’s back.</p>}
        <Row label={status?.dir ? 'Change folder' : 'Choose a folder'} desc="Pick a roomy local or external drive. Pending masters move there right away.">
          <Button icon="folder" onClick={() => void choose()} disabled={!!busy}>
            {busy === 'choose' ? 'Choosing…' : 'Choose…'}
          </Button>
        </Row>
      </Card>

      <Card title="Pending">
        <Row
          label={status ? (status.pendingFiles ? `${plural(status.pendingFiles, 'file')} waiting` : 'Nothing waiting') : 'Checking…'}
          desc={
            status && status.pendingFiles
              ? `${bytes(status.pendingBytes)} in Valence’s data folder. They move automatically about once a minute while the archive is reachable.`
              : 'Masters land here while the archive is unset or offline.'
          }
        >
          <div className="row">
            {pendingDir && (
              <Button small kind="ghost" onClick={() => void openPath(pendingDir)} title={pendingDir}>
                Open
              </Button>
            )}
            <Button icon="refresh" onClick={() => void flush()} disabled={!!busy || !status?.pendingFiles || state !== 'online'}>
              {busy === 'flush' ? 'Moving…' : 'Flush Now'}
            </Button>
          </div>
        </Row>
      </Card>

      <p className="set-footnote">
        <Icon name="info" size={13} /> The archive is per-machine and never synced — each computer can point at its own drive (or none). Undoing an import also trashes the masters it archived.
      </p>
    </>
  )
}
