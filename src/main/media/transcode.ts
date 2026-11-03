// Library format profiles and the ffmpeg invocations that produce them. Tags are never copied by
// ffmpeg (-map_metadata -1); the pipeline writes them afterwards with taglib.

import type { AudioFormat } from '@shared/types'
import { ffmpegOrThrow } from './ffmpeg'

export type ProfileId = 'mp3-320' | 'mp3-v0' | 'aac-256' | 'opus-192' | 'flac'

export interface Profile {
  id: ProfileId
  label: string
  ext: string
  lossless: boolean
}

export const PROFILES: Record<ProfileId, Profile> = {
  'mp3-320': { id: 'mp3-320', label: 'MP3 320 kbps CBR', ext: 'mp3', lossless: false },
  'mp3-v0': { id: 'mp3-v0', label: 'MP3 V0 (VBR ~245 kbps)', ext: 'mp3', lossless: false },
  'aac-256': { id: 'aac-256', label: 'AAC 256 kbps (M4A)', ext: 'm4a', lossless: false },
  'opus-192': { id: 'opus-192', label: 'Opus 192 kbps', ext: 'opus', lossless: false },
  flac: { id: 'flac', label: 'FLAC (keep lossless)', ext: 'flac', lossless: true },
}

/** Lossy codecs kept as-is (never lossy→lossy). Everything else lossy is re-encoded to MP3 320. */
const KEEP_LOSSY = new Set(['mp3', 'aac', 'opus', 'vorbis'])
const KEEP_CONTAINERS: Record<string, string> = { mp3: 'mp3', aac: 'm4a', opus: 'opus', vorbis: 'ogg' }

export type TranscodePlan =
  | { kind: 'copy'; ext: string }
  | { kind: 'encode'; profile: Profile }

export function planFor(format: AudioFormat, profileId: ProfileId, srcExt: string): TranscodePlan {
  if (format.lossless) return { kind: 'encode', profile: PROFILES[profileId] ?? PROFILES['mp3-320'] }
  if (KEEP_LOSSY.has(format.codec)) {
    const ext = srcExt.toLowerCase()
    // Keep the original container when it is a normal one for the codec (m4a/mp4 for aac, ogg/oga/opus...).
    const ok = format.codec === 'aac' ? ['m4a', 'mp4', 'aac'].includes(ext) : format.codec === 'vorbis' ? ['ogg', 'oga'].includes(ext) : true
    return { kind: 'copy', ext: ok ? (ext === 'mp4' ? 'm4a' : ext) : KEEP_CONTAINERS[format.codec] }
  }
  return { kind: 'encode', profile: PROFILES['mp3-320'] }
}

/** MP3 sample rate: keep 32/44.1/48 kHz; multiples of 44.1k → 44.1k; everything else → 48k. */
export function mp3Rate(rate: number): number {
  if (rate === 32000 || rate === 44100 || rate === 48000) return rate
  if (rate % 44100 === 0 || rate === 22050 || rate === 11025) return 44100
  return 48000
}

export function encodeArgs(input: string, output: string, profile: Profile, format: AudioFormat): string[] {
  const common = ['-y', '-i', input, '-map', '0:a:0', '-vn', '-map_metadata', '-1', '-map_chapters', '-1']
  const ch = format.channels > 2 ? ['-ac', '2'] : []
  switch (profile.id) {
    case 'mp3-320':
      return [...common, ...ch, '-c:a', 'libmp3lame', '-b:a', '320k', '-ar', String(mp3Rate(format.sampleRate || 44100)),
        '-write_id3v1', '0', '-id3v2_version', '0', '-write_xing', '1', output]
    case 'mp3-v0':
      return [...common, ...ch, '-c:a', 'libmp3lame', '-q:a', '0', '-ar', String(mp3Rate(format.sampleRate || 44100)),
        '-write_id3v1', '0', '-id3v2_version', '0', '-write_xing', '1', output]
    case 'aac-256':
      return [...common, ...ch, '-c:a', process.platform === 'darwin' ? 'aac_at' : 'aac', '-b:a', '256k', '-movflags', '+faststart', output]
    case 'opus-192':
      return [...common, ...ch, '-c:a', 'libopus', '-b:a', '192k', '-vbr', 'on', output]
    case 'flac':
      return [...common, '-c:a', 'flac', '-compression_level', '8', output]
  }
}

export async function encode(input: string, output: string, profile: Profile, format: AudioFormat, signal?: AbortSignal): Promise<void> {
  await ffmpegOrThrow(encodeArgs(input, output, profile, format), { signal })
}

/** Lossless master for the archive: FLAC as-is when already FLAC, else ALAC/WAV/AIFF/APE/WV → FLAC. */
export async function toFlacMaster(input: string, output: string, signal?: AbortSignal): Promise<void> {
  await ffmpegOrThrow(['-y', '-i', input, '-map', '0:a:0', '-vn', '-map_metadata', '-1', '-c:a', 'flac', '-compression_level', '8', output], { signal })
}

/** Remuxes a lossy stream into a clean container without re-encoding (drops junk tags/streams). */
export async function remux(input: string, output: string, signal?: AbortSignal): Promise<void> {
  await ffmpegOrThrow(['-y', '-i', input, '-map', '0:a:0', '-vn', '-map_metadata', '-1', '-c:a', 'copy', output], { signal })
}
