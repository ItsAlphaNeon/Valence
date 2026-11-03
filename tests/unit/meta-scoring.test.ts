import { describe, expect, it } from 'vitest'
import { buildQuery, classify, scoreRelease, trackSim, THRESHOLDS, type Query } from '@main/metadata/scoring'
import { singletonTier, identifyRelease, type IdentifyDeps, type IdentifyInput } from '@main/metadata/identify'
import { albumTagsFromRelease, coverArtUrls, flattenRelease, formatSummary, releaseTypeLabel, trackTagsFromRelease } from '@main/metadata/mapping'
import { assign, albumSim, artistSim, stripEdition } from '@main/metadata/util'
import { VA_ID, type MbArtistCredit, type MbClient, type MbRecording, type MbRelease } from '@main/metadata/musicbrainz'
import type { TrackTags } from '@shared/types'

let seq = 0
const uid = (p = '0') => `${p.repeat(8)}-0000-4000-8000-${String(++seq).padStart(12, '0')}`
const credit = (name: string, id = uid('a')): MbArtistCredit[] => [{ name, artist: { id, name, 'sort-name': name.split(' ').reverse().join(', ') } }]
const ARTIST = credit('Neon Coast', 'aaaaaaaa-0000-4000-8000-000000000001')
const VA = [{ name: 'Various Artists', artist: { id: VA_ID, name: 'Various Artists', 'sort-name': 'Various Artists' } }]

const BASE: Array<[string, number]> = [
  ['Night Drive', 215], ['Glass Hours', 187], ['Tidewater', 243], ['Static Bloom', 201], ['Low Orbit', 230],
  ['Paper Lanterns', 176], ['Afterglow Avenue', 262], ['Second Sun', 198], ['Quiet Machines', 254], ['Harbor Lights', 309],
]
const BONUS: Array<[string, number]> = [['Night Drive (Acoustic)', 221], ['Tidewater (Remix)', 288], ['Glass Hours (Demo)', 180], ['Unreleased Coda', 145]]
const recIds = new Map<string, string>()
const recId = (title: string) => recIds.get(title) ?? (recIds.set(title, uid('c')), recIds.get(title)!)

interface RelOpts {
  title?: string
  discs: Array<Array<[string, number]>>
  ac?: MbArtistCredit[]
  trackArtist?: (title: string) => MbArtistCredit[]
  status?: string
  date?: string
  country?: string
  format?: string
  type?: string
  secondary?: string[]
  barcode?: string
  disambiguation?: string
  rg?: string
}

function rel(o: RelOpts): MbRelease {
  const ac = o.ac ?? ARTIST
  return {
    id: uid('b'),
    title: o.title ?? 'Night Drive',
    status: o.status ?? 'Official',
    date: o.date ?? '2020-03-06',
    country: o.country ?? 'XW',
    barcode: o.barcode,
    disambiguation: o.disambiguation,
    'artist-credit': ac,
    'release-group': { id: o.rg ?? 'dddddddd-0000-4000-8000-000000000001', 'primary-type': o.type ?? 'Album', 'secondary-types': o.secondary ?? [], 'first-release-date': '2020-03-06', genres: [{ name: 'synthwave', count: 4 }, { name: 'electronic', count: 2 }, { name: 'retro', count: 9 }] },
    'label-info': [{ 'catalog-number': 'NC001', label: { name: 'Coastline Records' } }],
    media: o.discs.map((tracks, d) => ({
      position: d + 1,
      format: o.format ?? 'Digital Media',
      'track-count': tracks.length,
      tracks: tracks.map(([title, sec], i) => ({
        id: uid('e'),
        position: i + 1,
        number: String(i + 1),
        title,
        length: sec * 1000,
        'artist-credit': o.trackArtist?.(title) ?? ac,
        recording: { id: recId(title), title, length: sec * 1000, isrcs: [`QZ${title.replace(/\W/g, '').slice(0, 3).toUpperCase()}2000001`] },
      })),
    })),
  }
}

const input = (rows: Array<[string, number]>, albumTags: TrackTags, jitter = 900, artist = 'Neon Coast'): IdentifyInput => ({
  source: 'import',
  albumTags,
  tracks: rows.map(([title, sec], i) => ({ index: i, durationMs: sec * 1000 + jitter, tags: { title, artist, tracknumber: i + 1 } })),
})

const best = (q: Query, rs: MbRelease[]) => rs.map((r) => scoreRelease(q, r)).sort((a, b) => b.S - a.S)

describe('release scoring', () => {
  const standard = rel({ discs: [BASE] })
  const deluxe = rel({ title: 'Night Drive (Deluxe Edition)', discs: [[...BASE, ...BONUS]], date: '2021-05-01' })
  const japan = rel({ discs: [[...BASE, ['Kyoto Rain', 201]]], country: 'JP', format: 'CD', date: '2020-04-01' })
  const vinyl = rel({ discs: [BASE.slice(0, 5), BASE.slice(5)], format: '12" Vinyl', country: 'GB', date: '2020-06-01' })
  const bootleg = rel({ discs: [BASE], status: 'Bootleg', country: 'RU', format: 'CD-R' })

  it('picks the standard edition among many editions of the same album', () => {
    const q = buildQuery(input(BASE, { album: 'Night Drive', albumartist: 'Neon Coast', date: '2020' }))
    const [top, second] = best(q, [deluxe, japan, vinyl, bootleg, standard])
    expect(top.release).toBe(standard)
    expect(top.S).toBeGreaterThan(second.S)
    expect(top.parts.count).toBe(1)
    expect(top.assignment.map((a) => a?.j)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
    expect(classify(top)).toBe('auto')
  })

  it('picks the deluxe edition for a deluxe track list', () => {
    const q = buildQuery(input([...BASE, ...BONUS], { album: 'Night Drive (Deluxe)', albumartist: 'Neon Coast' }))
    const [top] = best(q, [standard, japan, deluxe, vinyl])
    expect(top.release).toBe(deluxe)
    expect(classify(top)).toBe('auto')
    // bonus versions are matched to the right recordings, not to their originals
    expect(top.flat[top.assignment[10]!.j].title).toBe('Night Drive (Acoustic)')
    expect(top.flat[top.assignment[0]!.j].title).toBe('Night Drive')
  })

  it('honours the media and country tags when editions are otherwise identical', () => {
    const q = buildQuery(input(BASE, { album: 'Night Drive', albumartist: 'Neon Coast', media: '12" Vinyl', releasecountry: 'GB' }))
    const vinylFlat = rel({ discs: [BASE], format: '12" Vinyl', country: 'GB' })
    expect(best(q, [standard, vinylFlat])[0].release).toBe(vinylFlat)
  })

  it('a partial album still prefers the edition it belongs to, with a lower count score', () => {
    const q = buildQuery(input(BASE.slice(0, 7), { album: 'Night Drive', albumartist: 'Neon Coast' }))
    const [top] = best(q, [deluxe, standard])
    expect(top.release).toBe(standard)
    expect(top.parts.count).toBe(0.7)
    const withTotal = scoreRelease(buildQuery(input(BASE.slice(0, 7), { album: 'Night Drive', albumartist: 'Neon Coast', totaltracks: 10 })), standard)
    expect(withTotal.parts.count).toBe(1)
  })

  it('penalises a track-count mismatch and refuses auto on a wrong track list', () => {
    const q = buildQuery(input(BASE, { album: 'Night Drive', albumartist: 'Neon Coast' }))
    const short = rel({ discs: [BASE.slice(0, 6)] })
    const s = scoreRelease(q, short)
    expect(s.parts.count).toBe(0.3)
    expect(s.assignment.filter(Boolean)).toHaveLength(6)
    expect(classify(s)).not.toBe('auto')
    const other = rel({ title: 'Night Drive', discs: [[['Alpha', 100], ['Beta', 400], ['Gamma', 90], ['Delta', 500], ['Epsilon', 60], ['Zeta', 300], ['Eta', 120], ['Theta', 330], ['Iota', 80], ['Kappa', 420]]] })
    const so = scoreRelease(q, other)
    expect(so.sTracks).toBeLessThan(THRESHOLDS.autoTracks)
    expect(classify(so)).not.toBe('auto')
  })

  it('refuses auto when one track is more than 7 s off', () => {
    const rows: Array<[string, number]> = BASE.map(([t, d], i) => [t, i === 3 ? d + 12 : d])
    const s = scoreRelease(buildQuery(input(rows, { album: 'Night Drive', albumartist: 'Neon Coast' }, 0)), standard)
    expect(s.maxDeltaMs).toBe(12_000)
    expect(s.S).toBeGreaterThan(THRESHOLDS.auto)
    expect(classify(s)).toBe('review')
  })

  it('album beats a VA compilation carrying the same recordings, unless tags say compilation', () => {
    const comp = rel({ title: 'Synthwave Summer 2020', ac: VA, trackArtist: () => ARTIST, discs: [BASE], type: 'Album', secondary: ['Compilation'], rg: 'dddddddd-0000-4000-8000-000000000002' })
    const q = buildQuery(input(BASE, { album: 'Night Drive', albumartist: 'Neon Coast' }))
    expect(best(q, [comp, standard])[0].release).toBe(standard)
    const qc = buildQuery(input(BASE, { album: 'Synthwave Summer 2020', albumartist: 'Various Artists' }))
    expect(qc.compilation).toBe(true)
    const [top] = best(qc, [standard, comp])
    expect(top.release).toBe(comp)
    expect(top.parts.albumartist).toBe(1)
  })

  it('matches disc/track positions on multi-disc releases', () => {
    const rows = input(BASE, { album: 'Night Drive', albumartist: 'Neon Coast' })
    rows.tracks.forEach((t, i) => { t.tags.discnumber = i < 5 ? 1 : 2; t.tags.tracknumber = (i % 5) + 1 })
    const s = scoreRelease(buildQuery(rows), vinyl)
    expect(s.assignment.map((a) => s.flat[a!.j].disc)).toEqual([1, 1, 1, 1, 1, 2, 2, 2, 2, 2])
    expect(s.flat.map((f) => f.abs)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
  })

  it('ISRC or recording id lifts track similarity to at least 0.95', () => {
    const ft = flattenRelease(standard)[2]
    const t = { index: 0, durationMs: 100_000, tags: { title: 'Completely Different', isrc: ft.isrcs[0].toLowerCase() } }
    expect(trackSim(t, ft)).toBeGreaterThanOrEqual(0.95)
    expect(trackSim({ ...t, tags: { title: 'Completely Different' } }, ft)).toBeLessThan(0.5)
  })

  it('classify thresholds', () => {
    const ok = { S: 0.82, sTracks: 0.75, goodFrac: 0.8, maxDeltaMs: 7000 }
    expect(classify(ok)).toBe('auto')
    expect(classify({ ...ok, S: 0.819 })).toBe('review')
    expect(classify({ ...ok, sTracks: 0.74 })).toBe('review')
    expect(classify({ ...ok, goodFrac: 0.79 })).toBe('review')
    expect(classify({ ...ok, maxDeltaMs: 7001 })).toBe('review')
    expect(classify({ ...ok, S: 0.6 })).toBe('review')
    expect(classify({ ...ok, S: 0.599 })).toBe('unmatched')
  })
})

describe('singleton release choice', () => {
  const album = rel({ discs: [BASE] })
  const single = rel({ title: 'Glass Hours', discs: [[BASE[1]]], type: 'Single', date: '2019-11-01' })
  const comp = rel({ title: 'Synthwave Summer 2020', ac: VA, discs: [[BASE[3], BASE[1]]], secondary: ['Compilation'], date: '2019-12-01' })
  const live = rel({ title: 'Night Drive Live', discs: [BASE], secondary: ['Live'], date: '2019-10-01' })
  const promo = rel({ discs: [[BASE[1]]], type: 'Single', status: 'Promotion', date: '2019-09-01' })
  const q = (tags: TrackTags) => buildQuery({ source: 'import', albumTags: {}, tracks: [{ index: 0, durationMs: 187_000, tags: { title: 'Glass Hours', artist: 'Neon Coast', ...tags } }] })
  const order = (qq: Query) => [comp, live, promo, single, album].map((r) => ({ r, t: singletonTier(r, qq, { id: recId('Glass Hours') }) })).sort((a, b) => a.t - b.t).map((x) => x.r.title + (x.r.status === 'Promotion' ? ' (promo)' : ''))

  it('prefers the official album over singles, live, promo and compilations', () => {
    expect(order(q({}))).toEqual(['Night Drive', 'Glass Hours', 'Night Drive Live', 'Night Drive (promo)', 'Synthwave Summer 2020'])
  })
  it('uses the tagged album first, including a compilation the tags name', () => {
    expect(order(q({ album: 'Glass Hours' }))[0]).toBe('Glass Hours')
    expect(order(q({ album: 'Synthwave Summer 2020', albumartist: 'Various Artists' }))[0]).toBe('Synthwave Summer 2020')
  })
  it('for tidal/bandcamp sources the tagged album must also match by position', () => {
    const qq = buildQuery({ source: 'tidal', albumTags: {}, tracks: [{ index: 0, durationMs: 187_000, tags: { title: 'Glass Hours', artist: 'Neon Coast', album: 'Night Drive', tracknumber: 7 } }] })
    const rec = { id: recId('Glass Hours'), origin: 'text' }
    expect(singletonTier(album, qq, rec)).toBeGreaterThan(0)
    expect(singletonTier(album, { ...qq, tracks: [{ ...qq.tracks[0], tags: { ...qq.tracks[0].tags, tracknumber: 2 } }] }, rec)).toBe(0)
    expect(singletonTier(album, qq, { ...rec, origin: 'isrc' })).toBe(0)
  })
})

describe('identify flow with a fake MusicBrainz client', () => {
  const album = rel({ discs: [BASE] })
  const single = rel({ title: 'Glass Hours', discs: [[BASE[1]]], type: 'Single', date: '2019-11-01' })
  const releases = new Map([album, single].map((r) => [r.id, r]))
  const summary = (r: MbRelease): MbRelease => ({ ...r, media: r.media?.map((m) => ({ ...m, tracks: undefined, track: m.tracks })), score: 100 })
  const calls: string[] = []
  const mb = {
    release: async (id: string) => (calls.push(`release ${id}`), releases.get(id) ?? null),
    recording: async () => null,
    releasesByBarcode: async () => [],
    recordingsByIsrc: async () => [],
    searchReleases: async (a: string) => (calls.push(`search ${a}`), albumSim(a, 'Night Drive') > 0.9 ? [summary(album)] : []),
    searchRecordings: async (t: string): Promise<MbRecording[]> => (calls.push(`rec ${t}`), [{ id: recId('Glass Hours'), title: 'Glass Hours', length: 187_000, score: 100, 'artist-credit': ARTIST, releases: [summary(single), summary(album)] }]),
  } as unknown as MbClient
  const deps: IdentifyDeps = { mb, acoustid: null, fingerprint: async () => null }

  it('album: auto with mapped album and track tags in input order', async () => {
    const inp = input(BASE, { album: 'Night Drive', albumartist: 'Neon Coast' })
    inp.tracks.reverse()
    const res = await identifyRelease(deps, inp)
    expect(res.status).toBe('auto')
    expect(res.albumTags).toMatchObject({ album: 'Night Drive', albumartist: 'Neon Coast', genre: 'Synthwave', releasetype: 'album', label: 'Coastline Records', catalognumber: 'NC001', totaldiscs: 1 })
    expect(res.trackTags[0]).toMatchObject({ title: 'Night Drive', tracknumber: 1, totaltracks: 10 })
    expect(res.trackTags[9]).toMatchObject({ title: 'Harbor Lights', tracknumber: 10 })
    expect(res.coverArtUrls).toHaveLength(2)
  })

  it('singleton: picks the album over the earlier single', async () => {
    const res = await identifyRelease(deps, { source: 'import', albumTags: {}, tracks: [{ index: 0, durationMs: 188_000, tags: { title: 'Glass Hours', artist: 'Neon Coast' } }] })
    expect(res.status).toBe('auto')
    expect(res.release?.releaseId).toBe(album.id)
    expect(res.trackTags[0]).toMatchObject({ title: 'Glass Hours', tracknumber: 2, totaltracks: 10 })
  })

  it('unmatched with no candidates; review keeps proposed tags', async () => {
    const none = await identifyRelease(deps, input([['Nope', 100], ['Nada', 120]], { album: 'Unknown Thing', albumartist: 'Nobody' }))
    expect(none).toMatchObject({ status: 'unmatched', trackTags: [null, null], albumTags: {} })
    const wrongDur = input(BASE.slice(0, 6), { album: 'Night Drive', albumartist: 'Neon Coast' }, 9000)
    const rv = await identifyRelease(deps, wrongDur)
    expect(rv.status).toBe('review')
    expect(rv.albumTags.album).toBe('Night Drive')
    expect(rv.trackTags.every(Boolean)).toBe(true)
  })
})

describe('mapping', () => {
  it('maps a VA compilation and multi-disc formats', () => {
    const r = rel({ title: 'Synthwave Summer 2020', ac: VA, trackArtist: (t) => credit(t === 'Night Drive' ? 'Neon Coast' : 'Other Artist'), discs: [BASE.slice(0, 3), BASE.slice(3, 5)], format: 'CD', secondary: ['Compilation'] })
    const tags = albumTagsFromRelease(r)
    expect(tags).toMatchObject({ compilation: true, albumartist: 'Various Artists', releasetype: 'album; compilation', releasestatus: 'official', media: 'CD', totaldiscs: 2, genre: 'Synthwave', originaldate: '2020-03-06' })
    expect(tags.musicbrainz_albumartistid).toEqual([VA_ID])
    expect(formatSummary(r)).toBe('2×CD')
    expect(releaseTypeLabel(r)).toBe('Album + Compilation')
    const ft = flattenRelease(r)
    expect(ft.map((f) => `${f.disc}.${f.position}/${f.mediumCount}`)).toEqual(['1.1/3', '1.2/3', '1.3/3', '2.1/2', '2.2/2'])
    expect(trackTagsFromRelease(ft[0], undefined, tags.media)).toMatchObject({ title: 'Night Drive', artist: 'Neon Coast', discnumber: 1, tracknumber: 1, totaltracks: 3 })
    expect(trackTagsFromRelease(ft[1]).artist).toBe('Other Artist')
  })

  it('keeps the input ISRC when the recording has several', () => {
    const r = rel({ discs: [BASE.slice(0, 1)] })
    r.media![0].tracks![0].recording!.isrcs = ['AAA000000001', 'BBB000000002']
    const ft = flattenRelease(r)[0]
    expect(trackTagsFromRelease(ft, 'bbb000000002').isrc).toBe('BBB000000002')
    expect(trackTagsFromRelease(ft, 'ZZZ').isrc).toBe('AAA000000001')
  })

  it('cover art: release front then release-group front; skips a release without front', () => {
    const r = rel({ discs: [BASE] })
    expect(coverArtUrls(r)).toEqual([`https://coverartarchive.org/release/${r.id}/front`, 'https://coverartarchive.org/release-group/dddddddd-0000-4000-8000-000000000001/front'])
    expect(coverArtUrls({ ...r, 'cover-art-archive': { front: false } })).toHaveLength(1)
  })
})

describe('similarity helpers', () => {
  it('Hungarian assignment beats greedy', () => {
    expect(assign([[0.9, 0.8], [0.85, 0.1]])).toEqual([1, 0])
    expect(assign([[0.2, 0.9, 0.1]])).toEqual([1])
    expect(assign([[0.9], [0.8]])).toEqual([0, -1])
    expect(assign([])).toEqual([])
  })
  it('album and artist similarity', () => {
    expect(albumSim('Night Drive (Deluxe Edition)', 'Night Drive')).toBeGreaterThan(0.9)
    expect(albumSim('Night Drive', 'Night Drive', 'deluxe')).toBe(1)
    expect(stripEdition('Hybrid Theory (Bonus Track Version) [Remastered 2020]')).toBe('Hybrid Theory')
    expect(artistSim('Hayve; Protostar', 'Hayve & Protostar', undefined, ['Hayve', 'Protostar'])).toBeGreaterThan(0.9)
    expect(artistSim('Daft Punk', 'Justice')).toBeLessThan(0.7)
  })
})
