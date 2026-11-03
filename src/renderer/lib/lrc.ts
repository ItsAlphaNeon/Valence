// LRC parsing for the lyrics views. Handles multiple timestamps per line, [offset:], metadata tags
// and enhanced (word-level <mm:ss.xx>) timing, which is stripped.

export interface LyricLine {
  /** Start time in ms; null for plain (unsynced) lyrics. */
  t: number | null
  text: string
}

export interface Lyrics {
  synced: boolean
  lines: LyricLine[]
}

const STAMP = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g
const META = /^\[(ar|ti|al|au|by|length|re|ve|offset|#):([^\]]*)\]\s*$/i

function ms(m: string, s: string, frac?: string): number {
  const f = frac ? Number(frac.padEnd(3, '0').slice(0, 3)) : 0
  return Number(m) * 60_000 + Number(s) * 1000 + f
}

export function parseLyrics(text: string | null | undefined): Lyrics | null {
  if (!text?.trim()) return null
  const raw = text.replace(/\r\n?/g, '\n').split('\n')
  let offset = 0
  const timed: LyricLine[] = []
  let stampedLines = 0
  for (const line of raw) {
    const meta = META.exec(line.trim())
    if (meta) {
      if (meta[1].toLowerCase() === 'offset') offset = Number(meta[2]) || 0
      continue
    }
    STAMP.lastIndex = 0
    const stamps: number[] = []
    let m: RegExpExecArray | null
    let end = 0
    while ((m = STAMP.exec(line)) && m.index === end) {
      stamps.push(ms(m[1], m[2], m[3]))
      end = STAMP.lastIndex
    }
    if (!stamps.length) continue
    stampedLines++
    const body = line
      .slice(end)
      .replace(/<\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?>/g, '')
      .trim()
    for (const t of stamps) timed.push({ t: Math.max(0, t - offset), text: body })
  }
  if (stampedLines >= 2) {
    timed.sort((a, b) => a.t! - b.t!)
    // Drop leading empty cues so the first visible line isn't a blank.
    while (timed.length && !timed[0].text) timed.shift()
    return { synced: true, lines: timed }
  }
  const lines = raw.map((l) => ({ t: null, text: l.trim() }))
  while (lines.length && !lines[lines.length - 1].text) lines.pop()
  return { synced: false, lines }
}

/** Index of the line active at `posMs` (-1 before the first cue). */
export function activeLine(lines: LyricLine[], posMs: number): number {
  let lo = 0
  let hi = lines.length - 1
  let ans = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if ((lines[mid].t ?? Infinity) <= posMs) {
      ans = mid
      lo = mid + 1
    } else hi = mid - 1
  }
  return ans
}
