// Loose-file heuristics: tag sanity, title clean-up, mojibake repair, folder/filename parsing.

import type { TrackTags } from '@shared/types'
import { cleanText, matchKey } from '@shared/sanitize'
import { strSim } from './util'

// ---------- cleanTitle ----------

const EXPLICIT_MARKS = [/\s*\u{1F174}️?/gu, /\s*[([]\s*explicit(?:\s+version)?\s*[)\]]/gi, /\s*\[E\]\s*$/g]
const TITLE_JUNK = [
  /\s*[([]\s*official\s+(?:music\s+)?(?:video|audio)\s*[)\]]/gi,
  /\s*[([]\s*(?:official\s+)?lyrics?\s+video\s*[)\]]/gi,
  /\s*[([]\s*lyrics?\s*[)\]]/gi,
  /\s*[([]\s*(?:official\s+)?visuali[sz]er\s*[)\]]/gi,
  /\s*[([]\s*(?:hq|hd)\s*[)\]]/gi,
  /\s*[([]\s*free\s+download\s*[)\]]/gi,
]
const YT_ID = /\s*\[([A-Za-z0-9_-]{11})\]/g
const looksLikeYtId = (id: string) => /[0-9_-]/.test(id) || ((id.match(/[A-Z]/g)?.length ?? 0) >= 2 && (id.match(/[a-z]/g)?.length ?? 0) >= 2)

export function cleanTitle(title: string): { title: string; explicit: boolean } {
  let t = cleanText(title)
  let explicit = false
  for (const re of EXPLICIT_MARKS) {
    const next = t.replace(re, '')
    if (next !== t) { explicit = true; t = next }
  }
  for (const re of TITLE_JUNK) t = t.replace(re, '')
  t = t.replace(YT_ID, (m, id: string) => (looksLikeYtId(id) ? '' : m))
  t = cleanText(t).replace(/\s*[-–|]\s*$/, '')
  return { title: t || cleanText(title), explicit }
}

// ---------- fixMojibake ----------

const CP1252: Record<number, number> = {
  0x20ac: 0x80, 0x201a: 0x82, 0x0192: 0x83, 0x201e: 0x84, 0x2026: 0x85, 0x2020: 0x86, 0x2021: 0x87, 0x02c6: 0x88,
  0x2030: 0x89, 0x0160: 0x8a, 0x2039: 0x8b, 0x0152: 0x8c, 0x017d: 0x8e, 0x2018: 0x91, 0x2019: 0x92, 0x201c: 0x93,
  0x201d: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97, 0x02dc: 0x98, 0x2122: 0x99, 0x0161: 0x9a, 0x203a: 0x9b,
  0x0153: 0x9c, 0x017e: 0x9e, 0x0178: 0x9f,
}
const CONT_CLASS = '\\u0080-\\u00BF\\u20AC\\u201A\\u0192\\u201E\\u2026\\u2020\\u2021\\u02C6\\u2030\\u0160\\u2039\\u0152\\u017D\\u2018\\u2019\\u201C\\u201D\\u2022\\u2013\\u2014\\u02DC\\u2122\\u0161\\u203A\\u0153\\u017E\\u0178'
const SUSPICIOUS = new RegExp(`[\\u00C2-\\u00F4][${CONT_CLASS}]`, 'g')
const RUN = new RegExp(`[\\u00C2-\\u00F4][${CONT_CLASS}]+`, 'g')

const toByte = (ch: string): number => {
  const c = ch.codePointAt(0)!
  return c < 0x100 ? c : (CP1252[c] ?? -1)
}

/** Decodes valid UTF-8 byte sequences inside a latin1/cp1252 run, leaving other chars as-is. */
function decodeRun(run: string): string {
  const chars = Array.from(run)
  const bytes = chars.map(toByte)
  let out = ''
  for (let i = 0; i < bytes.length; ) {
    const b = bytes[i]
    const len = b >= 0xc2 && b <= 0xdf ? 2 : b >= 0xe0 && b <= 0xef ? 3 : b >= 0xf0 && b <= 0xf4 ? 4 : 0
    if (len && i + len <= bytes.length && bytes.slice(i + 1, i + len).every((x) => x >= 0x80 && x <= 0xbf)) {
      try {
        out += new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(bytes.slice(i, i + len)))
        i += len
        continue
      } catch {
        // fall through
      }
    }
    out += chars[i]
    i++
  }
  return out
}

const suspicious = (s: string) => s.match(SUSPICIOUS)?.length ?? 0

/** Repairs UTF-8 text that was decoded as latin1/cp1252 ("CafÃ©" → "Café"), only when it helps. */
export function fixMojibake(s: string): string {
  if (!s) return s
  let cur = s
  for (let pass = 0; pass < 2; pass++) {
    const before = suspicious(cur)
    if (!before) break
    const next = cur.replace(RUN, decodeRun)
    if (suspicious(next) >= before) break
    cur = next
  }
  return cur
}

// ---------- garbage detection ----------

const URLISH = /https?:\/\/|\bwww\.\w/i
const GARBAGE: Partial<Record<keyof TrackTags, RegExp>> = {
  title: /^(?:track|piste|pista|titel|audio\s*track|audiotrack)\s*#?\s*\d*$|^unknown\s+(?:title|track)$|^<unknown>$/i,
  artist: /^(?:unknown(?:\s+artist)?|<unknown>|artist|no artist|unbekannter künstler|artiste inconnu|artista desconocido)$/i,
  albumartist: /^(?:unknown(?:\s+artist)?|<unknown>|artist|no artist)$/i,
  album: /^(?:unknown(?:\s+album)?|<unknown>|album|no album|untitled album)$/i,
}

export function isGarbageValue(field: keyof TrackTags, v: unknown): boolean {
  if (typeof v !== 'string') return false
  const s = cleanText(v)
  if (!s) return true
  if (URLISH.test(s)) return true
  return GARBAGE[field]?.test(s) ?? false
}

const TEXT_FIELDS: Array<keyof TrackTags> = ['title', 'artist', 'album', 'albumartist', 'artistsort', 'albumartistsort', 'titlesort', 'albumsort', 'genre', 'label', 'comment', 'copyright', 'catalognumber']

/** Mojibake repair, title clean-up and garbage removal for one file's tags. */
export function sanitizeTags(tags: TrackTags): TrackTags {
  const t: TrackTags = { ...tags }
  const rec = t as Record<string, unknown>
  for (const k of TEXT_FIELDS) {
    const v = rec[k]
    if (typeof v !== 'string') continue
    const fixed = cleanText(fixMojibake(v))
    if (!fixed || isGarbageValue(k, fixed)) delete rec[k]
    else rec[k] = fixed
  }
  for (const k of ['artists', 'albumartists'] as const) {
    const v = t[k]
    if (!Array.isArray(v)) continue
    const fixed = v.map((x) => cleanText(fixMojibake(x))).filter((x) => x && !isGarbageValue('artist', x))
    if (fixed.length) t[k] = fixed
    else delete t[k]
  }
  if (t.title) {
    const c = cleanTitle(t.title)
    t.title = c.title
    if (c.explicit) t.explicit = true
  }
  return t
}

// ---------- folder parsing ----------

const JUNK_TOKEN = /^(?:flac|mp3|aac|alac|ogg|opus|wav|aiff?|m4a|web|web-?dl|webrip|cd|cdr|cdrip|vinyl|lp|vbr|cbr|\d{3}(?:k|kbps)?|v[0-2]|\d{2}-\d{2,3}(?:[.,]\d)?|\d{2}\s?bits?|\d{2,3}(?:[.,]\d)?\s?khz|hi-?res|lossless|kbps|khz|bits?|24|16|mqa|dsd|sacd|remux)$/i
const YEAR = '((?:19|20)\\d{2})'

/** Scene-style "Artist_Name-Album_Title-(CAT01)-WEB-2019-GROUP" → "Artist Name - Album Title (2019)". */
function sceneName(s: string): string {
  if (/\s/.test(s) || s.split('-').length < 3) return s
  const toks = s.split('-')
  if (/^[A-Z0-9]{2,12}$/.test(toks[toks.length - 1]) && /[A-Z]/.test(toks[toks.length - 1])) toks.pop()
  const year = toks.findIndex((t, i) => i > 0 && /^(?:19|20)\d{2}$/.test(t))
  const y = year > 0 ? toks.splice(year, 1)[0] : undefined
  const keep = toks.filter((t, i) => i === 0 || !(JUNK_TOKEN.test(t) || /^\(.*\)$/.test(t)))
  if (keep.length < 2) return s
  const sp = (t: string) => t.replace(/[_.]/g, ' ').trim()
  return `${sp(keep[0])} - ${keep.slice(1).map(sp).join(' ')}${y ? ` (${y})` : ''}`
}

function stripFolderJunk(name: string): string {
  let s = sceneName(cleanText(name))
  s = s.replace(/\s*[[(]?\s*www\.[^\s\])]+\s*[\])]?/gi, ' ')
  s = s.replace(/\s*\{[^}]*\}/g, ' ')
  s = s.replace(/\s*[[(]([^\])]*)[\])]/g, (m, inner: string) => {
    const toks = inner.split(/[\s,_+/|]+/).filter(Boolean)
    return toks.length && toks.every((x) => JUNK_TOKEN.test(x)) ? ' ' : m
  })
  s = cleanText(s)
  s = /\s/.test(s) ? dropSubst(s) : s.replace(/_/g, ' ')
  s = s.replace(/(?<=\S)-[A-Z0-9]{2,12}$/, (m) => (/[A-Z]/.test(m) && s.split('-').length > 2 ? '' : m))
  return cleanText(s).replace(/\s*[-–]\s*$/, '')
}

const GENERIC_FOLDER = /^(?:music|my music|downloads?|desktop|documents|albums?|loose|singles|misc|various|new folder( \(\d+\))?|unknown|unsorted|incoming|import|rips?|mp3s?|flac|audio|songs|tracks|test-data|real|staging|inbox|tmp|temp)$/i

export interface FolderInfo { artist?: string; album?: string; year?: string; strong: boolean }

const plausibleYear = (y: string) => Number(y) >= 1900 && Number(y) <= new Date().getFullYear() + 1

/** Parses an album folder name ("Artist - Album (Year)", "[Year] Album", …); parent folder is the fallback artist. */
export function parseAlbumFolder(name: string | undefined, parent: string | undefined, knownArtists: string[] = []): FolderInfo {
  const par = parent && !GENERIC_FOLDER.test(cleanText(parent)) ? stripFolderJunk(parent) : undefined
  if (!name || GENERIC_FOLDER.test(cleanText(name))) return par ? { artist: par, strong: false } : { strong: false }
  const s = stripFolderJunk(name)
  const tries: Array<[RegExp, (m: RegExpExecArray) => FolderInfo]> = [
    [new RegExp(`^(.+?)\\s+-\\s+${YEAR}\\s+-\\s+(.+)$`), (m) => ({ artist: m[1], year: m[2], album: m[3], strong: true })],
    [new RegExp(`^(.+?)\\s+-\\s+(.+?)\\s*[([]${YEAR}[)\\]]$`), (m) => ({ artist: m[1], album: m[2], year: m[3], strong: true })],
    [new RegExp(`^[([]${YEAR}[)\\]]\\s*[-–.]?\\s*(.+)$`), (m) => ({ artist: par, year: m[1], album: m[2], strong: true })],
    [new RegExp(`^${YEAR}\\s+[-–]\\s+(.+)$`), (m) => ({ artist: par, year: m[1], album: m[2], strong: true })],
    [new RegExp(`^(.+?)\\s*[([]${YEAR}[)\\]]$`), (m) => ({ artist: par, album: m[1], year: m[2], strong: true })],
  ]
  for (const [re, f] of tries) {
    const m = re.exec(s)
    if (m) {
      const info = f(m)
      if (info.year && !plausibleYear(info.year)) continue
      return { ...info, artist: info.artist ? cleanText(info.artist) : undefined, album: info.album ? cleanText(info.album) : undefined }
    }
  }
  const dash = /^(.+?)\s+-\s+(.+)$/.exec(s)
  if (dash) {
    const a = dash[1]
    const known = [par, ...knownArtists].filter(Boolean) as string[]
    if (known.some((k) => strSim(k, a) >= 0.9)) return { artist: cleanText(a), album: cleanText(dash[2]), strong: true }
  }
  return { artist: par, album: s, strong: false }
}

// ---------- filename parsing ----------

export interface FileParse {
  title: string
  artist?: string
  tracknumber?: number
  discnumber?: number
  /** Parse shape, compared across the cluster for track-number plausibility. */
  kind: string
}

const DISC_TRACK = /^(\d)[-.](\d{2})(?:\s*[-–.)_]\s*|\s+)(.+)$/
const NUM_REST = /^(\d{1,3})(\s*[-–.)_]\s*|\s+)(.+)$/
const SEP_KIND = (sep: string) => (/[-–]/.test(sep) ? 'dash' : sep.includes('.') ? 'dot' : sep.includes(')') ? 'paren' : sep.includes('_') ? 'us' : 'space')

/** Underscores standing in for illegal characters ("Lofi_ Gravity Falls", "come from_") are dropped. */
const dropSubst = (s: string) => cleanText(s.replace(/_(?=\s|$)/g, ''))

/** Filename stem → title/artist/number candidates. `acceptArtist` decides whether "X - Title" names an artist. */
export function parseFilename(stem: string, acceptArtist: (a: string) => boolean, numbers = true): FileParse {
  let s = cleanText(stem)
  s = /\s/.test(s) ? dropSubst(s) : s.replace(/_/g, ' ').trim()
  const splitArtist = (rest: string): { artist?: string; title: string } => {
    const m = /^(.+?)\s+[-–]\s+(.+)$/.exec(rest)
    if (m && acceptArtist(m[1])) return { artist: cleanText(m[1]), title: m[2] }
    return { title: rest }
  }
  // Known artist prefix wins over a leading number ("3 Doors Down - Kryptonite").
  const pre = /^(.+?)\s+[-–]\s+(.+)$/.exec(s)
  if (pre && /^\d/.test(s) && acceptArtist(pre[1])) return { artist: cleanText(pre[1]), title: cleanText(pre[2]), kind: 'artist' }
  if (!numbers) {
    const r = splitArtist(s)
    return { ...r, title: cleanText(r.title), kind: r.artist ? 'artist' : 'plain' }
  }
  let m = DISC_TRACK.exec(s)
  if (m) {
    const r = splitArtist(m[3])
    return { ...r, title: cleanText(r.title), discnumber: Number(m[1]), tracknumber: Number(m[2]), kind: 'disc' }
  }
  m = NUM_REST.exec(s)
  if (m) {
    const r = splitArtist(m[3])
    return { ...r, title: cleanText(r.title), tracknumber: Number(m[1]), kind: `num:${SEP_KIND(m[2])}` }
  }
  const r = splitArtist(s)
  return { ...r, title: cleanText(r.title), kind: r.artist ? 'artist' : 'plain' }
}

// ---------- clustering ----------

export interface LooseFile { relPath: string; tags: TrackTags; durationMs: number }

const DISC_DIR = /^(?:cd|dis[ck]|part)\s*0*(\d+)\b/i

function splitPath(relPath: string): { dirs: string[]; file: string; stem: string } {
  const parts = relPath.split(/[\\/]+/).filter(Boolean)
  const file = parts.pop() ?? ''
  const dot = file.lastIndexOf('.')
  return { dirs: parts, file, stem: dot > 0 ? file.slice(0, dot) : file }
}

/** Album folder (disc subfolders merged into their parent) and the disc number they imply. */
function albumDir(dirs: string[]): { key: string; dirs: string[]; disc?: number } {
  const last = dirs[dirs.length - 1]
  const m = last ? DISC_DIR.exec(cleanText(last)) : null
  if (m && dirs.length > 1) return { key: dirs.slice(0, -1).join('/'), dirs: dirs.slice(0, -1), disc: Number(m[1]) }
  return { key: dirs.join('/'), dirs }
}

/** Groups files by album folder; a folder is split by album tag only when ≥ 2 albums each have ≥ 2 files. */
export function clusterFiles(files: Array<{ relPath: string; tags: TrackTags }>): number[][] {
  const byDir = new Map<string, number[]>()
  files.forEach((f, i) => {
    const { key } = albumDir(splitPath(f.relPath).dirs)
    byDir.set(key, [...(byDir.get(key) ?? []), i])
  })
  const out: number[][] = []
  for (const idx of byDir.values()) {
    const byAlbum = new Map<string, number[]>()
    for (const i of idx) {
      const k = matchKey(fixMojibake(files[i].tags.album ?? ''))
      byAlbum.set(k, [...(byAlbum.get(k) ?? []), i])
    }
    const big = [...byAlbum.entries()].filter(([k, v]) => k && v.length >= 2)
    if (big.length < 2) { out.push(idx); continue }
    for (const [k, v] of byAlbum) {
      if (k && v.length >= 2) out.push(v)
      else for (const i of v) out.push([i])
    }
  }
  return out
}

// ---------- inferLooseCluster ----------

const ID3V1_LEN = 30

function untruncate(tagValue: string | undefined, candidate: string | undefined): string | undefined {
  if (!tagValue || !candidate || tagValue.length !== ID3V1_LEN) return tagValue
  const a = matchKey(tagValue)
  const b = matchKey(candidate)
  return b.length > a.length && b.startsWith(a) ? candidate : tagValue
}

/**
 * Per-file best-guess tags for loose files: sanitized existing tags (mojibake, garbage, title junk)
 * with gaps filled from folder and filename patterns. Files are clustered with `clusterFiles`.
 */
export function inferLooseCluster(files: LooseFile[]): TrackTags[] {
  const out: TrackTags[] = files.map((f) => sanitizeTags(f.tags))
  for (const cluster of clusterFiles(files)) inferCluster(files, out, cluster)
  return out
}

function inferCluster(files: LooseFile[], out: TrackTags[], idx: number[]): void {
  const paths = idx.map((i) => splitPath(files[i].relPath))
  const ad = albumDir(paths[0].dirs)
  const discs = paths.map((p) => albumDir(p.dirs).disc)
  const tagArtists = idx.flatMap((i) => [out[i].albumartist, out[i].artist]).filter(Boolean) as string[]
  const folderName = ad.dirs[ad.dirs.length - 1]
  const parentName = ad.dirs[ad.dirs.length - 2]
  const folder = parseAlbumFolder(folderName, parentName, tagArtists)
  const multiFolder = idx.length < files.filter((f) => albumDir(splitPath(f.relPath).dirs).key === ad.key).length

  // Artist prefixes shared by ≥ 2 files of the cluster count as artists.
  const prefixCount = new Map<string, number>()
  for (const p of paths) {
    const m = /^(?:\d{1,3}\s*[-–.)_]?\s*)?(.+?)\s+[-–]\s+.+$/.exec(cleanText(p.stem))
    if (m) prefixCount.set(matchKey(m[1]), (prefixCount.get(matchKey(m[1])) ?? 0) + 1)
  }
  const accepts = idx.map((i) => {
    const t = out[i]
    const known = [folder.artist, t.artist, t.albumartist, ...(t.artists ?? [])].filter(Boolean) as string[]
    return (a: string) => known.some((k) => strSim(k, a) >= 0.9) || (idx.length > 1 && (prefixCount.get(matchKey(a)) ?? 0) >= 2)
  })
  const raw = idx.map((_, n) => parseFilename(paths[n].stem, accepts[n]))

  // Track-number plausibility: dominant parse shape ≥ 70 %, unique numbers within 1..N+2.
  const kinds = new Map<string, number>()
  for (const p of raw) if (p.tracknumber !== undefined) kinds.set(p.kind, (kinds.get(p.kind) ?? 0) + 1)
  const [domKind, domCount] = [...kinds.entries()].sort((a, b) => b[1] - a[1])[0] ?? ['', 0]
  const maxTotal = Math.max(idx.length, ...idx.map((i) => out[i].totaltracks ?? 0))
  const dom = raw.map((p, n) => ({ p, n })).filter(({ p }) => p.kind === domKind)
  const domNums = dom.map(({ p, n }) => `${p.discnumber ?? discs[n] ?? 1}:${p.tracknumber}`)
  const clusterOk = domCount / idx.length >= 0.7 && new Set(domNums).size === domNums.length && dom.every(({ p }) => p.tracknumber! >= 1 && p.tracknumber! <= maxTotal + 2)
  // A rejected number belongs to the title ("99 Problems", "22", "1979").
  const parses = raw.map((p, n) => {
    if (p.tracknumber === undefined) return p
    if ((clusterOk && p.kind === domKind) || files[idx[n]].tags.tracknumber === p.tracknumber) return p
    return parseFilename(paths[n].stem, accepts[n], false)
  })

  // Cluster consensus album / albumartist / date (only when the cluster agrees).
  const albums = new Set(idx.map((i) => matchKey(out[i].album)).filter(Boolean))
  const firstWith = <K extends keyof TrackTags>(k: K) => idx.map((i) => out[i][k]).find((v) => v !== undefined)
  const consensusAlbum = albums.size === 1 ? firstWith('album') : undefined
  const consensusAA = consensusAlbum ? firstWith('albumartist') : undefined
  const consensusDate = consensusAlbum ? firstWith('date') : undefined
  const artistMatch = !!folder.artist && tagArtists.some((a) => strSim(a, folder.artist) >= 0.9)
  const useFolder = !multiFolder && !!folder.album && (folder.strong || idx.length >= 2 || artistMatch)

  idx.forEach((i, n) => {
    const t = out[i]
    const p = parses[n]
    const fileName = paths[n].file
    const parsedTitle = cleanTitle(p.title)
    // Title that is just the filename (with extension, or with a number/artist prefix) is garbage.
    if (t.title && (matchKey(t.title) === matchKey(fileName) || (matchKey(t.title) === matchKey(paths[n].stem) && p.kind !== 'plain'))) delete t.title
    t.title = untruncate(t.title, parsedTitle.title)
    if (!t.title && parsedTitle.title) {
      t.title = parsedTitle.title
      if (parsedTitle.explicit) t.explicit = true
    }
    if (!t.artist) t.artist = p.artist ?? t.albumartist ?? (useFolder ? folder.artist : undefined)
    if (!t.album) t.album = consensusAlbum ?? (useFolder ? folder.album : undefined)
    else if (useFolder) t.album = untruncate(t.album, folder.album)
    if (!t.albumartist && t.album) t.albumartist = consensusAA ?? (useFolder ? folder.artist : undefined)
    if (!t.date) t.date = consensusDate ?? (useFolder ? folder.year : undefined)
    if (t.tracknumber === undefined && p.tracknumber !== undefined) t.tracknumber = p.tracknumber
    if (t.discnumber === undefined) t.discnumber = discs[n] ?? (t.tracknumber === p.tracknumber ? p.discnumber : undefined)
    for (const k of Object.keys(t) as Array<keyof TrackTags>) if (t[k] === undefined) delete t[k]
  })
}
