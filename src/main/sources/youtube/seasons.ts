// SiIvaGunner channel seasons → one album per season for YouTube rips. A video belongs to the latest
// season that started on or before its upload date (gaps and post-finale uploads stay with the season
// before). The table lives in the synced library folder so every computer files rips the same way.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SeasonDef } from '@shared/ipc/hqrip'

/** Start dates from the SiIvaGunner wiki, checked against each season's first upload. */
export const DEFAULT_SEASONS: SeasonDef[] = [
  { key: 's1', name: 'Season 1', start: '2016-01-09' },
  { key: 's2', name: 'Season 2', start: '2016-10-19' },
  { key: 's3', name: 'Season 3', start: '2018-01-01' },
  { key: 's4', name: 'Season 4', start: '2019-03-26' },
  { key: 's4e2', name: 'Season 4 Episode 2', start: '2020-02-01' },
  { key: 's5', name: 'Season 5', start: '2021-01-04' },
  { key: 's6', name: 'Season 6', start: '2022-01-31' },
  { key: 's7', name: 'Season 7: The Year of Grand Dad', start: '2023-02-01' },
  { key: 's8', name: 'Season 8', start: '2024-01-18' },
  { key: 's9', name: 'Season 9', start: '2025-01-24' },
  { key: 'sx', name: 'Season X', start: '2026-01-07' },
]

/** Album title of a season: "SiIvaGunner: Season 7 – The Year of Grand Dad". */
export function seasonAlbum(s: Pick<SeasonDef, 'name'>): string {
  return `SiIvaGunner: ${s.name.replace(/\s*:\s*/, ' – ')}`
}

/** The season of an upload time (ISO); uploads before Season 1 go to the first season. */
export function seasonFor(uploaded: string, seasons: readonly SeasonDef[]): SeasonDef {
  const day = uploaded.slice(0, 10)
  const sorted = [...seasons].sort((a, b) => a.start.localeCompare(b.start))
  let hit = sorted[0]
  for (const s of sorted) if (s.start <= day) hit = s
  return hit
}

/** Checks and normalizes an edited season table (unique keys and names, valid dates, sorted by start). */
export function validateSeasons(input: unknown): SeasonDef[] {
  if (!Array.isArray(input) || !input.length) throw new Error('The season list is empty')
  const out: SeasonDef[] = []
  const keys = new Set<string>()
  const names = new Set<string>()
  for (const raw of input) {
    const s = raw as Partial<SeasonDef>
    const name = String(s.name ?? '').trim()
    const start = String(s.start ?? '').trim()
    const key = String(s.key ?? '').trim() || `s-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`
    if (!name) throw new Error('Every season needs a name')
    if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || Number.isNaN(Date.parse(start))) throw new Error(`“${name}” needs a start date like 2026-01-07`)
    if (keys.has(key)) throw new Error(`Two seasons share the key “${key}”`)
    if (names.has(name.toLowerCase())) throw new Error(`Two seasons are both called “${name}”`)
    keys.add(key)
    names.add(name.toLowerCase())
    out.push({ key, name, start })
  }
  return out.sort((a, b) => a.start.localeCompare(b.start))
}

export class SeasonStore {
  constructor(private libraryRoot: string) {}

  get dir(): string {
    return join(this.libraryRoot, '.valence', 'rips')
  }

  private get file(): string {
    return join(this.dir, 'seasons.json')
  }

  coverFile(key: string): string {
    return join(this.dir, 'covers', `${key.replace(/[^a-z0-9_-]/gi, '_')}.jpg`)
  }

  list(): SeasonDef[] {
    try {
      return validateSeasons(JSON.parse(readFileSync(this.file, 'utf8')).seasons)
    } catch {
      return DEFAULT_SEASONS.map((s) => ({ ...s }))
    }
  }

  save(seasons: SeasonDef[]): SeasonDef[] {
    const clean = validateSeasons(seasons)
    mkdirSync(this.dir, { recursive: true })
    const tmp = `${this.file}.valence-tmp`
    writeFileSync(tmp, JSON.stringify({ seasons: clean }, null, 1))
    renameSync(tmp, this.file)
    return clean
  }

  hasCover(key: string): boolean {
    return existsSync(this.coverFile(key))
  }
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)

/** Placeholder season cover (SVG; rendered to JPEG by the caller): big season number, name, channel. */
export function placeholderSvg(s: SeasonDef, index: number): string {
  const hue = (index * 37 + 250) % 360
  const m = /season\s+(x|\d+)(?:\s+episode\s+(\d+))?/i.exec(s.name)
  const big = m ? m[1].toUpperCase() + (m[2] ? `·${m[2]}` : '') : s.name.slice(0, 3).toUpperCase()
  const sub = s.name.includes(':') ? s.name.slice(s.name.indexOf(':') + 1).trim() : m?.[2] ? `Episode ${m[2]}` : ''
  return `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="600" viewBox="0 0 600 600">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="hsl(${hue},62%,46%)"/><stop offset="1" stop-color="hsl(${(hue + 40) % 360},70%,22%)"/>
  </linearGradient></defs>
  <rect width="600" height="600" fill="url(#g)"/>
  <rect x="28" y="28" width="544" height="544" rx="20" fill="none" stroke="rgba(255,255,255,0.35)" stroke-width="3"/>
  <text x="300" y="150" text-anchor="middle" font-family="Segoe UI, Helvetica, Arial, sans-serif" font-size="40" font-weight="700" letter-spacing="10" fill="rgba(255,255,255,0.85)">SEASON</text>
  <text x="300" y="380" text-anchor="middle" font-family="Segoe UI, Helvetica, Arial, sans-serif" font-size="${big.length > 3 ? 150 : 230}" font-weight="800" fill="#fff">${esc(big)}</text>
  ${sub ? `<text x="300" y="460" text-anchor="middle" font-family="Segoe UI, Helvetica, Arial, sans-serif" font-size="30" font-weight="600" fill="rgba(255,255,255,0.9)">${esc(sub.slice(0, 32))}</text>` : ''}
  <text x="300" y="540" text-anchor="middle" font-family="Segoe UI, Helvetica, Arial, sans-serif" font-size="26" font-weight="600" letter-spacing="4" fill="rgba(255,255,255,0.7)">SiIvaGunner</text>
</svg>`
}
