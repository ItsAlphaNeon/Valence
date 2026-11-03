import { describe, expect, it } from 'vitest'
import { cleanTitle, clusterFiles, fixMojibake, inferLooseCluster } from '@main/metadata'
import { parseAlbumFolder, parseFilename, sanitizeTags, isGarbageValue } from '@main/metadata/heuristics'
import type { TrackTags } from '@shared/types'

const f = (relPath: string, tags: TrackTags = {}, durationMs = 200_000) => ({ relPath, tags, durationMs })

describe('cleanTitle', () => {
  it('strips the U+1F174 explicit marker', () => {
    expect(cleanTitle('Toy Shop ((OMN Album Mix)) \u{1F174}')).toEqual({ title: 'Toy Shop ((OMN Album Mix))', explicit: true })
  })
  it.each([
    ['Song (Explicit)', 'Song', true],
    ['Song [Explicit]', 'Song', true],
    ['Song [E]', 'Song', true],
    ['Song (Official Music Video)', 'Song', false],
    ['Song (Official Video)', 'Song', false],
    ['Song (Official Audio)', 'Song', false],
    ['Song (Lyric Video)', 'Song', false],
    ['Song [Lyrics]', 'Song', false],
    ['Song (Visualizer)', 'Song', false],
    ['Song (HQ)', 'Song', false],
    ['Song (HD) [Free Download]', 'Song', false],
    ['Never Gonna Give You Up [dQw4w9WgXcQ]', 'Never Gonna Give You Up', false],
    ['SUBWAY SURFERS [TRAP REMIX]', 'SUBWAY SURFERS [TRAP REMIX]', false],
    ['Thing [Remastered]', 'Thing [Remastered]', false],
    ['Danger Close (feat. PrinceWhateverer & Namii)', 'Danger Close (feat. PrinceWhateverer & Namii)', false],
    ['Exile Is A Habit (Original Acoustic Demo)', 'Exile Is A Habit (Original Acoustic Demo)', false],
  ])('%s', (input, title, explicit) => {
    expect(cleanTitle(input)).toEqual({ title, explicit })
  })
})

describe('fixMojibake', () => {
  it('repairs latin1-decoded UTF-8', () => {
    expect(fixMojibake('CafÃ© del Mar')).toBe('Café del Mar')
    expect(fixMojibake('Donâ€™t Stop')).toBe('Don’t Stop')
    expect(fixMojibake('BeyoncÃ© â€“ Halo')).toBe('Beyoncé – Halo')
    expect(fixMojibake('SENSACIÃ“N DE CALOR')).toBe('SENSACIÓN DE CALOR')
  })
  it('repairs mojibake of CJK text', () => {
    expect(fixMojibake('ç‰›å°¾æ†²è¼”')).toBe('牛尾憲輔')
  })
  it('repairs double-encoded text', () => {
    expect(fixMojibake('CafÃƒÂ©')).toBe('Café')
  })
  it('leaves correct text alone', () => {
    for (const s of ['Café', 'Ærøskøbing', 'São Paulo', 'ÀÉÎÕÜ', '牛尾憲輔', 'María Escarmiento', 'Ancient Artifact ARGÓS-CCCIII', 'K² + Darius', 'MEGA×5 ～ Ⅴᵗʰ Anniversary'])
      expect(fixMojibake(s)).toBe(s)
  })
})

describe('garbage tags', () => {
  it('detects placeholder and URL values', () => {
    expect(isGarbageValue('title', 'Track 01')).toBe(true)
    expect(isGarbageValue('title', 'AudioTrack 05')).toBe(true)
    expect(isGarbageValue('artist', 'Unknown Artist')).toBe(true)
    expect(isGarbageValue('album', 'www.mp3-download.example')).toBe(true)
    expect(isGarbageValue('artist', 'https://foo.bandcamp.com')).toBe(true)
    expect(isGarbageValue('title', '22')).toBe(false)
    expect(isGarbageValue('title', 'Track Star')).toBe(false)
  })
  it('sanitizeTags drops garbage, fixes mojibake and cleans titles', () => {
    const t = sanitizeTags({ title: 'Ã‰tÃ© (Official Video) \u{1F174}', artist: 'Unknown Artist', album: 'www.example.com', genre: 'Pop' })
    expect(t).toEqual({ title: 'Été', explicit: true, genre: 'Pop' })
  })
})

describe('parseAlbumFolder', () => {
  it.each([
    ['Daft Punk - Random Access Memories (2013)', undefined, { artist: 'Daft Punk', album: 'Random Access Memories', year: '2013' }],
    ['Daft Punk - 2013 - Random Access Memories', undefined, { artist: 'Daft Punk', album: 'Random Access Memories', year: '2013' }],
    ['[2013] Random Access Memories', 'Daft Punk', { artist: 'Daft Punk', album: 'Random Access Memories', year: '2013' }],
    ['(2013) Random Access Memories', 'Daft Punk', { artist: 'Daft Punk', album: 'Random Access Memories', year: '2013' }],
    ['Random Access Memories (2013)', 'Daft Punk', { artist: 'Daft Punk', album: 'Random Access Memories', year: '2013' }],
    ['Daft Punk - Random Access Memories (2013) [FLAC 24-96]', undefined, { artist: 'Daft Punk', album: 'Random Access Memories', year: '2013' }],
    ['Random Access Memories (2013) [WEB] {88883716861}', 'Daft Punk', { artist: 'Daft Punk', album: 'Random Access Memories', year: '2013' }],
    ['Random Access Memories [MP3 320] (2013)', 'Daft Punk', { artist: 'Daft Punk', album: 'Random Access Memories', year: '2013' }],
    ['Random Access Memories (Vinyl) (2013) www.example.org', 'Daft Punk', { artist: 'Daft Punk', album: 'Random Access Memories', year: '2013' }],
    ['Daft_Punk-Random_Access_Memories-WEB-2013-GRP', undefined, { artist: 'Daft Punk', album: 'Random Access Memories', year: '2013' }],
    ['Lofi_ Gravity Falls', 'Brad Breeck', { artist: 'Brad Breeck', album: 'Lofi Gravity Falls' }],
    ['Hi-Res Stuff (24bit) (Hi-Res)', 'X', { artist: 'X', album: 'Hi-Res Stuff' }],
  ])('%s', (name, parent, want) => {
    expect(parseAlbumFolder(name, parent)).toMatchObject(want)
  })
  it('only treats "X - Y" as artist/album when X is a known artist', () => {
    expect(parseAlbumFolder('M-Project - Singles', 'M-Project')).toMatchObject({ artist: 'M-Project', album: 'Singles', strong: true })
    expect(parseAlbumFolder('Live - Throwing Copper', 'Music')).toMatchObject({ album: 'Live - Throwing Copper', strong: false })
  })
  it('ignores generic folder names', () => {
    expect(parseAlbumFolder('Downloads', undefined)).toEqual({ strong: false })
    expect(parseAlbumFolder('loose', 'real')).toEqual({ strong: false })
  })
})

describe('parseFilename', () => {
  const no = () => false
  it.each([
    ['1-03 Title', { discnumber: 1, tracknumber: 3, title: 'Title', kind: 'disc' }],
    ['2.05 - Title', { discnumber: 2, tracknumber: 5, title: 'Title' }],
    ['03 Title', { tracknumber: 3, title: 'Title', kind: 'num:space' }],
    ['03. Title', { tracknumber: 3, title: 'Title', kind: 'num:dot' }],
    ['03 - Title', { tracknumber: 3, title: 'Title', kind: 'num:dash' }],
    ['03_-_Some_Title', { tracknumber: 3, title: 'Some Title' }],
    ['1979', { title: '1979', kind: 'plain' }],
    ['22', { title: '22', kind: 'plain' }],
    ['Gideon Rises - End Credits', { title: 'Gideon Rises - End Credits', kind: 'plain' }],
  ])('%s', (stem, want) => {
    expect(parseFilename(stem, no)).toMatchObject(want)
  })
  it('splits "NN - Artist - Title" only for accepted artists', () => {
    const acc = (a: string) => a === 'Daft Punk'
    expect(parseFilename('03 - Daft Punk - Giorgio by Moroder', acc)).toMatchObject({ tracknumber: 3, artist: 'Daft Punk', title: 'Giorgio by Moroder', kind: 'num:dash' })
    expect(parseFilename('03 - Gideon Rises - End Credits', acc)).toMatchObject({ tracknumber: 3, title: 'Gideon Rises - End Credits' })
    expect(parseFilename('3 Doors Down - Kryptonite', (a) => a === '3 Doors Down')).toMatchObject({ artist: '3 Doors Down', title: 'Kryptonite' })
  })
})

describe('clusterFiles', () => {
  it('merges disc subfolders and splits folders only for ≥ 2 albums with ≥ 2 files', () => {
    const files = [
      f('A/Album/CD1/01 a.mp3'), f('A/Album/CD2/01 b.mp3'), f('A/Album/Disc 3/01 c.mp3'),
      f('mix/x.mp3', { album: 'One' }), f('mix/y.mp3', { album: 'One' }), f('mix/z.mp3', { album: 'Two' }), f('mix/w.mp3', { album: 'Two' }), f('mix/v.mp3', { album: 'Three' }),
      f('flat/p.mp3', { album: 'P' }), f('flat/q.mp3', { album: 'P' }), f('flat/r.mp3', { album: 'R' }),
    ]
    expect(clusterFiles(files)).toEqual([[0, 1, 2], [3, 4], [5, 6], [7], [8, 9, 10]])
  })
})

describe('inferLooseCluster', () => {
  it('parses an untagged album folder', () => {
    const files = ['01 - Give Life Back to Music.flac', '02 - The Game of Love.flac', '03 - Giorgio by Moroder.flac', '04 - Within.flac']
      .map((n) => f(`Daft Punk - Random Access Memories (2013) [FLAC]/${n}`))
    const out = inferLooseCluster(files)
    expect(out[2]).toEqual({ title: 'Giorgio by Moroder', artist: 'Daft Punk', album: 'Random Access Memories', albumartist: 'Daft Punk', date: '2013', tracknumber: 3 })
  })

  it('reads "NN - Artist - Title" when the artist is shared across the cluster', () => {
    const files = ['01 - Various Guy - Alpha.mp3', '02 - Other Person - Beta.mp3', '03 - Various Guy - Gamma.mp3'].map((n) => f(`Comp (2001)/${n}`))
    const out = inferLooseCluster(files)
    expect(out[0]).toMatchObject({ tracknumber: 1, artist: 'Various Guy', title: 'Alpha', album: 'Comp', date: '2001' })
    // "Other Person" occurs once and is not the folder artist: kept in the title.
    expect(out[1]).toMatchObject({ tracknumber: 2, title: 'Other Person - Beta' })
  })

  it('keeps numbers that belong to the title ("22", "1979", "99 Problems")', () => {
    const one = (name: string) => inferLooseCluster([f(`loose/${name}`)])[0]
    expect(one('22.mp3')).toEqual({ title: '22' })
    expect(one('1979.mp3')).toEqual({ title: '1979' })
    expect(one('99 Problems.mp3')).toEqual({ title: '99 Problems' })
    expect(one('01 Intro.mp3')).toEqual({ title: 'Intro', tracknumber: 1 })
  })

  it('rejects numbering when fewer than 70 % of the cluster agree or numbers repeat', () => {
    const files = ['01 Alpha.mp3', 'Beta.mp3', 'Gamma.mp3', '10 Years.mp3'].map((n) => f(`Artist/Album/${n}`))
    const out = inferLooseCluster(files)
    expect(out.map((t) => [t.title, t.tracknumber])).toEqual([['01 Alpha', undefined], ['Beta', undefined], ['Gamma', undefined], ['10 Years', undefined]])
    const dup = inferLooseCluster(['01 A.mp3', '01 B.mp3', '02 C.mp3'].map((n) => f(`X/Y/${n}`)))
    expect(dup.map((t) => t.tracknumber)).toEqual([undefined, undefined, undefined])
  })

  it('accepts a number when the tag agrees even if the cluster does not', () => {
    const out = inferLooseCluster([f('loose/07 Song.mp3', { tracknumber: 7 }), f('loose/Other.mp3')])
    expect(out[0]).toMatchObject({ title: 'Song', tracknumber: 7 })
  })

  it('takes the title from the filename when the tag is garbage or just the filename', () => {
    const out = inferLooseCluster([
      f('Some Band/Some Record/01 - First.mp3', { title: 'Track 01', artist: 'Unknown Artist' }),
      f('Some Band/Some Record/02 - Second.mp3', { title: '02 - Second' }),
      f('Some Band/Some Record/03 - Third.mp3', { title: '03 - Third.mp3' }),
    ])
    expect(out.map((t) => t.title)).toEqual(['First', 'Second', 'Third'])
    expect(out[0]).toMatchObject({ artist: 'Some Band', album: 'Some Record', albumartist: 'Some Band', tracknumber: 1 })
  })

  it('keeps good tags and the U+1F174 marker becomes explicit', () => {
    const tags: TrackTags = { title: 'Toy Shop ((OMN Album Mix)) \u{1F174}', artist: 'Vau Boy', album: 'M-Project - Singles', albumartist: 'M-Project', tracknumber: 14 }
    const [t] = inferLooseCluster([f('albums/M-Project/M-Project - Singles/Toy Shop ((OMN Album Mix)) 🅴.mp3', tags)])
    expect(t).toEqual({ ...tags, title: 'Toy Shop ((OMN Album Mix))', explicit: true })
  })

  it('repairs ID3v1-truncated titles from the filename', () => {
    const long = 'A Remarkably Long Song Title That Goes On'
    const [t] = inferLooseCluster([f(`loose/${long}.mp3`, { title: long.slice(0, 30) })])
    expect(t.title).toBe(long)
  })

  it('handles CJK names and mojibake tags', () => {
    const files = [
      f('牛尾憲輔/CHAINSAW MAN THE MOVIE (2025)/01 Reze.flac', { artist: 'ç‰›å°¾æ†²è¼”' }),
      f('牛尾憲輔/CHAINSAW MAN THE MOVIE (2025)/02 she is coming.flac'),
    ]
    const out = inferLooseCluster(files)
    expect(out[0]).toMatchObject({ title: 'Reze', artist: '牛尾憲輔', album: 'CHAINSAW MAN THE MOVIE', albumartist: '牛尾憲輔', date: '2025', tracknumber: 1 })
    expect(out[1]).toMatchObject({ title: 'she is coming', artist: '牛尾憲輔', tracknumber: 2 })
  })

  it('reads D-NN numbering and disc folders', () => {
    const a = inferLooseCluster(['1-01 A.mp3', '1-02 B.mp3', '2-01 C.mp3'].map((n) => f(`Art/Alb/${n}`)))
    expect(a.map((t) => [t.discnumber, t.tracknumber, t.title])).toEqual([[1, 1, 'A'], [1, 2, 'B'], [2, 1, 'C']])
    const b = inferLooseCluster(['CD1/01 A.mp3', 'CD1/02 B.mp3', 'CD 2/01 C.mp3'].map((n) => f(`Art/Alb/${n}`)))
    expect(b.map((t) => [t.discnumber, t.tracknumber, t.album])).toEqual([[1, 1, 'Alb'], [1, 2, 'Alb'], [2, 1, 'Alb']])
  })

  it('splits "Artist - Title" only for the folder artist', () => {
    const out = inferLooseCluster([
      f('Fox Stevenson/Misc/Fox Stevenson - Curtain Call.mp3'),
      f('Fox Stevenson/Misc/Hardware Remove - Windows 7.mp3'),
    ])
    expect(out[0]).toMatchObject({ artist: 'Fox Stevenson', title: 'Curtain Call' })
    expect(out[1]).toMatchObject({ title: 'Hardware Remove - Windows 7' })
  })

  it('replaces underscores only when the name has no spaces', () => {
    const out = inferLooseCluster([f('loose/Some_Song_Name.mp3'), f('loose/I Saw a Deer Today_ Aerial Faith Plate (4C).mp3')])
    expect(out[0].title).toBe('Some Song Name')
    expect(out[1].title).toBe('I Saw a Deer Today Aerial Faith Plate (4C)')
  })
})
