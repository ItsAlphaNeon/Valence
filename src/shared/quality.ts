// Source-quality ranking used for duplicate/upgrade decisions.

export interface QualityInfo {
  lossless: boolean
  codec?: string
  bitrate?: number // bits per second
  sampleRate?: number
  bitDepth?: number
}

/** Encodes quality as "lossless:<bits>:<rate>" or "lossy:<codec>:<kbps>". */
export function encodeSourceQuality(q: QualityInfo): string {
  if (q.lossless) return `lossless:${q.bitDepth || 16}:${q.sampleRate || 44100}`
  return `lossy:${(q.codec || 'unknown').toLowerCase()}:${Math.round((q.bitrate || 0) / 1000)}`
}

export function decodeSourceQuality(s: string | undefined | null): QualityInfo | null {
  if (!s) return null
  const [kind, a, b] = s.split(':')
  if (kind === 'lossless') return { lossless: true, bitDepth: Number(a) || 16, sampleRate: Number(b) || 44100 }
  if (kind === 'lossy') return { lossless: false, codec: a, bitrate: (Number(b) || 0) * 1000 }
  return null
}

// Rough perceptual equivalence of lossy codecs relative to MP3 at the same bitrate.
const CODEC_FACTOR: Record<string, number> = { opus: 1.6, aac: 1.3, 'mpeg-4 aac': 1.3, vorbis: 1.25, mp3: 1, 'mpeg 1 layer 3': 1, wma: 0.9 }

/** Higher is better. Lossless always outranks lossy. */
export function qualityRank(q: QualityInfo): number {
  if (q.lossless) return 100_000 + (q.bitDepth || 16) * 1000 + (q.sampleRate || 44100) / 100
  const factor = CODEC_FACTOR[(q.codec || '').toLowerCase()] ?? 1
  return Math.round(((q.bitrate || 0) / 1000) * factor)
}

/** True if `incoming` is meaningfully better than `existing` (5% margin avoids churn on VBR noise). */
export function isUpgrade(incoming: QualityInfo, existing: QualityInfo): boolean {
  if (incoming.lossless !== existing.lossless) return incoming.lossless
  if (incoming.lossless) return qualityRank(incoming) > qualityRank(existing)
  return qualityRank(incoming) > qualityRank(existing) * 1.05
}
