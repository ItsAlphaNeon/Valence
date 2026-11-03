import { useEffect, useState } from 'react'
import { invoke, errorMessage } from '../../../lib/ipc'
import { toast } from '../../../state/ui'
import { IMPORT } from '@shared/ipc/import'
import { Card, PathLine, Row, SectionHead, Toggle, useSettingValue } from '../controls'

export async function openInbox(): Promise<void> {
  try {
    const err = await invoke<string>(IMPORT.openInbox)
    if (err) toast(err, 'error')
  } catch (e) {
    toast(`Couldn’t open the Inbox: ${errorMessage(e)}`, 'error')
  }
}

export function InboxSection() {
  const [dir, setDir] = useState<string | null>(null)
  const [enabled, setEnabled] = useSettingValue<boolean>('import.inbox', true)
  useEffect(() => {
    invoke<{ dir: string; enabled: boolean }>(IMPORT.inboxInfo).then(
      (i) => setDir(i.dir),
      (e) => toast(`Couldn’t read Inbox info: ${errorMessage(e)}`, 'error'),
    )
  }, [])
  return (
    <>
      <SectionHead icon="inbox" title="Inbox">
        A drop folder for music. Anything you put in it is imported automatically — identified, tagged, transcoded and filed into the library.
      </SectionHead>

      <Card title="Inbox folder">
        <PathLine path={dir} empty="Loading…" openLabel="Open" onOpen={() => void openInbox()} />
        <Row label="Import automatically" desc="Watch the Inbox and import new files once they stop changing.">
          <Toggle checked={enabled} onChange={setEnabled} label="Import automatically" />
        </Row>
      </Card>

      <Card title="How it works">
        <ol className="set-steps">
          <li>Drop files or whole album folders into the Inbox — from a download, a CD rip, another computer.</li>
          <li>Valence waits until copying finishes, then groups files by album and queues them in Import.</li>
          <li>
            Once imported, originals move to <span className="mono">Inbox/Imported</span> so nothing is lost. Lossless masters also go to the Archive.
          </li>
          <li>Albums Valence can’t match confidently wait in Import → Needs Review.</li>
        </ol>
      </Card>
    </>
  )
}
