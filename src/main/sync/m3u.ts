// Extended M3U (UTF-8 .m3u8) with paths relative to the playlist file, readable by Android
// players (Poweramp, Musicolet, Symfonium), foobar2000, MusicBee, VLC, etc.

import { posix } from 'node:path'

export interface M3uEntry {
  /** Library-relative path ("/"-separated). */
  relPath: string
  durationSec?: number
  title?: string
}

export function writeM3u(playlistRelPath: string, entries: M3uEntry[]): string {
  const from = posix.dirname(playlistRelPath)
  const lines = ['#EXTM3U']
  for (const e of entries) {
    const dur = e.durationSec !== undefined ? Math.round(e.durationSec) : -1
    if (e.title) lines.push(`#EXTINF:${dur},${e.title.replace(/[\r\n]+/g, ' ')}`)
    lines.push(posix.relative(from, e.relPath))
  }
  return lines.join('\n') + '\n'
}

/** Parses an m3u/m3u8 into library-relative paths. Absolute paths are mapped if they fall under libraryRoot. */
export function parseM3u(text: string, playlistRelPath: string, libraryRoot?: string): M3uEntry[] {
  const from = posix.dirname(playlistRelPath)
  const out: M3uEntry[] = []
  let pending: { durationSec?: number; title?: string } = {}
  const rootNorm = libraryRoot?.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  for (const raw of text.replace(/^﻿/, '').split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    if (line.startsWith('#')) {
      const m = /^#EXTINF:(-?\d+(?:\.\d+)?)\s*(?:[^,]*)?,(.*)$/.exec(line)
      if (m) pending = { durationSec: Number(m[1]) >= 0 ? Number(m[1]) : undefined, title: m[2].trim() || undefined }
      continue
    }
    let p = line.replace(/\\/g, '/')
    if (/^file:\/\//i.test(p)) p = decodeURIComponent(p.replace(/^file:\/\/\/?/i, ''))
    let rel: string | null
    if (/^[a-z]:\//i.test(p) || p.startsWith('/')) {
      rel = rootNorm && p.toLowerCase().startsWith(rootNorm + '/') ? p.slice(rootNorm.length + 1) : null
    } else {
      rel = posix.normalize(posix.join(from, p))
      if (rel.startsWith('../')) rel = null
    }
    if (rel) out.push({ relPath: rel, ...pending })
    pending = {}
  }
  return out
}

/** Union merge used when Syncthing produced a conflict copy of a playlist: keep order of `a`, append new items of `b`. */
export function unionMerge(a: M3uEntry[], b: M3uEntry[]): M3uEntry[] {
  const seen = new Set(a.map((e) => e.relPath.toLowerCase()))
  return [...a, ...b.filter((e) => !seen.has(e.relPath.toLowerCase()))]
}
