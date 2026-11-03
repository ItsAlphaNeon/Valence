// Cross-window player relay (see src/main/audio/relay.ts).
//   Main window:  attachPlayerRelay(player)          publishes state, executes remote commands
//   Mini player:  const remote = new RemotePlayer()  mirrors state, sends commands

import { Emitter } from './engine'
import type { Player } from './player'
import type { PlayerCommand, PlayerState } from './types'

export function attachPlayerRelay(player: Player): () => void {
  const v = window.valence
  const offState = player.on('state', (s) => v.send('player:state', s))
  const offCmd = v.on('player:command', (cmd) => player.command(cmd as PlayerCommand))
  v.send('player:state', player.getState())
  return () => {
    offState()
    offCmd()
  }
}

export class RemotePlayer extends Emitter<{ state: PlayerState }> {
  private s: PlayerState | null = null
  private unsub: () => void

  constructor() {
    super()
    this.unsub = window.valence.on('player:state', (s) => this.set(s as PlayerState))
    void window.valence.invoke('player:getState').then((s) => s && !this.s && this.set(s as PlayerState))
  }

  private set(s: PlayerState): void {
    this.s = s
    this.emit('state', s)
  }

  getState(): PlayerState | null {
    return this.s
  }

  command(cmd: PlayerCommand): void {
    window.valence.send('player:command', cmd)
  }

  dispose(): void {
    this.unsub()
    this.clearListeners()
  }
}
