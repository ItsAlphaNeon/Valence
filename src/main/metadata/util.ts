// String / number similarity helpers shared by the scorer and heuristics.

import { createHash } from 'node:crypto'
import { cleanText, matchKey } from '@shared/sanitize'
import { splitCredit } from '@shared/artist-credit'

export const sha1 = (s: string): string => createHash('sha1').update(s).digest('hex')

export function jaro(a: string, b: string): number {
  if (a === b) return 1
  const s = Array.from(a)
  const t = Array.from(b)
  if (!s.length || !t.length) return 0
  const range = Math.max(0, Math.floor(Math.max(s.length, t.length) / 2) - 1)
  const sm = new Array<boolean>(s.length).fill(false)
  const tm = new Array<boolean>(t.length).fill(false)
  let m = 0
  for (let i = 0; i < s.length; i++) {
    const lo = Math.max(0, i - range)
    const hi = Math.min(t.length - 1, i + range)
    for (let j = lo; j <= hi; j++) {
      if (tm[j] || s[i] !== t[j]) continue
      sm[i] = tm[j] = true
      m++
      break
    }
  }
  if (!m) return 0
  let k = 0
  let trans = 0
  for (let i = 0; i < s.length; i++) {
    if (!sm[i]) continue
    while (!tm[k]) k++
    if (s[i] !== t[k]) trans++
    k++
  }
  return (m / s.length + m / t.length + (m - trans / 2) / m) / 3
}

export function jaroWinkler(a: string, b: string): number {
  const j = jaro(a, b)
  if (j <= 0.7) return j
  const s = Array.from(a)
  const t = Array.from(b)
  let p = 0
  while (p < 4 && p < s.length && p < t.length && s[p] === t[p]) p++
  return j + p * 0.1 * (1 - j)
}

/** Jaro-Winkler over matchKey-normalized text; 0 when either side is empty. */
export function strSim(a: string | undefined | null, b: string | undefined | null): number {
  const ka = matchKey(a)
  const kb = matchKey(b)
  if (!ka || !kb) return 0
  return jaroWinkler(ka, kb)
}

const FEAT_PAREN = /\s*[([](?:feat|ft|featuring|with)\.?\s[^)\]]*[)\]]/gi
const FEAT_TAIL = /\s+(?:feat|ft|featuring)\.?\s.+$/i

export function stripFeat(s: string): string {
  return cleanText(s.replace(FEAT_PAREN, '').replace(FEAT_TAIL, ''))
}

export function titleSim(a: string | undefined, b: string | undefined): number {
  if (!a || !b) return 0
  return Math.max(strSim(a, b), strSim(stripFeat(a), stripFeat(b)))
}

const EDITION = /\s*[([][^)\]]*\b(?:edition|version|deluxe|remaster(?:ed)?|expanded|anniversary|bonus|reissue|special)\b[^)\]]*[)\]]\s*$|\s+[-–]?\s*\b(?:deluxe|expanded|remastered)(?:\s+(?:edition|version))?\s*$/i

/** Removes a trailing edition qualifier: "X (Deluxe Edition)" → "X". */
export function stripEdition(s: string): string {
  let out = cleanText(s)
  for (let prev = ''; out !== prev; ) {
    prev = out
    out = cleanText(out.replace(EDITION, '')) || prev
  }
  return out
}

export function albumSim(a: string | undefined, b: string | undefined, disambiguation?: string): number {
  if (!a || !b) return 0
  let s = Math.max(strSim(a, b), disambiguation ? strSim(a, `${b} ${disambiguation}`) : 0)
  const sa = stripEdition(a)
  const sb = stripEdition(b)
  if (sa !== a || sb !== b) s = Math.max(s, 0.95 * strSim(sa, sb))
  return s
}

/** Similarity of two artist credits, tolerant of extra/missing collaborators. */
export function artistSim(a: string | undefined, b: string | undefined, aNames?: string[], bNames?: string[]): number {
  if (!a || !b) return 0
  const full = strSim(a, b)
  if (full >= 0.97) return full
  const na = (aNames?.length ? aNames : splitCredit(a)).map(matchKey).filter(Boolean)
  const nb = (bNames?.length ? bNames : splitCredit(b)).map(matchKey).filter(Boolean)
  if (!na.length || !nb.length) return full
  let hit = 0
  for (const x of na) if (nb.some((y) => x === y || jaroWinkler(x, y) >= 0.92)) hit++
  return Math.max(full, (0.95 * hit) / Math.min(na.length, nb.length))
}

/** 1 within ±2 s, linear to 0 at 15 s; 0.5 when either duration is unknown. */
export function durSim(aMs: number | undefined | null, bMs: number | undefined | null): number {
  if (!aMs || !bMs) return 0.5
  const d = Math.abs(aMs - bMs) / 1000
  if (d <= 2) return 1
  if (d >= 15) return 0
  return 1 - (d - 2) / 13
}

export function yearOf(date: string | undefined | null): number | undefined {
  const m = /^(\d{4})/.exec(date ?? '')
  return m ? Number(m[1]) : undefined
}

export const normBarcode = (s: string | undefined | null): string => (s ?? '').replace(/\D/g, '').replace(/^0+/, '')

export function mostCommon<T>(values: Array<T | undefined | null>, key: (v: T) => string = (v) => String(v)): T | undefined {
  const counts = new Map<string, { v: T; n: number }>()
  for (const v of values) {
    if (v === undefined || v === null || v === '') continue
    const k = key(v)
    const e = counts.get(k)
    if (e) e.n++
    else counts.set(k, { v, n: 1 })
  }
  let best: { v: T; n: number } | undefined
  for (const e of counts.values()) if (!best || e.n > best.n) best = e
  return best?.v
}

/** Maximum-weight assignment (Hungarian, O(n²m)); returns the column for each row or -1. */
export function assign(sim: number[][]): number[] {
  const n = sim.length
  const m = n ? sim[0].length : 0
  if (!n || !m) return new Array(n).fill(-1)
  if (n > m) {
    const t = Array.from({ length: m }, (_, j) => sim.map((row) => row[j]))
    const cols = assign(t)
    const out = new Array(n).fill(-1)
    cols.forEach((i, j) => { if (i >= 0) out[i] = j })
    return out
  }
  if (n * n * m > 4e7) return greedy(sim)
  const INF = Number.MAX_VALUE
  const u = new Array<number>(n + 1).fill(0)
  const v = new Array<number>(m + 1).fill(0)
  const p = new Array<number>(m + 1).fill(0)
  const way = new Array<number>(m + 1).fill(0)
  for (let i = 1; i <= n; i++) {
    p[0] = i
    let j0 = 0
    const minv = new Array<number>(m + 1).fill(INF)
    const used = new Array<boolean>(m + 1).fill(false)
    do {
      used[j0] = true
      const i0 = p[j0]
      let delta = INF
      let j1 = 0
      for (let j = 1; j <= m; j++) {
        if (used[j]) continue
        const cur = 1 - sim[i0 - 1][j - 1] - u[i0] - v[j]
        if (cur < minv[j]) { minv[j] = cur; way[j] = j0 }
        if (minv[j] < delta) { delta = minv[j]; j1 = j }
      }
      for (let j = 0; j <= m; j++) {
        if (used[j]) { u[p[j]] += delta; v[j] -= delta } else minv[j] -= delta
      }
      j0 = j1
    } while (p[j0] !== 0)
    do { const j1 = way[j0]; p[j0] = p[j1]; j0 = j1 } while (j0)
  }
  const out = new Array<number>(n).fill(-1)
  for (let j = 1; j <= m; j++) if (p[j]) out[p[j] - 1] = j - 1
  return out
}

function greedy(sim: number[][]): number[] {
  const pairs: Array<[number, number, number]> = []
  sim.forEach((row, i) => row.forEach((s, j) => pairs.push([s, i, j])))
  pairs.sort((a, b) => b[0] - a[0])
  const out = new Array<number>(sim.length).fill(-1)
  const usedCols = new Set<number>()
  for (const [, i, j] of pairs) {
    if (out[i] >= 0 || usedCols.has(j)) continue
    out[i] = j
    usedCols.add(j)
  }
  return out
}

export function luceneEscape(s: string): string {
  return s.replace(/([+\-&|!(){}[\]^"~*?:\\/])/g, '\\$1')
}

export const isEmpty = (v: unknown): boolean =>
  v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0) || (typeof v === 'number' && !Number.isFinite(v))

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, Math.max(0, ms)))
}
