// Bandcamp source: wires the persistent session, client, acquirer and IPC handlers.

import { BANDCAMP_CHANNELS as CH, type BandcampCollectionRequest } from '@shared/ipc/bandcamp'
import type { AppContext } from '../../context'
import { handle } from '../../ipc'
import { createAcquirer } from './acquire'
import { BandcampClient } from './client'
import { BandcampService } from './service'
import { createBandcampSession } from './session'

export function registerBandcamp(ctx: AppContext): void {
  const bc = createBandcampSession()
  const client = new BandcampClient({ transport: bc.transport })
  const service = new BandcampService({ ctx, client, auth: bc })

  ctx.imports.registerAcquirer(
    'bandcamp',
    createAcquirer({ client, log: ctx.log, refreshRedownloadUrl: (key) => service.redownloadUrlFor(key) }),
    { concurrency: 2 },
  )

  handle(CH.status, () => service.status())
  handle(CH.login, () => service.login())
  handle(CH.logout, () => service.logout())
  handle(CH.collection, (req?: BandcampCollectionRequest) => service.collection(req ?? {}))
  handle(CH.item, (key: string) => service.item(String(key)))
  handle(CH.download, (key: string) => service.download(String(key)))
  handle(CH.downloadAllMissing, () => service.downloadAllMissing())
}
