// Live lossless-archive status (shared by the Import header chip and Settings → Archive).

import { useCallback, useEffect, useState } from 'react'
import { errorMessage, invoke, on } from '../../lib/ipc'
import { toast } from '../../state/ui'
import { IMPORT, type ArchiveStatusInfo } from '@shared/ipc/import'

export function useArchiveStatus(): { status: ArchiveStatusInfo | null; setStatus: (s: ArchiveStatusInfo) => void; reload: () => void } {
  const [status, setStatus] = useState<ArchiveStatusInfo | null>(null)
  const reload = useCallback(() => {
    invoke<ArchiveStatusInfo>(IMPORT.archiveStatus).then(setStatus, (e) => toast(`Couldn’t read archive status: ${errorMessage(e)}`, 'error'))
  }, [])
  useEffect(() => {
    reload()
    return on<[ArchiveStatusInfo]>(IMPORT.archiveChanged, (s) => s && setStatus(s))
  }, [reload])
  return { status, setStatus, reload }
}

export type ArchiveState = 'online' | 'offline' | 'unset'

export function archiveState(s: ArchiveStatusInfo | null): ArchiveState | null {
  if (!s) return null
  if (!s.dir) return 'unset'
  return s.online ? 'online' : 'offline'
}
