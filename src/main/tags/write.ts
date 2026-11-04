// Tag writer (node-taglib-sharp). MP3 gets ID3v2.3 UTF-16 (best Android/Windows compatibility),
// FLAC/Ogg/Opus get Vorbis comments, M4A gets iTunes atoms. Field naming follows Picard.

import {
  ByteVector,
  File,
  Id3v2AttachmentFrame,
  Id3v2CommentsFrame,
  Id3v2FrameClassType,
  Id3v2FrameIdentifiers,
  Id3v2PopularimeterFrame,
  Id3v2Settings,
  Id3v2Tag,
  Id3v2UniqueFileIdentifierFrame,
  Id3v2UnsynchronizedLyricsFrame,
  Id3v2UserTextInformationFrame,
  Mpeg4AppleTag,
  Picture,
  PictureType,
  StringType,
  TagTypes,
  XiphComment,
  type Id3v2Frame,
  type IPicture,
} from 'node-taglib-sharp'
import type { TrackTags } from '@shared/types'
import { CUSTOM_FIELDS, MULTI_SEP, POPM_EMAIL, RG_FIELDS, formatGain, formatPeak, starsToPopm } from '@shared/tag-schema'
import './taglib-io'

Id3v2Settings.defaultVersion = 3
Id3v2Settings.forceDefaultVersion = true
Id3v2Settings.defaultEncoding = StringType.UTF16
Id3v2Settings.forceDefaultEncoding = true
Id3v2Settings.useNumericGenres = false

export interface ArtworkInput {
  data: Buffer
  mime: string
}

export interface WriteOptions {
  /** Replace embedded art; `null` removes it; undefined leaves it untouched. */
  artwork?: ArtworkInput | null
  /** Remove every existing tag first (fresh import). Default true. */
  clean?: boolean
}

type Kind = 'mp3' | 'flac' | 'ogg' | 'mp4' | 'other'

function kindOf(path: string): Kind {
  const ext = path.toLowerCase().split('.').pop()
  if (ext === 'mp3') return 'mp3'
  if (ext === 'flac') return 'flac'
  if (ext === 'ogg' || ext === 'opus' || ext === 'oga') return 'ogg'
  if (ext === 'm4a' || ext === 'mp4' || ext === 'aac' || ext === 'alac') return 'mp4'
  return 'other'
}

const str = (v: unknown): string | undefined => (v === undefined || v === null || v === '' ? undefined : String(v))

function gainStr(tags: TrackTags, key: keyof TrackTags): string | undefined {
  const v = tags[key] as number | undefined
  if (v === undefined || v === null || !Number.isFinite(v)) return undefined
  return key.endsWith('peak') ? formatPeak(v) : formatGain(v)
}

function customValue(tags: TrackTags, key: keyof TrackTags): string | undefined {
  const v = tags[key]
  if (Array.isArray(v)) return v.length ? v.join(MULTI_SEP) : undefined
  return str(v)
}

function makePicture(art: ArtworkInput): IPicture {
  const pic = Picture.fromData(ByteVector.fromByteArray(art.data))
  pic.type = PictureType.FrontCover
  pic.mimeType = art.mime
  pic.description = ''
  return pic
}

// ---------------------------------------------------------------- ID3v2.3

function id3Text(tag: Id3v2Tag, id: string, value: string | undefined): void {
  const ident = Id3v2FrameIdentifiers[id]
  tag.removeFrames(ident)
  if (value !== undefined) tag.setTextFrame(ident, value)
}

function id3Txxx(tag: Id3v2Tag, desc: string, value: string | undefined): void {
  const frames = tag.getFramesByClassType<Id3v2UserTextInformationFrame>(Id3v2FrameClassType.UserTextInformationFrame)
  for (const f of frames) if (f.description.toLowerCase() === desc.toLowerCase()) tag.removeFrame(f as unknown as Id3v2Frame)
  if (value === undefined) return
  const f = Id3v2UserTextInformationFrame.fromDescription(desc, StringType.UTF16)
  f.text = [value]
  tag.addFrame(f)
}

function numPair(n?: number, total?: number): string | undefined {
  if (!n) return undefined
  return total ? `${n}/${total}` : String(n)
}

function writeId3(tag: Id3v2Tag, t: TrackTags): void {
  id3Text(tag, 'TIT2', str(t.title))
  id3Text(tag, 'TPE1', str(t.artist))
  id3Text(tag, 'TALB', str(t.album))
  id3Text(tag, 'TPE2', str(t.albumartist))
  id3Text(tag, 'TSO2', str(t.albumartistsort))
  id3Text(tag, 'TRCK', numPair(t.tracknumber, t.totaltracks))
  id3Text(tag, 'TPOS', numPair(t.discnumber, t.totaldiscs))
  // ID3v2.3 dates: TYER = YYYY, TDAT = DDMM; TORY = original year.
  const d = t.date?.match(/^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?/)
  id3Text(tag, 'TYER', d?.[1])
  id3Text(tag, 'TDAT', d?.[2] && d?.[3] ? `${d[3]}${d[2]}` : undefined)
  id3Text(tag, 'TDOR', t.originaldate?.slice(0, 4)) // rendered as TORY in v2.3
  id3Text(tag, 'TCON', str(t.genre))
  id3Text(tag, 'TCMP', t.compilation ? '1' : undefined)
  id3Text(tag, 'TSRC', str(t.isrc))
  id3Text(tag, 'TPUB', str(t.label))
  id3Text(tag, 'TCOP', str(t.copyright))
  id3Text(tag, 'TCOM', str(t.composer))
  id3Text(tag, 'TBPM', t.bpm ? String(Math.round(t.bpm)) : undefined)
  id3Text(tag, 'TKEY', str(t.key))
  id3Text(tag, 'TMED', str(t.media))

  for (const [key, desc] of CUSTOM_FIELDS) id3Txxx(tag, desc, customValue(t, key))
  for (const [key, name] of RG_FIELDS) id3Txxx(tag, name, gainStr(t, key))
  id3Txxx(tag, 'ITUNESADVISORY', t.explicit ? '1' : undefined)

  // Comment
  tag.removeFrames(Id3v2FrameIdentifiers.COMM)
  if (t.comment) {
    const c = Id3v2CommentsFrame.fromDescription('', 'eng', StringType.UTF16)
    c.text = t.comment
    tag.addFrame(c)
  }

  // MusicBrainz recording id lives in UFID (Picard convention).
  for (const f of tag.getFramesByClassType<Id3v2UniqueFileIdentifierFrame>(Id3v2FrameClassType.UniqueFileIdentifierFrame)) {
    if (f.owner === 'http://musicbrainz.org') tag.removeFrame(f as unknown as Id3v2Frame)
  }
  if (t.musicbrainz_recordingid) {
    tag.addFrame(Id3v2UniqueFileIdentifierFrame.fromData('http://musicbrainz.org', ByteVector.fromString(t.musicbrainz_recordingid, StringType.Latin1)))
  }

  // Lyrics: LRC text when synced (Android players parse it from USLT), else plain.
  tag.removeFrames(Id3v2FrameIdentifiers.USLT)
  if (t.lyrics) {
    const l = Id3v2UnsynchronizedLyricsFrame.fromData('', 'eng', StringType.UTF16)
    l.text = t.lyrics
    tag.addFrame(l)
  }

  // Rating
  for (const f of tag.getFramesByClassType<Id3v2PopularimeterFrame>(Id3v2FrameClassType.PopularimeterFrame)) tag.removeFrame(f as unknown as Id3v2Frame)
  if (t.rating) {
    const p = Id3v2PopularimeterFrame.fromUser(POPM_EMAIL)
    p.rating = starsToPopm(t.rating)
    tag.addFrame(p)
  }
}

function writeId3Art(tag: Id3v2Tag, art: ArtworkInput | null): void {
  tag.removeFrames(Id3v2FrameIdentifiers.APIC)
  if (art) {
    const f = Id3v2AttachmentFrame.fromPicture(makePicture(art))
    f.textEncoding = StringType.Latin1
    tag.addFrame(f)
  }
}

// ---------------------------------------------------------------- Vorbis

function vSet(x: XiphComment, key: string, value: string | string[] | undefined): void {
  x.removeField(key)
  if (value === undefined) return
  const arr = (Array.isArray(value) ? value : [value]).filter((s) => s !== '')
  if (arr.length) x.setFieldAsStrings(key, ...arr)
}

function writeVorbis(x: XiphComment, t: TrackTags): void {
  vSet(x, 'TITLE', str(t.title))
  vSet(x, 'ARTIST', str(t.artist))
  vSet(x, 'ARTISTS', t.artists)
  vSet(x, 'ALBUM', str(t.album))
  vSet(x, 'ALBUMARTIST', str(t.albumartist))
  vSet(x, 'ARTISTSORT', str(t.artistsort))
  vSet(x, 'ALBUMARTISTSORT', str(t.albumartistsort))
  vSet(x, 'TITLESORT', str(t.titlesort))
  vSet(x, 'ALBUMSORT', str(t.albumsort))
  vSet(x, 'TRACKNUMBER', t.tracknumber ? String(t.tracknumber) : undefined)
  vSet(x, 'TRACKTOTAL', t.totaltracks ? String(t.totaltracks) : undefined)
  vSet(x, 'TOTALTRACKS', t.totaltracks ? String(t.totaltracks) : undefined)
  vSet(x, 'DISCNUMBER', t.discnumber ? String(t.discnumber) : undefined)
  vSet(x, 'DISCTOTAL', t.totaldiscs ? String(t.totaldiscs) : undefined)
  vSet(x, 'TOTALDISCS', t.totaldiscs ? String(t.totaldiscs) : undefined)
  vSet(x, 'DATE', str(t.date))
  vSet(x, 'ORIGINALDATE', str(t.originaldate))
  vSet(x, 'ORIGINALYEAR', t.originaldate?.slice(0, 4))
  vSet(x, 'GENRE', str(t.genre))
  vSet(x, 'COMPILATION', t.compilation ? '1' : undefined)
  vSet(x, 'ISRC', str(t.isrc))
  vSet(x, 'BARCODE', str(t.barcode))
  vSet(x, 'LABEL', str(t.label))
  vSet(x, 'CATALOGNUMBER', str(t.catalognumber))
  vSet(x, 'COPYRIGHT', str(t.copyright))
  vSet(x, 'COMPOSER', str(t.composer))
  vSet(x, 'BPM', t.bpm ? String(Math.round(t.bpm)) : undefined)
  vSet(x, 'KEY', str(t.key))
  vSet(x, 'COMMENT', str(t.comment))
  vSet(x, 'MEDIA', str(t.media))
  vSet(x, 'MUSICBRAINZ_TRACKID', str(t.musicbrainz_recordingid))
  vSet(x, 'MUSICBRAINZ_RELEASETRACKID', str(t.musicbrainz_trackid))
  vSet(x, 'MUSICBRAINZ_ALBUMID', str(t.musicbrainz_albumid))
  vSet(x, 'MUSICBRAINZ_RELEASEGROUPID', str(t.musicbrainz_releasegroupid))
  vSet(x, 'MUSICBRAINZ_ARTISTID', t.musicbrainz_artistid)
  vSet(x, 'MUSICBRAINZ_ALBUMARTISTID', t.musicbrainz_albumartistid)
  vSet(x, 'RELEASETYPE', str(t.releasetype))
  vSet(x, 'RELEASESTATUS', str(t.releasestatus))
  vSet(x, 'RELEASECOUNTRY', str(t.releasecountry))
  vSet(x, 'ACOUSTID_ID', str(t.acoustid_id))
  vSet(x, 'LYRICS', str(t.lyrics))
  vSet(x, 'RATING', t.rating ? String(t.rating * 20) : undefined)
  vSet(x, 'ITUNESADVISORY', t.explicit ? '1' : undefined)
  for (const [key, name] of RG_FIELDS) vSet(x, name, gainStr(t, key))
  for (const [key, , vorbis] of CUSTOM_FIELDS) {
    if (['artists', 'catalognumber', 'barcode', 'originaldate'].includes(key)) continue
    if (key.startsWith('musicbrainz_') || key === 'releasetype' || key === 'releasestatus' || key === 'releasecountry' || key === 'acoustid_id') continue
    vSet(x, vorbis, customValue(t, key))
  }
}

// ---------------------------------------------------------------- MP4

const ITUNES = 'com.apple.iTunes'

function writeMp4(a: Mpeg4AppleTag, t: TrackTags): void {
  a.title = str(t.title) ?? ''
  a.performers = t.artist ? [t.artist] : []
  a.album = str(t.album) ?? ''
  a.albumArtists = t.albumartist ? [t.albumartist] : []
  a.albumArtistsSort = t.albumartistsort ? [t.albumartistsort] : []
  a.performersSort = t.artistsort ? [t.artistsort] : []
  a.titleSort = str(t.titlesort) ?? ''
  a.albumSort = str(t.albumsort) ?? ''
  a.track = t.tracknumber ?? 0
  a.trackCount = t.totaltracks ?? 0
  a.disc = t.discnumber ?? 0
  a.discCount = t.totaldiscs ?? 0
  a.genres = t.genre ? [t.genre] : []
  a.comment = str(t.comment) ?? ''
  a.copyright = str(t.copyright) ?? ''
  a.composers = t.composer ? [t.composer] : []
  a.beatsPerMinute = t.bpm ? Math.round(t.bpm) : 0
  a.lyrics = str(t.lyrics) ?? ''
  a.isCompilation = !!t.compilation
  a.year = t.date ? Number(t.date.slice(0, 4)) || 0 : 0
  const free = (name: string, value: string | undefined) => {
    a.setItunesStrings(ITUNES, name, ...(value === undefined ? [] : [value]))
  }
  free('ISRC', str(t.isrc))
  free('LABEL', str(t.label))
  free('MEDIA', str(t.media))
  free('initialkey', str(t.key))
  free('MusicBrainz Track Id', str(t.musicbrainz_recordingid))
  free('RATING', t.rating ? String(t.rating * 20) : undefined)
  free('ITUNESADVISORY', t.explicit ? '1' : undefined)
  for (const [key, name] of RG_FIELDS) free(name, gainStr(t, key))
  for (const [key, , , mp4] of CUSTOM_FIELDS) free(mp4, customValue(t, key))
}

// ---------------------------------------------------------------- entry point

/** Writes `tags` into the file at `path` in place. Throws on unsupported formats. */
export function writeTags(path: string, tags: TrackTags, opts: WriteOptions = {}): void {
  const kind = kindOf(path)
  if (kind === 'other') throw new Error(`Tag writing not supported for ${path}`)
  const clean = opts.clean ?? true
  const file = File.createFromPath(path)
  try {
    if (kind === 'mp3') {
      if (clean) file.removeTags(TagTypes.Id3v1 | TagTypes.Ape | TagTypes.Id3v2)
      else file.removeTags(TagTypes.Id3v1 | TagTypes.Ape)
      const tag = file.getTag(TagTypes.Id3v2, true) as Id3v2Tag
      writeId3(tag, tags)
      if (opts.artwork !== undefined) writeId3Art(tag, opts.artwork)
    } else if (kind === 'flac' || kind === 'ogg') {
      if (kind === 'flac') file.removeTags(TagTypes.Id3v1 | TagTypes.Id3v2 | TagTypes.Ape)
      const x = file.getTag(TagTypes.Xiph, true) as XiphComment
      if (clean) for (const f of [...x.fieldNames]) x.removeField(f)
      writeVorbis(x, tags)
      if (opts.artwork !== undefined) file.tag.pictures = opts.artwork ? [makePicture(opts.artwork)] : []
    } else {
      const a = file.getTag(TagTypes.Apple, true) as Mpeg4AppleTag
      if (clean) a.clear()
      writeMp4(a, tags)
      if (opts.artwork !== undefined) a.pictures = opts.artwork ? [makePicture(opts.artwork)] : []
    }
    file.save()
  } finally {
    file.dispose()
  }
}

/** Rewrites only the rating (POPM / RATING). Used for in-place rating edits. */
export function writeRating(path: string, stars: number): void {
  const kind = kindOf(path)
  const file = File.createFromPath(path)
  try {
    if (kind === 'mp3') {
      file.removeTags(TagTypes.Id3v1 | TagTypes.Ape)
      const tag = file.getTag(TagTypes.Id3v2, true) as Id3v2Tag
      for (const f of tag.getFramesByClassType<Id3v2PopularimeterFrame>(Id3v2FrameClassType.PopularimeterFrame)) tag.removeFrame(f as unknown as Id3v2Frame)
      if (stars) {
        const p = Id3v2PopularimeterFrame.fromUser(POPM_EMAIL)
        p.rating = starsToPopm(stars)
        tag.addFrame(p)
      }
    } else if (kind === 'flac' || kind === 'ogg') {
      vSet(file.getTag(TagTypes.Xiph, true) as XiphComment, 'RATING', stars ? String(stars * 20) : undefined)
    } else if (kind === 'mp4') {
      ;(file.getTag(TagTypes.Apple, true) as Mpeg4AppleTag).setItunesStrings(ITUNES, 'RATING', ...(stars ? [String(stars * 20)] : []))
    } else throw new Error(`Rating not supported for ${path}`)
    file.save()
  } finally {
    file.dispose()
  }
}
