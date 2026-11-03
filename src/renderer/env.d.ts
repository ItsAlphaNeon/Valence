import type { ValenceBridge } from '../preload/index'

declare global {
  interface Window {
    valence: ValenceBridge
  }
}
export {}
