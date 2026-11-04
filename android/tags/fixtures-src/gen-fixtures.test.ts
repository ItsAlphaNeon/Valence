// Generates the :tags test fixtures the way the desktop writes them, plus the desktop's own reading of
// each file (expected.json), so the Kotlin reader is checked against the real desktop behaviour.
//
// Run from the repo root (writes android/tags/src/test/resources/fixtures/):
//   npx vitest run --config android/tags/fixtures-src/vitest.config.mts
//
// Audio comes from ffmpeg-static; tags from src/main/tags/write.ts (node-taglib-sharp), except a few
// hand-built ID3 tags that exercise reader paths the desktop writer never produces (v2.4 UTF-8
// multi-values, per-frame unsync + data-length indicator, v2.3 whole-tag unsync, v2.2, ID3v1-only).

import { it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ffmpegPath from 'ffmpeg-static'
import { writeTags } from '@main/tags/write'
import { probeFile } from '@main/tags/read'
import type { TrackTags } from '@shared/types'

const here = dirname(fileURLToPath(import.meta.url))
const OUT = resolve(here, '../src/test/resources/fixtures')

function ffmpeg(args: string[]): void {
  const r = spawnSync(ffmpegPath as unknown as string, ['-hide_banner', '-nostdin', '-loglevel', 'error', '-y', ...args])
  if (r.status !== 0) throw new Error(`ffmpeg failed: ${args.join(' ')}\n${r.stderr}`)
}

function sine(seconds: number, rate = 44100, freq = 440): string[] {
  return ['-f', 'lavfi', '-i', `sine=frequency=${freq}:sample_rate=${rate}:duration=${seconds}`]
}

// ------------------------------------------------------------------ hand-built ID3

const latin1 = (s: string) => Buffer.from(s, 'latin1')
const utf8 = (s: string) => Buffer.from(s, 'utf8')
const utf16bom = (s: string) => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(s, 'utf16le')])
const utf16be = (s: string) => Buffer.from(s, 'utf16le').swap16()

function syncsafe(n: number): Buffer {
  return Buffer.from([(n >> 21) & 0x7f, (n >> 14) & 0x7f, (n >> 7) & 0x7f, n & 0x7f])
}

function be32(n: number): Buffer {
  const b = Buffer.alloc(4)
  b.writeUInt32BE(n)
  return b
}

function unsync(data: Buffer): Buffer {
  const out: number[] = []
  for (let i = 0; i < data.length; i++) {
    out.push(data[i])
    if (data[i] === 0xff && (i + 1 >= data.length || data[i + 1] === 0 || data[i + 1] >= 0xe0)) out.push(0)
  }
  return Buffer.from(out)
}

/** Text payload: encoding byte + values joined by the encoding's NUL. */
function text(enc: 0 | 1 | 2 | 3, ...values: string[]): Buffer {
  const encode = [latin1, utf16bom, utf16be, utf8][enc]
  const nul = enc === 1 || enc === 2 ? Buffer.alloc(2) : Buffer.alloc(1)
  const parts: Buffer[] = [Buffer.from([enc])]
  values.forEach((v, i) => {
    if (i) parts.push(nul)
    parts.push(encode(v))
  })
  return Buffer.concat(parts)
}

function txxx(enc: 0 | 1 | 2 | 3, desc: string, ...values: string[]): Buffer {
  const encode = [latin1, utf16bom, utf16be, utf8][enc]
  const nul = enc === 1 || enc === 2 ? Buffer.alloc(2) : Buffer.alloc(1)
  const parts: Buffer[] = [Buffer.from([enc]), encode(desc), nul]
  values.forEach((v, i) => {
    if (i) parts.push(nul)
    parts.push(encode(v))
  })
  return Buffer.concat(parts)
}

function commLike(enc: 0 | 1 | 3, lang: string, desc: string, body: string): Buffer {
  const encode = [latin1, utf16bom, utf16be, utf8][enc]
  const nul = enc === 1 ? Buffer.alloc(2) : Buffer.alloc(1)
  return Buffer.concat([Buffer.from([enc]), latin1(lang), encode(desc), nul, encode(body)])
}

function apic(mime: string, type: number, data: Buffer): Buffer {
  return Buffer.concat([Buffer.from([0]), latin1(mime), Buffer.alloc(1), Buffer.from([type]), Buffer.alloc(1), data])
}

function popm(email: string, rating: number): Buffer {
  return Buffer.concat([latin1(email), Buffer.alloc(1), Buffer.from([rating]), be32(7)])
}

function frame24(id: string, payload: Buffer, opts: { unsync?: boolean; dli?: boolean } = {}): Buffer {
  let data = payload
  let flags = 0
  if (opts.unsync) {
    data = unsync(data)
    flags |= 0x02
  }
  if (opts.dli) {
    data = Buffer.concat([syncsafe(payload.length), data])
    flags |= 0x01
  }
  return Buffer.concat([latin1(id), syncsafe(data.length), Buffer.from([0, flags]), data])
}

function frame23(id: string, payload: Buffer): Buffer {
  return Buffer.concat([latin1(id), be32(payload.length), Buffer.from([0, 0]), payload])
}

function frame22(id: string, payload: Buffer): Buffer {
  const n = payload.length
  return Buffer.concat([latin1(id), Buffer.from([(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]), payload])
}

function id3(major: 2 | 3 | 4, flags: number, body: Buffer, padding = 64): Buffer {
  const all = Buffer.concat([body, Buffer.alloc(padding)])
  return Buffer.concat([latin1('ID3'), Buffer.from([major, 0, flags]), syncsafe(all.length), all])
}

// ------------------------------------------------------------------ desktop tag sets

const CORE: TrackTags = {
  title: 'ближе',
  artist: 'xXXi_wud_nvrstøp_ÜXXx',
  artists: ['xXXi_wud_nvrstøp_ÜXXx', 'Кино'],
  album: 'Ünïcødé Album (Deluxe)',
  albumartist: 'xXXi_wud_nvrstøp_ÜXXx',
  albumartistsort: 'wud nvrstop',
  artistsort: 'wud nvrstop, xXXi',
  titlesort: 'blizhe',
  albumsort: 'Unicode Album',
  tracknumber: 3,
  totaltracks: 12,
  discnumber: 1,
  totaldiscs: 2,
  date: '2021-05-14',
  originaldate: '2020-01-01',
  genre: 'Electronic',
  isrc: 'USABC2100001',
  barcode: '0123456789012',
  label: 'Test Label',
  catalognumber: 'TL-001',
  copyright: '℗ 2021 Test',
  bpm: 128,
  key: 'Am',
  comment: 'A comment',
  media: 'Digital Media',
  composer: 'Виктор Цой',
  musicbrainz_recordingid: '11111111-1111-1111-1111-111111111111',
  musicbrainz_trackid: '22222222-2222-2222-2222-222222222222',
  musicbrainz_albumid: '33333333-3333-3333-3333-333333333333',
  musicbrainz_releasegroupid: '44444444-4444-4444-4444-444444444444',
  musicbrainz_artistid: ['55555555-5555-5555-5555-555555555555', '66666666-6666-6666-6666-666666666666'],
  musicbrainz_albumartistid: ['55555555-5555-5555-5555-555555555555'],
  releasetype: 'album',
  releasestatus: 'official',
  releasecountry: 'XW',
  acoustid_id: '77777777-7777-7777-7777-777777777777',
  replaygain_track_gain: -6.54,
  replaygain_track_peak: 0.988547,
  replaygain_album_gain: -7.1,
  replaygain_album_peak: 1.0,
  lyrics: '[00:01.00]Первая строка\n[00:02.50]Second line',
  rating: 4,
  explicit: true,
  valence_id: '0193f0c2-aaaa-7bbb-8ccc-dddddddddddd',
  valence_owner: 'dev-0f3a9c',
  tidal_track_id: '123456789',
  tidal_album_id: '98765432',
  bandcamp_item_id: '1122334455',
  bandcamp_track_id: '5544332211',
  bandcamp_url: 'https://artist.bandcamp.com/track/blizhe',
  source: 'tidal',
  source_quality: 'lossless:16:44100',
}

// ------------------------------------------------------------------ generation

it('generates fixtures', async () => {
  const work = mkdtempSync(join(tmpdir(), 'valence-tags-'))
  rmSync(OUT, { recursive: true, force: true })
  mkdirSync(OUT, { recursive: true })
  const out = (name: string) => join(OUT, name)
  try {
    const jpg = join(work, 'cover.jpg')
    const png = join(work, 'cover.png')
    ffmpeg(['-f', 'lavfi', '-i', 'color=c=teal:s=16x16:d=1', '-frames:v', '1', jpg])
    ffmpeg(['-f', 'lavfi', '-i', 'color=c=orange:s=16x16:d=1', '-frames:v', '1', png])
    const jpeg = readFileSync(jpg)
    const pngData = readFileSync(png)
    const art = { data: jpeg, mime: 'image/jpeg' }
    const artPng = { data: pngData, mime: 'image/png' }

    // Raw MPEG streams (no tags) used under the hand-built tags.
    const rawCbr = join(work, 'raw-cbr.mp3')
    ffmpeg([...sine(1), '-ac', '2', '-c:a', 'libmp3lame', '-b:a', '128k', '-id3v2_version', '0', '-write_xing', '0', rawCbr])
    const rawXing = join(work, 'raw-xing.mp3')
    ffmpeg([...sine(1, 48000), '-ac', '2', '-c:a', 'libmp3lame', '-b:a', '160k', '-id3v2_version', '0', rawXing])

    // 1. MP3, ID3v2.3 by the desktop writer (UTF-16 text, POPM 4 stars, USLT LRC, JPEG front cover).
    ffmpeg([...sine(1), '-ac', '2', '-c:a', 'libmp3lame', '-b:a', '128k', out('desktop_v23.mp3')])
    writeTags(out('desktop_v23.mp3'), CORE, { artwork: art })

    // 2. MP3, hand-built ID3v2.4: UTF-8 / UTF-16 / UTF-16BE, NUL multi-values, extended header,
    //    per-frame unsync + data-length indicator on the cover, two POPMs (desktop owner wins).
    const v24 = id3(4, 0x40, Buffer.concat([
      syncsafe(6), Buffer.from([1, 0]), // extended header
      frame24('TIT2', text(3, 'ближе (v2.4)')),
      frame24('TPE1', text(3, 'Artist One', 'Артист Два')),
      frame24('TPE2', text(1, 'xXXi_wud_nvrstøp_ÜXXx')),
      frame24('TALB', text(2, 'Альбом')),
      frame24('TRCK', text(0, '5/9')),
      frame24('TPOS', text(0, '2')),
      frame24('TDRC', text(3, '2019-03-07')),
      frame24('TDOR', text(3, '2018-11-02')),
      frame24('TCON', text(3, 'Rock', 'Pop')),
      frame24('TCOM', text(3, 'Composer A', 'Composer B')),
      frame24('TSOP', text(3, 'One, Artist')),
      frame24('TBPM', text(0, '97')),
      frame24('TCMP', text(0, '1')),
      frame24('TXXX', txxx(3, 'ARTISTS', 'Artist One', 'Артист Два')),
      frame24('TXXX', txxx(3, 'VALENCE_ID', '0193f0c2-2424-7bbb-8ccc-000000000024')),
      frame24('TXXX', txxx(3, 'VALENCE_SOURCE', 'bandcamp')),
      frame24('TXXX', txxx(3, 'REPLAYGAIN_TRACK_GAIN', '+1.25 dB')),
      frame24('TXXX', txxx(3, 'REPLAYGAIN_TRACK_PEAK', '0.5')),
      frame24('TXXX', txxx(3, 'MusicBrainz Artist Id', '55555555-5555-5555-5555-555555555555', '66666666-6666-6666-6666-666666666666')),
      frame24('TXXX', txxx(1, 'Custom Multi', 'one', 'two')),
      frame24('COMM', commLike(3, 'eng', '', 'v2.4 comment'), { dli: true }),
      frame24('USLT', commLike(1, 'eng', '', 'Plain lyrics\r\nLine two')),
      frame24('POPM', popm('foo@example.com', 64)),
      frame24('POPM', popm('Windows Media Player 9 Series', 255)),
      frame24('APIC', apic('image/jpeg', 3, jpeg), { unsync: true, dli: true }),
    ]))
    writeFileSync(out('handmade_v24.mp3'), Buffer.concat([v24, readFileSync(rawXing)]))

    // 3. MP3, hand-built ID3v2.3 with whole-tag unsynchronisation and an extended header; numeric
    //    genre reference, an iTunes COMM before the real one, RATING without POPM, back + front covers.
    const v23body = Buffer.concat([
      be32(6), Buffer.from([0, 0]), be32(0), // extended header (size excludes itself)
      frame23('TIT2', text(1, 'Unsynced')),
      frame23('TPE1', text(0, 'Plain Artist')),
      frame23('TALB', text(0, 'Plain Album')),
      frame23('TCON', text(0, '(17)(18)Experimental')),
      frame23('TRCK', text(0, '07')),
      frame23('TYER', text(0, '1999')),
      frame23('TDAT', text(0, '3112')),
      frame23('COMM', commLike(0, 'eng', 'iTunNORM', ' 00000001 00000002')),
      frame23('COMM', commLike(1, 'eng', '', 'Real comment')),
      frame23('TXXX', txxx(0, 'RATING', '60')),
      frame23('TXXX', txxx(0, 'REPLAYGAIN_ALBUM_GAIN', '-2,50 dB')),
      frame23('APIC', apic('image/png', 4, pngData)),
      frame23('APIC', apic('image/jpeg', 3, jpeg)),
    ])
    const v23 = Buffer.concat([latin1('ID3'), Buffer.from([3, 0, 0xc0]), syncsafe(unsync(v23body).length + 32), unsync(v23body), Buffer.alloc(32)])
    writeFileSync(out('handmade_v23_unsync.mp3'), Buffer.concat([v23, readFileSync(rawCbr)]))

    // 4. MP3, hand-built ID3v2.2 (3-char frames, PIC with "JPG", bare numeric genre).
    const v22 = id3(2, 0, Buffer.concat([
      frame22('TT2', text(0, 'Old Title')),
      frame22('TP1', text(1, 'Old Artist')),
      frame22('TAL', text(0, 'Old Album')),
      frame22('TCO', text(0, '17')),
      frame22('TRK', text(0, '2/10')),
      frame22('TYE', text(0, '1998')),
      frame22('PIC', Buffer.concat([Buffer.from([0]), latin1('JPG'), Buffer.from([3]), Buffer.alloc(1), jpeg])),
    ]))
    writeFileSync(out('handmade_v22.mp3'), Buffer.concat([v22, readFileSync(rawCbr)]))

    // 5. Mono MP3 with only an ID3v1.1 tag (ffmpeg's own ID3v1 writer drops most fields, so build it).
    const rawMono = join(work, 'raw-mono.mp3')
    ffmpeg([...sine(1), '-ac', '1', '-c:a', 'libmp3lame', '-b:a', '64k', '-id3v2_version', '0', rawMono])
    const v1 = Buffer.alloc(128)
    latin1('TAG').copy(v1, 0)
    latin1('Übermensch Title').copy(v1, 3)
    latin1('V1 Artist  ').copy(v1, 33)
    latin1('V1 Album').copy(v1, 63)
    latin1('2003').copy(v1, 93)
    latin1('v1 comment').copy(v1, 97)
    v1[125] = 0
    v1[126] = 4 // ID3v1.1 track
    v1[127] = 17 // Rock
    writeFileSync(out('id3v1_only.mp3'), Buffer.concat([readFileSync(rawMono), v1]))

    // 6. CBR MP3 without a Xing/Info frame (duration from size + bitrate), tagged by the desktop.
    ffmpeg([...sine(3), '-ac', '2', '-c:a', 'libmp3lame', '-b:a', '128k', '-write_xing', '0', out('cbr_noxing.mp3')])
    writeTags(out('cbr_noxing.mp3'), { title: 'CBR', artist: 'AC/DC', albumartist: 'AC/DC', composer: 'Young/Young', rating: 1 })

    // 7. VBR MP3 with a Xing frame count (LAME VBR), tagged by the desktop.
    ffmpeg([...sine(3), '-ac', '2', '-c:a', 'libmp3lame', '-q:a', '4', out('vbr_xing.mp3')])
    writeTags(out('vbr_xing.mp3'), { title: 'VBR', artist: 'Tester', rating: 2 })

    // 8. FLAC with Vorbis comments and a PNG PICTURE block.
    ffmpeg([...sine(1), '-ac', '2', '-c:a', 'flac', '-sample_fmt', 's16', out('desktop.flac')])
    writeTags(out('desktop.flac'), { ...CORE, rating: 5, compilation: true }, { artwork: artPng })

    // 9. Ogg Opus (METADATA_BLOCK_PICTURE comment).
    ffmpeg([...sine(1, 48000), '-ac', '2', '-c:a', 'libopus', '-b:a', '64k', out('desktop.opus')])
    writeTags(out('desktop.opus'), { ...CORE, rating: 2 }, { artwork: art })

    // 10. Ogg Vorbis.
    ffmpeg([...sine(1), '-ac', '2', '-c:a', 'libvorbis', '-q:a', '2', out('desktop.ogg')])
    writeTags(out('desktop.ogg'), { ...CORE, rating: 3 }, { artwork: art })

    // 11. M4A AAC with iTunes freeform atoms and covr.
    ffmpeg([...sine(1), '-ac', '2', '-c:a', 'aac', '-b:a', '96k', out('desktop_aac.m4a')])
    writeTags(out('desktop_aac.m4a'), { ...CORE, rating: 3, compilation: true }, { artwork: art })

    // 12. M4A ALAC.
    ffmpeg([...sine(1), '-ac', '2', '-c:a', 'alac', '-sample_fmt', 's16p', out('desktop_alac.m4a')])
    writeTags(out('desktop_alac.m4a'), { title: 'ALAC', artist: 'Tester', album: 'Lossless', tracknumber: 1, totaltracks: 2, rating: 5 })

    // 13-14. WAV / AIFF (basic info only).
    ffmpeg([...sine(0.5), '-ac', '2', '-c:a', 'pcm_s16le', out('pcm.wav')])
    ffmpeg([...sine(0.5), '-ac', '1', '-c:a', 'pcm_s16be', out('pcm.aiff')])

    // Expected values: how the desktop reads each fixture.
    const expected: Record<string, unknown> = {}
    for (const name of readdirSync(OUT).sort()) {
      if (name.endsWith('.json')) continue
      const p = await probeFile(join(OUT, name), { covers: true })
      expected[name] = {
        tags: p.tags,
        format: p.format,
        tagTypes: p.tagTypes,
        picture: p.picture
          ? { mime: p.picture.mime, length: p.picture.data.length, sha256: createHash('sha256').update(p.picture.data).digest('hex') }
          : null,
      }
    }
    writeFileSync(join(OUT, 'expected.json'), JSON.stringify(expected, null, 2) + '\n')
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
})
