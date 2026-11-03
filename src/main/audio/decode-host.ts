// `pcm` MessagePort provider: one DecodeSession per port (i.e. per worklet engine instance).

import type { MessagePortMain } from 'electron'
import type { AppContext } from '../context'
import { providePort } from '../ipc'
import { ffmpegPath } from '../platform/binaries'
import type { AudioAccess } from './access'
import { DecodeSession, probeDurationSec } from './decoder'
import type { PcmRequest } from './pcm-protocol'

export function registerDecodeHost(ctx: AppContext, access: AudioAccess): void {
  providePort('pcm', (port: MessagePortMain, _args, sender) => {
    const session = new DecodeSession((m) => port.postMessage(m), {
      ffmpeg: ffmpegPath(),
      resolve: (p) => access.resolve(p),
      durationOf: probeDurationSec,
      log: (m) => ctx.log.warn(m),
    })
    port.on('message', (e) => session.handle(e.data as PcmRequest))
    port.on('close', () => session.closeAll())
    port.start()
    sender.once('destroyed', () => {
      session.closeAll()
      port.close()
    })
  })
}
