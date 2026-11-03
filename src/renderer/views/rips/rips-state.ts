// Actions for the Get Rips page: queue rip album downloads and report the result.

import { HQRIP_IPC, type HqrCollection, type HqrDownloadAllResult, type HqrDownloadResult, type HqrRelease } from '@shared/ipc/hqrip'
import { invoke } from '../../lib/ipc'
import { plural } from '../../lib/format'
import { useLib } from '../../state/library'
import { navigate, toast } from '../../state/ui'
import { addPending, reportSourceError } from '../tidal/source-kit'

const viewQueue = { label: 'View Queue', run: () => navigate({ view: 'import', tab: 'queue' }) }

function queuedToast(text: string): void {
  const paused = useLib.getState().pausedSources.hqrip
  toast(paused ? `${text} — rip downloads are paused` : text, 'ok', viewQueue)
}

export async function downloadRelease(r: Pick<HqrRelease, 'id' | 'title'>): Promise<void> {
  try {
    const res = await invoke<HqrDownloadResult>(HQRIP_IPC.download, r.id)
    addPending(res.releaseKeys, [res.jobId])
    queuedToast(`Queued ${r.title}`)
  } catch (e) {
    reportSourceError('hqrip', e)
  }
}

export async function downloadAllMissing(collection: HqrCollection, releases: HqrRelease[]): Promise<HqrDownloadAllResult | null> {
  try {
    const res = await invoke<HqrDownloadAllResult>(HQRIP_IPC.downloadAllMissing, collection)
    if (res.jobIds.length) addPending(releases.map((r) => r.id), res.jobIds)
    const parts = [res.queued ? `Queued ${plural(res.queued, 'album')}` : 'Nothing new to download']
    if (res.alreadyInLibrary) parts.push(`${res.alreadyInLibrary} already in library`)
    if (res.alreadyQueued) parts.push(`${res.alreadyQueued} already queued`)
    if (res.queued) queuedToast(parts.join(' · '))
    else toast(parts.join(' · '))
    return res
  } catch (e) {
    reportSourceError('hqrip', e)
    return null
  }
}

/** Google Drive folder link for a release's download folder. */
export const driveFolderUrl = (id: string) => `https://drive.google.com/drive/folders/${id}`
