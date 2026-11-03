// Pure parsers for the SiIvaGunner album mirrors (no I/O; fixture-tested):
//   highquality.rip/albums.html  — <h3>Album</h3><ul><li><a href="drive folder">MP3|FLAC|OGG</a>…
//   sgfr.highquality.rip/albumpage.js — the albumData list; sgfr-<id>/index.html — Drive folders, Bandcamp
//   drive.google.com/embeddedfolderview — public folder listing (no sign-in)

import { decodeEntities } from '../bandcamp/parse'
import type { HqrSgfrType } from '@shared/ipc/hqrip'

export type DriveFormat = 'flac' | 'mp3' | 'ogg'
export type DriveFolders = Partial<Record<DriveFormat, string>>

const FOLDER_RE = /drive\.google\.com\/drive\/(?:u\/\d+\/)?folders\/([A-Za-z0-9_-]{10,})/

const stripTags = (s: string) => decodeEntities(s.replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim()

/** Drive folder links in an HTML fragment, keyed by their link text (MP3 / FLAC / OGG; others ignored). */
export function driveFolderLinks(html: string): DriveFolders {
  const out: DriveFolders = {}
  for (const m of html.matchAll(/<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)) {
    const id = FOLDER_RE.exec(m[1])?.[1]
    if (!id) continue
    const label = stripTags(m[2]).toLowerCase()
    if (label === 'flac' || label === 'mp3' || label === 'ogg') out[label] ??= id
  }
  return out
}

export interface AlbumIndexEntry {
  title: string
  folders: DriveFolders
}

/** highquality.rip/albums.html → albums with at least one audio folder, in page order. */
export function parseAlbumIndex(html: string): AlbumIndexEntry[] {
  const out: AlbumIndexEntry[] = []
  for (const m of html.matchAll(/<h3[^>]*>([\s\S]*?)<\/h3>\s*<ul[^>]*>([\s\S]*?)<\/ul>/gi)) {
    const title = stripTags(m[1])
    const folders = driveFolderLinks(m[2])
    if (title && Object.keys(folders).length) out.push({ title, folders })
  }
  return out
}

export interface SgfrListEntry {
  /** "0016", "s0003", "c0004", "0017-b" */
  id: string
  title: string
  type: HqrSgfrType
}

const unquote = (s: string) => s.replace(/\\(.)/g, '$1')

/** The albumData array of sgfr.highquality.rip/albumpage.js. Title + Optional make the display title. */
export function parseSgfrList(js: string): SgfrListEntry[] {
  const out: SgfrListEntry[] = []
  const field = (src: string, name: string) => new RegExp(`\\b${name}\\s*:\\s*'((?:[^'\\\\]|\\\\.)*)'`).exec(src)?.[1]
  for (const m of js.matchAll(/\{\s*ID\s*:[\s\S]*?\}/g)) {
    const src = m[0]
    const id = field(src, 'ID')
    const title = field(src, 'Title')
    const type = field(src, 'Type')
    if (!id || !title || !/^(Album|Single|Soundtrack)$/.test(type ?? '')) continue
    const optional = field(src, 'Optional')
    out.push({ id, title: [unquote(title), optional ? unquote(optional).trim() : ''].filter(Boolean).join(' '), type: type as HqrSgfrType })
  }
  return out
}

export interface SgfrPage {
  /** Full release name from the page splash, e.g. "SGFR Arrangement Series Vol. 16 - Mahjong Bangers". */
  title: string | null
  folders: DriveFolders
  bandcampUrl: string | null
}

export function parseSgfrPage(html: string): SgfrPage {
  const splash = /<div[^>]*class="albumsplash"[^>]*>\s*<span>([\s\S]*?)<\/span>/i.exec(html)
  const bc = /href="(https:\/\/[a-z0-9-]+\.bandcamp\.com\/(?:album|track)\/[^"]+)"/i.exec(html)
  return { title: splash ? stripTags(splash[1]) || null : null, folders: driveFolderLinks(html), bandcampUrl: bc?.[1] ?? null }
}

export interface DriveEntry {
  id: string
  name: string
  folder: boolean
}

export interface DriveListing {
  title: string | null
  entries: DriveEntry[]
}

/** drive.google.com/embeddedfolderview?id=… → entries; null when the page isn't a folder listing. */
export function parseDriveFolder(html: string): DriveListing | null {
  if (!/class="flip-entries"/.test(html)) return null
  const title = /<title>([\s\S]*?)<\/title>/i.exec(html)?.[1]
  const entries: DriveEntry[] = []
  for (const m of html.matchAll(/<div class="flip-entry" id="entry-([A-Za-z0-9_-]+)"[\s\S]*?<a href="([^"]+)"[\s\S]*?<div class="flip-entry-title">([\s\S]*?)<\/div>/g)) {
    entries.push({ id: m[1], name: decodeEntities(m[3]).trim(), folder: FOLDER_RE.test(m[2]) })
  }
  return { title: title ? decodeEntities(title).trim() || null : null, entries }
}

export type DriveHtmlKind =
  | { kind: 'quota' }
  | { kind: 'captcha' }
  | { kind: 'confirm'; url: string }
  | { kind: 'missing' }
  | { kind: 'unknown' }

/**
 * An HTML answer where a file was expected. Drive serves a "can't scan for viruses" form for large
 * files (followed once), a quota page when a file was downloaded too often, and a CAPTCHA page when it
 * suspects automation — which Valence never tries to get past.
 */
export function classifyDriveHtml(html: string, base = 'https://drive.usercontent.google.com/download'): DriveHtmlKind {
  if (/captcha|unusual traffic|automated queries/i.test(html)) return { kind: 'captcha' }
  if (/quota (has been )?exceeded|too many users have (viewed|downloaded)|download quota/i.test(html)) return { kind: 'quota' }
  const form = /<form[^>]*id="download-form"[^>]*action="([^"]+)"[^>]*>([\s\S]*?)<\/form>/i.exec(html)
  if (form) {
    const url = new URL(decodeEntities(form[1]), base)
    for (const inp of form[2].matchAll(/<input[^>]*type="hidden"[^>]*>/gi)) {
      const name = /name="([^"]+)"/.exec(inp[0])?.[1]
      const value = /value="([^"]*)"/.exec(inp[0])?.[1]
      if (name) url.searchParams.set(name, decodeEntities(value ?? ''))
    }
    return { kind: 'confirm', url: url.toString() }
  }
  if (/not found|does not exist|no longer available|404/i.test(html)) return { kind: 'missing' }
  return { kind: 'unknown' }
}

const AUDIO = /\.(flac|mp3|ogg|oga|opus|m4a|wav|aiff?)$/i
const IMAGE = /\.(png|jpe?g|gif|webp)$/i
const JUNK = /^(desktop\.ini|thumbs\.db|\.ds_store)$|\.ini$/i

export function driveFileKind(name: string): 'audio' | 'image' | 'extra' | 'skip' {
  if (JUNK.test(name)) return 'skip'
  if (AUDIO.test(name)) return 'audio'
  if (IMAGE.test(name)) return 'image'
  return /\.(pdf|txt|md|nfo|cue|log)$/i.test(name) ? 'extra' : 'skip'
}

/** The format Valence downloads: FLAC when offered (masters go to the archive), else OGG, else MP3. */
export function pickFormat(folders: DriveFolders): DriveFormat | null {
  return folders.flac ? 'flac' : folders.ogg ? 'ogg' : folders.mp3 ? 'mp3' : null
}
