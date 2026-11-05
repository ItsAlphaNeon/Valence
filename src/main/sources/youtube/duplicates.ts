// Which copy of a YouTube video stays when the library has several (pure; unit-tested). Copies are the
// same recording only if they run the same length: an edit cut from a rip keeps its tags, video id
// included, and is a track of its own.

import { SAME_LENGTH_MS } from '@main/import/dedupe'
import { isSyncConflict } from '@shared/sanitize'
import type { RipDuplicateGroup } from '@shared/ipc/hqrip'

export interface RipCopy {
  videoId: string
  relPath: string
  title: string
  durationMs: number
}

const nameOf = (rel: string) => rel.slice(rel.lastIndexOf('/') + 1)
const NUMBERED = / \(\d+\)\.[^.]+$/

/**
 * The plainest name stays: not a conflict copy, not "Title (2)", then the shortest, then by path. This
 * goes by name alone, so every device would pick the same copy. (Which copy a device downloaded doesn't
 * matter: they're the same stream.)
 */
function preferred(a: RipCopy, b: RipCopy): number {
  const rank = (c: RipCopy) => (isSyncConflict(nameOf(c.relPath)) ? 2 : NUMBERED.test(nameOf(c.relPath)) ? 1 : 0)
  return rank(a) - rank(b) || a.relPath.length - b.relPath.length || (a.relPath < b.relPath ? -1 : 1)
}

export function planDuplicates(copies: RipCopy[]): RipDuplicateGroup[] {
  const byVideo = new Map<string, RipCopy[]>()
  for (const c of copies) byVideo.set(c.videoId, [...(byVideo.get(c.videoId) ?? []), c])
  const groups: RipDuplicateGroup[] = []
  for (const [videoId, all] of byVideo) {
    const shortestFirst = [...all].sort((a, b) => a.durationMs - b.durationMs)
    const lengths: RipCopy[][] = []
    for (const c of shortestFirst) {
      const last = lengths.at(-1)
      if (last && c.durationMs && c.durationMs - last.at(-1)!.durationMs <= SAME_LENGTH_MS) last.push(c)
      else lengths.push([c])
    }
    for (const same of lengths) {
      const [keep, ...extra] = same.sort(preferred)
      // Only conflict copies: the video isn't in the library proper, so there's nothing to fall back on.
      if (extra.length && !isSyncConflict(nameOf(keep.relPath))) groups.push({ videoId, title: keep.title, keep: keep.relPath, trash: extra.map((c) => c.relPath) })
    }
  }
  return groups.sort((a, b) => (a.keep < b.keep ? -1 : 1))
}
