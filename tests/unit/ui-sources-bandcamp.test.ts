import { describe, expect, it } from 'vitest'
import type { BandcampItemSummary } from '@shared/ipc/bandcamp'
import {
  bcArtAt,
  collectionCounts,
  filterItems,
  missingToDownload,
  releaseKeyOf,
  sortItems,
  unavailableReason,
} from '../../src/renderer/views/bandcamp/helpers'

let n = 0
const item = (p: Partial<BandcampItemSummary>): BandcampItemSummary => ({
  key: `a${++n}`,
  itemType: 'album',
  tralbumType: 'album',
  tralbumId: n,
  title: `Title ${n}`,
  artist: 'Artist',
  itemUrl: null,
  artUrl: null,
  hidden: false,
  preorder: false,
  physicalOnly: false,
  downloadable: true,
  badge: { status: 'missing', have: 0, total: 10 },
  ...p,
})

describe('bandcamp collection helpers', () => {
  const a = item({ title: 'Zebra', artist: 'The Beta', purchased: '2024-01-02T00:00:00Z', badge: { status: 'in-library', have: 3, total: 3 } })
  const b = item({ title: 'Ápple', artist: 'Alpha', purchased: '2025-05-01T00:00:00Z', hidden: true })
  const c = item({ title: 'Mango', artist: 'Gamma', preorder: true, downloadable: false })
  const d = item({ title: 'Kiwi', artist: 'Delta', itemType: 'package', physicalOnly: true, downloadable: false, badge: { status: 'partial', have: 1, total: 4 } })
  const all = [a, b, c, d]

  it('explains non-downloadable items', () => {
    expect(unavailableReason(a)).toBeNull()
    expect(unavailableReason(c)?.label).toBe('Pre-order')
    expect(unavailableReason(d)?.label).toBe('Physical only')
    expect(unavailableReason(item({ itemType: 'package', downloadable: false }))?.label).toBe('Package')
    expect(unavailableReason(item({ downloadable: false }))?.label).toBe('No download')
  })

  it('filters by accent-insensitive text, scope and hidden', () => {
    expect(filterItems(all, { text: 'apple', scope: 'all', showHidden: true })).toEqual([b])
    expect(filterItems(all, { text: 'apple', scope: 'all', showHidden: false })).toEqual([])
    expect(filterItems(all, { text: '', scope: 'in-library', showHidden: true })).toEqual([a])
    expect(filterItems(all, { text: '', scope: 'missing', showHidden: true })).toEqual([b, c, d])
    expect(filterItems(all, { text: 'beta zeb', scope: 'all', showHidden: true })).toEqual([a])
  })

  it('sorts by purchase date (newest first, undated last), artist (ignoring "The") and title', () => {
    expect(sortItems(all, 'purchased').map((x) => x.title)).toEqual(['Ápple', 'Zebra', 'Mango', 'Kiwi'])
    expect(sortItems(all, 'artist').map((x) => x.artist)).toEqual(['Alpha', 'The Beta', 'Delta', 'Gamma'])
    expect(sortItems(all, 'title').map((x) => x.title)).toEqual(['Ápple', 'Kiwi', 'Mango', 'Zebra'])
  })

  it('counts', () => {
    expect(collectionCounts(all)).toEqual({ total: 4, inLibrary: 1, partial: 1, missing: 2, unavailable: 2, hidden: 1 })
  })

  it('selects what "download all missing" will queue', () => {
    const dup = item({ tralbumId: b.tralbumId, key: 'p1', itemType: 'package' })
    const e = item({ title: 'Queued one' })
    const picked = missingToDownload([a, b, c, d, dup, e], (k) => k === releaseKeyOf(e))
    expect(picked).toEqual([b])
  })

  it('resizes art urls', () => {
    expect(bcArtAt('https://f4.bcbits.com/img/a123_2.jpg', 16)).toBe('https://f4.bcbits.com/img/a123_16.jpg')
    expect(bcArtAt(null, 16)).toBeNull()
  })
})
