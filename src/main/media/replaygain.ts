// ReplayGain 2.0-style loudness via ffmpeg's ebur128 filter. Reference level -18 LUFS.

import { runFfmpeg } from './ffmpeg'

export const RG_REFERENCE_LUFS = -18

export interface Loudness {
  integrated: number // LUFS
  truePeakDb: number // dBTP
  durationSec: number
}

export function parseEbur128(stderr: string): { integrated: number; truePeakDb: number } | null {
  const summary = stderr.slice(stderr.lastIndexOf('Summary:'))
  const i = /I:\s+(-?[\d.]+|-inf)\s+LUFS/.exec(summary)
  const p = /Peak:\s+(-?[\d.]+|-inf)\s+dBFS/.exec(summary)
  if (!i) return null
  const integrated = i[1] === '-inf' ? -70 : Number(i[1])
  const truePeakDb = !p || p[1] === '-inf' ? -70 : Number(p[1])
  return { integrated, truePeakDb }
}

export async function measureLoudness(file: string, signal?: AbortSignal): Promise<Loudness | null> {
  let duration = 0
  const r = await runFfmpeg(['-i', file, '-map', '0:a:0', '-af', 'ebur128=peak=true:framelog=quiet', '-f', 'null', '-'], {
    signal,
    onProgressSeconds: (s) => (duration = s),
  })
  if (r.code !== 0) return null
  const parsed = parseEbur128(r.stderr)
  if (!parsed) return null
  return { ...parsed, durationSec: duration }
}

export function trackGain(l: Loudness): { gain: number; peak: number } {
  return { gain: round2(RG_REFERENCE_LUFS - l.integrated), peak: round6(Math.pow(10, l.truePeakDb / 20)) }
}

/** Album loudness = duration-weighted energy mean of the tracks' integrated loudness. */
export function albumGain(tracks: Loudness[]): { gain: number; peak: number } | null {
  const valid = tracks.filter((t) => t.integrated > -70)
  if (!valid.length) return null
  const wsum = valid.reduce((s, t) => s + Math.max(t.durationSec, 1), 0)
  const energy = valid.reduce((s, t) => s + Math.max(t.durationSec, 1) * Math.pow(10, t.integrated / 10), 0) / wsum
  const lufs = 10 * Math.log10(energy)
  const peakDb = Math.max(...tracks.map((t) => t.truePeakDb))
  return { gain: round2(RG_REFERENCE_LUFS - lufs), peak: round6(Math.pow(10, peakDb / 20)) }
}

const round2 = (x: number) => Math.round(x * 100) / 100
const round6 = (x: number) => Math.round(x * 1e6) / 1e6
