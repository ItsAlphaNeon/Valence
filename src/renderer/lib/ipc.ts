// Thin typed wrappers over the preload bridge.

export function invoke<T = unknown>(channel: string, ...args: unknown[]): Promise<T> {
  return window.valence.invoke(channel, ...args) as Promise<T>
}

export function on<T extends unknown[] = unknown[]>(channel: string, cb: (...args: T) => void): () => void {
  return window.valence.on(channel, (...a) => cb(...(a as T)))
}

export function send(channel: string, ...args: unknown[]): void {
  window.valence.send(channel, ...args)
}

/** Errors from main arrive as "Error invoking remote method 'x': Error: [kind] message". */
export function errorMessage(e: unknown): string {
  const m = (e as Error)?.message ?? String(e)
  return m.replace(/^Error invoking remote method '[^']+': (?:\w*Error: )?/, '')
}

export function artUrl(hash: string | null | undefined, size = 300): string | undefined {
  return hash ? `valence-art://img/${hash}?s=${size}` : undefined
}

export const platform: string = window.valence?.platform ?? 'win32'
export const revealLabel = platform === 'darwin' ? 'Show in Finder' : platform === 'win32' ? 'Show in Explorer' : 'Show in File Manager'
