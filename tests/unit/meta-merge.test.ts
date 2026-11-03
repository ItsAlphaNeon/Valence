import { describe, expect, it } from 'vitest'
import { mergeTags, pickGenre } from '@main/metadata'
import { genreTitleCase, isKnownGenre } from '@main/metadata/genre'
import type { TrackTags } from '@shared/types'

const mb: TrackTags = {
  title: 'Get Your Wish',
  artist: 'Porter Robinson',
  artists: ['Porter Robinson'],
  artistsort: 'Robinson, Porter',
  album: 'Nurture',
  albumartist: 'Porter Robinson',
  tracknumber: 2,
  totaltracks: 14,
  date: '2021-04-23',
  originaldate: '2021-04-23',
  isrc: 'USUG12000123',
  label: 'Mom + Pop',
  catalognumber: 'MP123',
  genre: 'Electropop',
  musicbrainz_albumid: 'rel-1',
  musicbrainz_recordingid: 'rec-1',
  musicbrainz_artistid: ['art-1'],
  releasetype: 'album',
  releasestatus: 'official',
  releasecountry: 'XW',
}

describe('mergeTags source-first', () => {
  const source: TrackTags = {
    title: 'Get Your Wish (Explicit)',
    artist: 'Porter Robinson',
    album: 'Nurture (Deluxe)',
    albumartist: 'Porter Robinson',
    tracknumber: 3,
    totaltracks: 15,
    date: '2021-04-22',
    isrc: 'USUG12000999',
    copyright: '℗ 2021 Mom + Pop',
    explicit: true,
    label: 'TIDAL Label',
    genre: 'Pop',
  }

  it('source wins identity fields; MB provides ids, type/status/country, originaldate and genre', () => {
    const { tags, provenance } = mergeTags({ source, mb }, 'source-first', true)
    expect(tags).toMatchObject({
      title: 'Get Your Wish (Explicit)', album: 'Nurture (Deluxe)', tracknumber: 3, totaltracks: 15, date: '2021-04-22', isrc: 'USUG12000999',
      copyright: '℗ 2021 Mom + Pop', explicit: true, label: 'TIDAL Label', catalognumber: 'MP123',
      musicbrainz_albumid: 'rel-1', releasetype: 'album', releasecountry: 'XW', originaldate: '2021-04-23', genre: 'Electropop',
    })
    expect(provenance).toMatchObject({ title: 'source', label: 'source', catalognumber: 'mb', genre: 'mb', musicbrainz_albumid: 'mb' })
  })

  it('user always wins', () => {
    const { tags, provenance } = mergeTags({ user: { title: 'Mine', genre: 'House' }, source, mb }, 'source-first', true)
    expect(tags.title).toBe('Mine')
    expect(tags.genre).toBe('House')
    expect(provenance.title).toBe('user')
  })

  it('keeps artist groups consistent', () => {
    const src: TrackTags = { artist: 'Porter Robinson & Madeon', title: 'Shelter' }
    const { tags, provenance } = mergeTags({ source: src, mb }, 'source-first', true)
    expect(tags.artist).toBe('Porter Robinson & Madeon')
    expect(tags.artists).toBeUndefined()
    expect(tags.artistsort).toBeUndefined()
    expect(provenance.artist).toBe('source')
    const same = mergeTags({ source: { artist: 'Porter Robinson' }, mb }, 'source-first', true)
    expect(same.tags.artistsort).toBe('Robinson, Porter')
    expect(same.provenance.artistsort).toBe('mb')
  })
})

describe('mergeTags musicbrainz-first', () => {
  const existing: TrackTags = { title: 'get your wish', artist: 'Porter Robinson', album: 'Porter Robinson - Singles', tracknumber: 1, genre: 'Electropop, Synth-Pop', comment: 'ripped', lyrics: 'la la' }
  const heuristic: TrackTags = { title: 'Get Your Wish', discnumber: 1, bpm: 120 }

  it('confident MB overrides identity fields, keeps non-identity existing fields', () => {
    const { tags, provenance } = mergeTags({ existing, heuristic, mb }, 'musicbrainz-first', true)
    expect(tags).toMatchObject({ title: 'Get Your Wish', album: 'Nurture', tracknumber: 2, comment: 'ripped', lyrics: 'la la', discnumber: 1, bpm: 120, genre: 'Electropop' })
    expect(provenance).toMatchObject({ title: 'mb', album: 'mb', comment: 'existing', discnumber: 'heuristic', lyrics: 'existing' })
  })

  it('unconfident MB only fills empty fields; existing beats MB, heuristics come last', () => {
    const { tags, provenance } = mergeTags({ existing, heuristic, mb }, 'musicbrainz-first', false)
    expect(tags).toMatchObject({ title: 'get your wish', album: 'Porter Robinson - Singles', tracknumber: 1, date: '2021-04-23', discnumber: 1, musicbrainz_albumid: 'rel-1' })
    expect(provenance).toMatchObject({ title: 'existing', date: 'mb', discnumber: 'heuristic' })
  })

  it('ignores garbage existing values', () => {
    const { tags, provenance } = mergeTags({ existing: { title: 'Track 01', artist: 'Unknown Artist', album: 'www.free-mp3.example' }, heuristic: { title: 'Real Title', artist: 'Real Artist' } }, 'musicbrainz-first', false)
    expect(tags).toEqual({ title: 'Real Title', artist: 'Real Artist' })
    expect(provenance).toEqual({ title: 'heuristic', artist: 'heuristic' })
  })
})

describe('pickGenre', () => {
  it('takes the most-voted genre from the MB list, summing duplicates', () => {
    expect(pickGenre([{ name: 'rock', count: 9 }, { name: 'nu metal', count: 24 }, { name: 'rap rock', count: 16 }])).toBe('Nu Metal')
    expect(pickGenre([{ name: 'rock', count: 5 }, { name: 'pop', count: 4 }, { name: 'pop', count: 3 }])).toBe('Pop')
  })
  it('ignores names outside the MB genre list (Bandcamp tags, moods)', () => {
    expect(pickGenre([{ name: 'seen live', count: 50 }, { name: 'awesome', count: 40 }, { name: 'breakcore', count: 1 }])).toBe('Breakcore')
    expect(pickGenre([{ name: 'electronic' }, { name: 'brighton' }, { name: 'speedcore' }])).toBe('Electronic')
  })
  it('breaks ties in favour of the existing genre', () => {
    expect(pickGenre([{ name: 'house', count: 2 }, { name: 'techno', count: 2 }], 'Techno')).toBe('Techno')
  })
  it('falls back to the first component of the existing genre', () => {
    expect(pickGenre([], 'electronic, hip hop')).toBe('Electronic')
    expect(pickGenre([], 'Bandes originales de films')).toBe('Bandes originales de films')
    expect(pickGenre([])).toBeUndefined()
  })
  it('title-cases with acronyms and minor words', () => {
    expect(genreTitleCase('uk garage')).toBe('UK Garage')
    expect(genreTitleCase('edm')).toBe('EDM')
    expect(genreTitleCase('drum and bass')).toBe('Drum and Bass')
    expect(genreTitleCase('dancefloor drum and bass')).toBe('Dancefloor Drum and Bass')
    expect(genreTitleCase('j-pop')).toBe('J-Pop')
    expect(genreTitleCase('r&b')).toBe('R&B')
    expect(genreTitleCase('hi-nrg')).toBe('Hi-NRG')
    expect(genreTitleCase("rock 'n' roll")).toBe("Rock 'n' Roll")
    expect(genreTitleCase('lo-fi hip hop')).toBe('Lo-Fi Hip Hop')
  })
  it('bundles the MB genre list', () => {
    for (const g of ['plunderphonics', 'hyperpop', 'chiptune', 'uk garage', 'Drum And Bass']) expect(isKnownGenre(g)).toBe(true)
    expect(isKnownGenre('seen live')).toBe(false)
  })
})
