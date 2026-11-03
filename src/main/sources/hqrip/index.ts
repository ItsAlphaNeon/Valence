// SiIvaGunner rip albums: wires the Drive client, the 'hqrip' acquirer, the catalog service and IPC.

import type { AppContext } from '../../context'
import { handle } from '../../ipc'
import { HQRIP_IPC, type HqrCollection } from '@shared/ipc/hqrip'
import { createAcquirer } from './acquire'
import { DriveClient } from './drive'
import { HqripService } from './service'

export function registerHqrip(ctx: AppContext): HqripService {
  const transport = (url: string, init?: RequestInit) => fetch(url, init)
  const drive = new DriveClient(transport)
  const service = new HqripService({ ctx, transport, drive })
  // One album at a time, two files in parallel inside it: plenty for Drive, polite enough not to be throttled.
  ctx.imports.registerAcquirer(
    'hqrip',
    createAcquirer({ drive, log: ctx.log, onListed: (id, info) => service.noteListed(id, info) }),
    { concurrency: 1 },
  )
  handle(HQRIP_IPC.catalog, (refresh?: boolean) => service.catalog(!!refresh))
  handle(HQRIP_IPC.download, (id: string) => service.download(String(id)))
  handle(HQRIP_IPC.downloadAllMissing, (c: HqrCollection) => service.downloadAllMissing(c === 'SGFR' ? 'SGFR' : 'SiIvaGunner'))
  return service
}
