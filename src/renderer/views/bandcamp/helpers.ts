// Pure helpers for the Bandcamp collection view (filter, sort, counts, download eligibility).
// No React / window access: unit-tested in tests/unit.

import type { BandcampItemSummary } from '@shared/ipc/bandcamp'

export type BcSort = 'purchased' | 'artist' | 'title'
export type BcScope = 'all' | 'missing' | 'in-library'

export interface BcFilter {
  text: string
  scope: BcScope
  showHidden: boolean
}

export const releaseKeyOf = (i: Pick<BandcampItemSummary, 'tralbumType' | 'tralbumId'>): string => `bc:${i.tralbumType}:${i.tralbumId}`

export interface Unavailable {
  label: string
  detail: string
}

/** Why a purchase can't be downloaded (null when it can). */
export function unavailableReason(i: Pick<BandcampItemSummary, 'downloadable' | 'preorder' | 'physicalOnly' | 'itemType'>): Unavailable | null {
  if (i.preorder) return { label: 'Pre-order', detail: 'Pre-orders become downloadable once the release is out.' }
  if (i.physicalOnly) return { label: 'Physical only', detail: 'This purchase is a physical item without a digital download.' }
  if (i.downloadable) return null
  if (i.itemType === 'package') return { label: 'Package', detail: 'This package does not include a digital download.' }
  return { label: 'No download', detail: 'Bandcamp did not provide a download link for this purchase.' }
}

/** Lowercase, accent-free text for matching. */
export function fold(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
}

export function filterItems(items: readonly BandcampItemSummary[], f: BcFilter): BandcampItemSummary[] {
  const words = fold(f.text).split(/\s+/).filter(Boolean)
  return items.filter((i) => {
    if (!f.showHidden && i.hidden) return false
    if (f.scope === 'in-library' && i.badge.status !== 'in-library') return false
    if (f.scope === 'missing' && i.badge.status === 'in-library') return false
    if (!words.length) return true
    const hay = fold(`${i.title} ${i.artist}`)
    return words.every((w) => hay.includes(w))
  })
}

const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true })
const sortName = (s: string) => s.replace(/^the\s+/i, '')

export function sortItems(items: readonly BandcampItemSummary[], sort: BcSort): BandcampItemSummary[] {
  const out = items.slice()
  if (sort === 'purchased') {
    // Newest first; undated purchases last, keeping their original (collection) order.
    const t = (i: BandcampItemSummary) => (i.purchased ? Date.parse(i.purchased) || 0 : 0)
    return out
      .map((i, n) => ({ i, n, t: t(i) }))
      .sort((a, b) => b.t - a.t || a.n - b.n)
      .map((x) => x.i)
  }
  if (sort === 'artist') return out.sort((a, b) => collator.compare(sortName(a.artist), sortName(b.artist)) || collator.compare(a.title, b.title))
  return out.sort((a, b) => collator.compare(a.title, b.title) || collator.compare(sortName(a.artist), sortName(b.artist)))
}

export interface BcCounts {
  total: number
  inLibrary: number
  partial: number
  missing: number
  unavailable: number
  hidden: number
}

export function collectionCounts(items: readonly BandcampItemSummary[]): BcCounts {
  const c: BcCounts = { total: items.length, inLibrary: 0, partial: 0, missing: 0, unavailable: 0, hidden: 0 }
  for (const i of items) {
    if (i.hidden) c.hidden++
    if (i.badge.status === 'in-library') c.inLibrary++
    else if (i.badge.status === 'partial') c.partial++
    else c.missing++
    if (unavailableReason(i)) c.unavailable++
  }
  return c
}

/**
 * What "Download all missing" will enqueue (mirrors main's downloadAllMissing): downloadable purchases
 * not fully in the library and not already queued, one per release.
 */
export function missingToDownload(items: readonly BandcampItemSummary[], isActive: (releaseKey: string) => boolean = () => false): BandcampItemSummary[] {
  const seen = new Set<string>()
  const out: BandcampItemSummary[] = []
  for (const i of items) {
    if (!i.downloadable || i.badge.status === 'in-library') continue
    const k = releaseKeyOf(i)
    if (seen.has(k) || isActive(k)) continue
    seen.add(k)
    out.push(i)
  }
  return out
}

/** Bandcamp art URL at another size (`…/a123_2.jpg` → `…/a123_16.jpg`; 16 = 700px, 10 = 1200px). */
export function bcArtAt(url: string | null | undefined, size: number): string | null {
  if (!url) return null
  return url.replace(/(\/a?\d+)_\d+\.(jpg|png)$/i, `$1_${size}.$2`)
}

export function purchasedLabel(iso: string | undefined): string | null {
  if (!iso) return null
  const t = Date.parse(iso)
  if (!t) return null
  return new Date(t).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}
