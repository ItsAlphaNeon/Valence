// TIDAL source: wires auth, client, acquirer and IPC handlers into the app context.

import { session } from 'electron'
import { TIDAL_IPC } from '@shared/ipc/tidal'
import type { AppContext } from '../../context'
import { SourceError, type Transport } from '../../import/source-types'
import { handle } from '../../ipc'
import { createTidalAcquirer } from './acquirer'
import { TidalApi } from './api'
import { TidalAuth } from './auth'
import { TidalClient } from './client'
import { resolveConfig, type TidalConfig } from './config'
import { Pacer } from './pacing'
import { createTidalService } from './service'

export function partitionTransport(cfg: TidalConfig): Transport {
  const ses = session.fromPartition(cfg.partition)
  return (url, init) => ses.fetch(url, init)
}

export function registerTidal(ctx: AppContext): void {
  const cfg = resolveConfig(ctx.settings)
  const transport = partitionTransport(cfg)
  const auth = new TidalAuth({
    cfg,
    secrets: ctx.secrets,
    transport,
    log: ctx.log,
    onChange: (s) => ctx.broadcast(TIDAL_IPC.statusChanged, s),
  })
  const client = new TidalClient({
    cfg,
    auth,
    transport,
    onAbuse: (msg) => {
      ctx.log.warn('TIDAL abuse signal; pausing downloads', msg)
      ctx.imports.pauseSource('tidal', msg)
    },
  })
  const api = new TidalApi(client, () => auth.session()?.userId)
  const pacer = new Pacer()

  ctx.imports.registerAcquirer('tidal', createTidalAcquirer({ api, transport, pacer, library: () => ctx.library, log: ctx.log }), { concurrency: 1 })

  const svc = createTidalService({ ctx, auth, api, onSessionChange: () => client.clearCache() })
  // Electron serializes only the message across IPC, so the SourceError kind goes in front: "[auth] …".
  const on = (channel: string, fn: (...args: any[]) => unknown) =>
    handle(channel, async (...args) => {
      try {
        return await fn(...args)
      } catch (e) {
        throw e instanceof SourceError ? new Error(`[${e.kind}] ${e.message}`) : e
      }
    })
  on(TIDAL_IPC.status, () => svc.status())
  on(TIDAL_IPC.login, () => svc.login())
  on(TIDAL_IPC.logout, () => svc.logout())
  on(TIDAL_IPC.favorites, (kind, offset, limit) => svc.favorites(kind, offset, limit))
  on(TIDAL_IPC.search, (query, types) => svc.search(query, types))
  on(TIDAL_IPC.album, (id) => svc.album(id))
  on(TIDAL_IPC.artist, (id) => svc.artist(id))
  on(TIDAL_IPC.playlist, (uuid) => svc.playlist(uuid))
  on(TIDAL_IPC.resolveLink, (url) => svc.resolveLink(url))
  on(TIDAL_IPC.download, (req) => svc.download(req))
  on(TIDAL_IPC.downloadPlaylist, (uuid) => svc.downloadPlaylist(uuid))
}
