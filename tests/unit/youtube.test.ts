// YouTube rips: description/title parsing, seasons, playlist parsing (fixtures from a real SiIvaGunner
// playlist and upload), yt-dlp helpers, and the 'youtube' acquirer over a fake yt-dlp.

import { afterAll, describe, expect, it } from 'vitest'
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import sharp from 'sharp'
import { sandbox } from '../helpers/sandbox'
import { genAudio } from '../helpers/audio'
import { gameFromTitle, parseDescription, SIIVAGUNNER_CHANNEL_ID, uploadedAt, type YtInfo } from '@main/sources/youtube/metadata'
import { DEFAULT_SEASONS, placeholderSvg, seasonAlbum, seasonFor, SeasonStore, validateSeasons } from '@main/sources/youtube/seasons'
import { parseFlatPlaylist, playlistUrl } from '@main/sources/youtube/playlist'
import { downloadFraction, sumFor, ytDlpAsset, ytDlpError } from '@main/sources/youtube/ytdlp'
import { createAcquirer } from '@main/sources/youtube/acquire'
import { planDuplicates, type RipCopy } from '@main/sources/youtube/duplicates'
import { keysFiledElsewhere } from '@main/sync/ledger'

const fx = (name: string) => readFileSync(join(__dirname, '../fixtures/youtube', name), 'utf8')
const info = JSON.parse(fx('video-info.json')) as YtInfo

describe('rip metadata', () => {
  it('reads the structured description of a real upload', () => {
    expect(parseDescription(info.description)).toEqual({
      music: 'Swashbuckler Spectacular - A Truth-Plundering Author',
      composer: 'Noriyuki Iwadare',
      playlist: 'https://www.youtube.com/playlist?list=PLL0CQjrcN8D1Q6x4voxXUA4c4gOEsySA6',
      platform: 'Nintendo 3DS',
    })
  })

  it('splits track and game even when both contain " - "', () => {
    expect(gameFromTitle(info.title, 'Swashbuckler Spectacular - A Truth-Plundering Author')).toBe('Phoenix Wright: Ace Attorney - Dual Destinies')
    expect(gameFromTitle('Gourmet Race (Beta Mix) - Kirby Super Star')).toBe('Kirby Super Star')
    expect(gameFromTitle('Just a title')).toBeUndefined()
  })

  it('prefers the premiere time, then the upload time, then the day', () => {
    expect(uploadedAt(info)).toBe('2026-11-03T16:00:39.000Z')
    expect(uploadedAt({ id: 'x', title: 't', timestamp: 1, release_timestamp: 1700000000 })).toBe('2023-11-14T22:13:20.000Z')
    expect(uploadedAt({ id: 'x', title: 't', upload_date: '20160109' })).toBe('2016-01-09T00:00:00.000Z')
    expect(uploadedAt({ id: 'x', title: 't' })).toBeNull()
  })
})

describe('seasons', () => {
  const sb = sandbox('seasons')
  afterAll(() => sb.cleanup())

  it('files an upload under the latest season started on or before it', () => {
    const key = (d: string) => seasonFor(`${d}T12:00:00.000Z`, DEFAULT_SEASONS).key
    expect(key('2016-01-09')).toBe('s1')
    expect(key('2016-10-18')).toBe('s1') // post-finale uploads stay with Season 1
    expect(key('2016-10-19')).toBe('s2')
    expect(key('2019-03-25')).toBe('s3') // the Season 3 finale
    expect(key('2019-03-26')).toBe('s4')
    expect(key('2020-01-20')).toBe('s4') // the January 2020 break belongs to Season 4
    expect(key('2020-02-01')).toBe('s4e2')
    expect(key('2023-06-01')).toBe('s7')
    expect(key('2026-11-03')).toBe('sx')
    expect(key('2015-12-31')).toBe('s1')
  })

  it('names season albums', () => {
    expect(seasonAlbum({ name: 'Season 7: The Year of Grand Dad' })).toBe('SiIvaGunner: Season 7 – The Year of Grand Dad')
    expect(seasonAlbum({ name: 'Season X' })).toBe('SiIvaGunner: Season X')
  })

  it('validates edited tables and keeps them sorted', () => {
    expect(validateSeasons([{ key: 'b', name: 'Two', start: '2020-01-01' }, { key: 'a', name: 'One', start: '2019-01-01' }]).map((s) => s.key)).toEqual(['a', 'b'])
    expect(() => validateSeasons([])).toThrow(/empty/)
    expect(() => validateSeasons([{ key: 'a', name: 'One', start: 'soon' }])).toThrow(/start date/)
    expect(() => validateSeasons([{ key: 'a', name: 'One', start: '2019-01-01' }, { key: 'a', name: 'Two', start: '2020-01-01' }])).toThrow(/key/)
  })

  it('stores the table in the synced library folder and falls back to the defaults', () => {
    const store = new SeasonStore(sb.dir)
    expect(store.list()).toEqual(DEFAULT_SEASONS)
    store.save([...DEFAULT_SEASONS, { key: 's11', name: 'Season 11', start: '2027-01-08' }])
    expect(store.list().at(-1)).toEqual({ key: 's11', name: 'Season 11', start: '2027-01-08' })
    expect(existsSync(join(sb.dir, '.valence', 'rips', 'seasons.json'))).toBe(true)
  })

  it('renders placeholder covers', async () => {
    for (const [i, s] of DEFAULT_SEASONS.entries()) {
      const meta = await sharp(Buffer.from(placeholderSvg(s, i))).jpeg().toBuffer().then((b) => sharp(b).metadata())
      expect([s.key, meta.width, meta.height]).toEqual([s.key, 600, 600])
    }
  })
})

describe('playlists', () => {
  it('reads a real flat playlist listing, keeping channels', () => {
    const p = parseFlatPlaylist(fx('flat-playlist.json'))
    expect(p.title).toBe('Phoenix Wright: Ace Attorney - Dual Destinies')
    expect(p.entries).toHaveLength(6)
    expect(p.entries.every((e) => e.channelId === SIIVAGUNNER_CHANNEL_ID && !e.unavailable)).toBe(true)
    expect(p.entries.find((e) => e.id === 'hj5YJf94QdQ')).toMatchObject({ durationSec: 18, channel: 'SiIvaGunner' })
  })

  it('marks deleted videos and other channels', () => {
    const p = parseFlatPlaylist(
      JSON.stringify({
        entries: [
          { id: 'a', title: '[Deleted video]', channel_id: null },
          { id: 'b', title: 'Some cover', channel_id: 'UCother', channel: 'Someone' },
          { id: 'b', title: 'duplicate' },
        ],
      }),
    )
    expect(p.entries).toMatchObject([{ id: 'a', unavailable: true }, { id: 'b', channelId: 'UCother', unavailable: false }])
  })

  it('normalizes playlist links', () => {
    expect(playlistUrl('https://www.youtube.com/watch?v=hj5YJf94QdQ&list=PLL0CQjrcN8D1Q6x4voxXUA4c4gOEsySA6&index=6')).toBe('https://www.youtube.com/playlist?list=PLL0CQjrcN8D1Q6x4voxXUA4c4gOEsySA6')
    expect(playlistUrl('PLL0CQjrcN8D1Q6x4voxXUA4c4gOEsySA6')).toBe('https://www.youtube.com/playlist?list=PLL0CQjrcN8D1Q6x4voxXUA4c4gOEsySA6')
    expect(playlistUrl('https://www.youtube.com/watch?v=hj5YJf94QdQ')).toBeNull()
    expect(playlistUrl('https://example.com/?list=PL123')).toBeNull()
  })
})

describe('yt-dlp helpers', () => {
  it('picks the release asset and its checksum', () => {
    expect(ytDlpAsset('win32', 'x64')).toBe('yt-dlp.exe')
    expect(ytDlpAsset('darwin', 'arm64')).toBe('yt-dlp_macos')
    expect(ytDlpAsset('linux', 'arm64')).toBe('yt-dlp_linux_aarch64')
    const sums = `${'a'.repeat(64)}  yt-dlp\n${'b'.repeat(64)}  yt-dlp.exe\n`
    expect(sumFor(sums, 'yt-dlp.exe')).toBe('b'.repeat(64))
    expect(sumFor(sums, 'yt-dlp_macos')).toBeNull()
  })

  it('turns yt-dlp failures into queue errors', () => {
    expect(ytDlpError('ERROR: [youtube] x: Sign in to confirm you’re not a bot', 'dl').kind).toBe('abuse')
    expect(ytDlpError('ERROR: [youtube] x: Video unavailable', 'dl').kind).toBe('unavailable')
    expect(ytDlpError('ERROR: unable to download video data: HTTP Error 429: Too Many Requests', 'dl').kind).toBe('rate-limit')
    expect(downloadFraction('[download]  45.3% of ~ 3.10MiB at 1.2MiB/s ETA 00:02')).toBeCloseTo(0.453)
    expect(downloadFraction('[ExtractAudio] Destination: x.opus')).toBeNull()
  })
})

describe('youtube acquirer', () => {
  const sb = sandbox('yt-acq')
  afterAll(() => sb.cleanup())

  it('downloads into the season album with rip tags and a provisional track number', async () => {
    const audio = await genAudio(join(sb.dir, 'src.opus'), 'opus', { seconds: 1 })
    const runs: string[][] = []
    const ytdlp = {
      run: async (args: string[], opts: { onLine?: (l: string) => void }) => {
        runs.push(args)
        const out = args[args.indexOf('-o') + 1].replace('%(id)s.%(ext)s', '')
        copyFileSync(audio, join(out, 'hj5YJf94QdQ.opus'))
        writeFileSync(join(out, 'hj5YJf94QdQ.info.json'), fx('video-info.json'))
        opts.onLine?.('[download] 100.0% of 267.51KiB')
        return { code: 0, stdout: '', stderr: '' }
      },
    }
    const stagingDir = join(sb.dir, 'staging')
    mkdirSync(stagingDir, { recursive: true })
    const covers: string[] = []
    const acquire = createAcquirer({
      ytdlp: ytdlp as never,
      seasons: () => DEFAULT_SEASONS,
      coverFor: async (s, dir) => (covers.push(s.key), join(dir, 'cover.jpg')),
      positionFor: (album) => (album === 'SiIvaGunner: Season X' ? { track: 4, total: 9 } : { track: 1, total: 1 }),
    })
    const rel = await acquire({ videoId: 'hj5YJf94QdQ' }, { stagingDir, signal: new AbortController().signal, progress: () => {} })
    expect(runs[0]).toEqual(expect.arrayContaining(['-f', 'bestaudio/best', '-x', '--no-playlist', 'https://www.youtube.com/watch?v=hj5YJf94QdQ']))
    expect(covers).toEqual(['sx'])
    expect(rel).toMatchObject({ source: 'youtube', releaseKeys: ['youtube:hj5YJf94QdQ'], skipLookups: true })
    expect(rel.tracks[0].tags).toMatchObject({
      title: info.title,
      artist: 'SiIvaGunner',
      albumartist: 'SiIvaGunner',
      album: 'SiIvaGunner: Season X',
      date: '2026-11-03',
      tracknumber: 4,
      totaltracks: 9,
      composer: 'Noriyuki Iwadare',
      rip_game: 'Phoenix Wright: Ace Attorney - Dual Destinies',
      rip_platform: 'Nintendo 3DS',
      hq_rip: 'YouTube',
      youtube_video_id: 'hj5YJf94QdQ',
      youtube_uploaded: '2026-11-03T16:00:39.000Z',
    })
  })

  it('refuses uploads from other channels', async () => {
    const stagingDir = join(sb.dir, 'other')
    mkdirSync(stagingDir, { recursive: true })
    const ytdlp = {
      run: async () => {
        writeFileSync(join(stagingDir, 'x1.opus'), 'x')
        writeFileSync(join(stagingDir, 'x1.info.json'), JSON.stringify({ ...info, id: 'x1', channel_id: 'UCsomeoneelse', channel: 'Someone' }))
        return { code: 0, stdout: '', stderr: '' }
      },
    }
    const acquire = createAcquirer({ ytdlp: ytdlp as never, seasons: () => DEFAULT_SEASONS, coverFor: async () => '', positionFor: () => ({ track: 1, total: 1 }) })
    await expect(acquire({ videoId: 'x1' }, { stagingDir, signal: new AbortController().signal, progress: () => {} })).rejects.toMatchObject({ kind: 'unavailable' })
  })
})

describe('duplicate rips: which copy stays', () => {
  const copy = (relPath: string, durationMs = 48_000, videoId = 'v1'): RipCopy => ({ videoId, relPath, title: 'T', durationMs })

  it('keeps the plain name over numbered copies, whatever order they come in', () => {
    const plan = planDuplicates([copy('S/T (10).opus'), copy('S/T (2).opus'), copy('S/T.opus')])
    expect(plan).toEqual([{ videoId: 'v1', title: 'T', keep: 'S/T.opus', trash: ['S/T (2).opus', 'S/T (10).opus'] }])
  })

  it('keeps a numbered copy over a conflict copy, and a title that really ends in a number works', () => {
    expect(planDuplicates([copy('S/T.sync-conflict-20261105-123456-ABCDEFG.opus'), copy('S/T (2).opus')])[0].keep).toBe('S/T (2).opus')
    expect(planDuplicates([copy('S/T (2) (2).opus'), copy('S/T (2).opus')])[0].keep).toBe('S/T (2).opus')
  })

  it('leaves single copies, other videos and edit cuts out of it', () => {
    expect(planDuplicates([copy('S/A.opus', 48_000, 'a'), copy('S/B.opus', 48_000, 'b')])).toEqual([])
    expect(planDuplicates([copy('S/T.opus', 48_000), copy('S/T edit.opus', 20_000)])).toEqual([])
    // A cut with the shortest name doesn't get in the way of the real copies.
    expect(planDuplicates([copy('S/C.opus', 20_000), copy('S/Long Title.opus', 48_000), copy('S/Long Title (2).opus', 48_500)])).toEqual([
      { videoId: 'v1', title: 'T', keep: 'S/Long Title.opus', trash: ['S/Long Title (2).opus'] },
    ])
  })

  it('never lists a file it knows too little about, or conflict copies with nothing to keep', () => {
    expect(planDuplicates([copy('S/T.opus', 48_000), copy('S/T (2).opus', 0)])).toEqual([])
    expect(planDuplicates([copy('S/T.sync-conflict-20261105-123456-ABCDEFG.opus'), copy('S/T.sync-conflict-20261105-123457-HIJKLMN.opus')])).toEqual([])
  })
})

describe('other devices\' import ledgers', () => {
  const sb = sandbox('ledger')
  afterAll(() => sb.cleanup())
  const device = (id: string, lines: string) => {
    mkdirSync(join(sb.dir, '.valence', 'devices', id), { recursive: true })
    writeFileSync(join(sb.dir, '.valence', 'devices', id, 'ledger.jsonl'), lines)
  }

  it('reads the keys other devices filed, and nothing else', () => {
    device('me', '{"op":"add","keys":["youtube:mine"]}\n')
    device('windows', '{"op":"add","keys":["youtube:a"]}\n{"op":"add","keys":["tidal:album:1","upc:2"]}\n{"op":"upgrade","keys":["youtube:b"]}\n{"op":"add","keys":["youtube:cut-off"')
    mkdirSync(join(sb.dir, '.valence', 'devices', 'phone'), { recursive: true })
    expect([...keysFiledElsewhere(sb.dir, 'me', 'youtube:')].sort()).toEqual(['youtube:a', 'youtube:b'])
  })

  it('is empty for a library with no device folders', () => {
    expect(keysFiledElsewhere(join(sb.dir, 'nowhere'), 'me', 'youtube:').size).toBe(0)
  })
})
