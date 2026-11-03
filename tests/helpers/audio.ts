// Generates small test audio files with ffmpeg (sine tones; distinct frequency per file).

import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { ffmpegOrThrow } from '@main/media/ffmpeg'

export type GenFormat = 'flac16' | 'flac24' | 'mp3_320' | 'mp3_128' | 'mp3_v0' | 'aac' | 'alac' | 'opus' | 'vorbis' | 'wav' | 'wma'

const CODEC: Record<GenFormat, string[]> = {
  flac16: ['-c:a', 'flac', '-sample_fmt', 's16', '-ar', '44100'],
  flac24: ['-c:a', 'flac', '-sample_fmt', 's32', '-bits_per_raw_sample', '24', '-ar', '96000'],
  mp3_320: ['-c:a', 'libmp3lame', '-b:a', '320k', '-ar', '44100'],
  mp3_128: ['-c:a', 'libmp3lame', '-b:a', '128k', '-ar', '44100'],
  mp3_v0: ['-c:a', 'libmp3lame', '-q:a', '0', '-ar', '44100'],
  aac: ['-c:a', 'aac', '-b:a', '256k', '-ar', '44100'],
  alac: ['-c:a', 'alac', '-ar', '44100'],
  opus: ['-c:a', 'libopus', '-b:a', '160k'],
  vorbis: ['-c:a', 'libvorbis', '-q:a', '6', '-ar', '44100'],
  wav: ['-c:a', 'pcm_s16le', '-ar', '44100'],
  wma: ['-c:a', 'wmav2', '-b:a', '192k', '-ar', '44100'],
}

export interface GenOptions {
  seconds?: number
  freq?: number
  metadata?: Record<string, string | number>
  channels?: number
}

export async function genAudio(path: string, fmt: GenFormat, opts: GenOptions = {}): Promise<string> {
  mkdirSync(dirname(path), { recursive: true })
  const seconds = opts.seconds ?? 2
  const freq = opts.freq ?? 440
  const meta: string[] = []
  for (const [k, v] of Object.entries(opts.metadata ?? {})) meta.push('-metadata', `${k}=${v}`)
  const id3 = fmt.startsWith('mp3') ? ['-id3v2_version', '3', '-write_id3v1', '0'] : []
  await ffmpegOrThrow([
    '-y',
    '-f', 'lavfi',
    '-i', `sine=frequency=${freq}:sample_rate=${fmt === 'flac24' ? 96000 : 48000}:duration=${seconds}`,
    '-ac', String(opts.channels ?? 2),
    ...CODEC[fmt],
    ...meta,
    ...id3,
    path,
  ])
  return path
}

/** A small JPEG/PNG for artwork tests (solid color via ffmpeg). */
export async function genImage(path: string, size: number, color = 'teal'): Promise<string> {
  mkdirSync(dirname(path), { recursive: true })
  await ffmpegOrThrow(['-y', '-f', 'lavfi', '-i', `color=c=${color}:s=${size}x${size}:d=1`, '-frames:v', '1', path])
  return path
}
