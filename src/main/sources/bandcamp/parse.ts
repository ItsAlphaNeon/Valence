// Pure parsers for Bandcamp pages and API responses (no I/O; fixture-tested).
// Field names follow what Bandcamp serves today, as used by bandcampsync and batchcamp.

import { SourceError } from '@main/import/source-types'
import type { BandcampItemType } from '@shared/ipc/bandcamp'
import { matchKey } from '@shared/sanitize'

type Json = any

// ---------------------------------------------------------------- HTML helpers

const NAMED: Record<string, string> = {
  quot: '"', amp: '&', lt: '<', gt: '>', apos: "'", nbsp: ' ', ndash: '–', mdash: '—',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', hellip: '…', copy: '©', reg: '®', trade: '™',
}

/** Decodes named (common) and numeric HTML entities in one pass, so `&amp;quot;` stays `&quot;`. */
export function decodeEntities(s: string): string {
  return s.replace(/&(#[xX][0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]*);/g, (m, e: string) => {
    if (e[0] === '#') {
      const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
      return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m
    }
    return NAMED[e] ?? NAMED[e.toLowerCase()] ?? m
  })
}

export interface HtmlTag {
  name: string
  attrs: Record<string, string>
}

// Quoted attribute values may contain '>' so tags are matched attribute by attribute.
const TAG_RE = /<([a-zA-Z][\w:-]*)((?:\s+[^\s"'>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*\/?>/g
const ATTR_RE = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g

export function* scanTags(html: string): Generator<HtmlTag> {
  TAG_RE.lastIndex = 0
  for (let m = TAG_RE.exec(html); m; m = TAG_RE.exec(html)) {
    const attrs: Record<string, string> = {}
    const src = m[2]
    if (src) {
      ATTR_RE.lastIndex = 0
      for (let a = ATTR_RE.exec(src); a; a = ATTR_RE.exec(src)) {
        const key = a[1].toLowerCase()
        if (!(key in attrs)) attrs[key] = decodeEntities(a[2] ?? a[3] ?? a[4] ?? '')
      }
    }
    yield { name: m[1].toLowerCase(), attrs }
  }
}

/** Decoded value of `attr` on the first element carrying it (optionally the element with `id`). */
export function findAttr(html: string, attr: string, id?: string): string | null {
  const key = attr.toLowerCase()
  for (const t of scanTags(html)) {
    if (id !== undefined && t.attrs.id !== id) continue
    if (key in t.attrs) return t.attrs[key]
    if (id !== undefined) return null
  }
  return null
}

/** Parses a JSON data attribute (`data-blob`, `data-tralbum`, `data-embed`…); null if absent/invalid. */
export function dataBlob<T = Json>(html: string, attr: string, id?: string): T | null {
  const raw = findAttr(html, attr, id)
  if (raw === null || raw === '') return null
  try {
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

/** All `application/ld+json` blocks, flattened (a block may hold an array). */
export function ldJson(html: string): Json[] {
  const out: Json[] = []
  const re = /<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
  for (let m = re.exec(html); m; m = re.exec(html)) {
    try {
      const v = JSON.parse(m[1].trim())
      if (Array.isArray(v)) out.push(...v)
      else out.push(v)
    } catch {
      // ignore malformed blocks
    }
  }
  return out
}

function metaContent(html: string, property: string): string | undefined {
  for (const t of scanTags(html)) {
    if (t.name === 'meta' && (t.attrs.property === property || t.attrs.name === property)) return t.attrs.content
  }
  return undefined
}

// ---------------------------------------------------------------- small coercions

const num = (v: unknown): number | null => {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v
  return typeof n === 'number' && Number.isFinite(n) ? n : null
}
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined)

const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 }

/** Bandcamp dates ("22 Apr 2022 00:00:00 GMT", ISO…) → YYYY-MM-DD. */
export function bcDate(v: unknown): string | undefined {
  const s = str(v)
  if (!s) return undefined
  const pad = (n: number) => String(n).padStart(2, '0')
  const m = /^(?:[A-Za-z]{3},?\s+)?(\d{1,2})\s+([A-Za-z]{3})[A-Za-z]*\.?\s+(\d{4})/.exec(s)
  if (m && MONTHS[m[2].toLowerCase()]) return `${m[3]}-${pad(MONTHS[m[2].toLowerCase()])}-${pad(Number(m[1]))}`
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(s)
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`
  const t = Date.parse(s)
  return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : undefined
}

/** Electron's default UA minus the `Electron/…` and app tokens, with Chrome's reduced version. */
export function chromeUserAgent(ua: string): string {
  const tokens = ua.match(/\([^)]*\)|\S+/g) ?? []
  return tokens
    .filter((t) => t.startsWith('(') || /^(Mozilla|AppleWebKit|Chrome|Safari|Mobile|Version)\//.test(t))
    .join(' ')
    .replace(/Chrome\/(\d+)[\d.]*/, 'Chrome/$1.0.0.0')
}

// ---------------------------------------------------------------- identity

export interface FanIdentity {
  fanId: number | null
  username?: string
  /** Fan page URL, used as a last-resort fan_id source. */
  fanUrl?: string
  verified?: boolean
}

/** fan_id from the homepage `#HomepageApp` blob, else `#pagedata` identities / fan_data (fan page). */
export function parseIdentity(html: string): FanIdentity | null {
  const out: FanIdentity = { fanId: null }
  const home = dataBlob(html, 'data-blob', 'HomepageApp')
  const hid = home?.pageContext?.identity
  if (hid && typeof hid === 'object') {
    out.fanId = num(hid.fanId) || null
    out.username = str(hid.username) ?? str(hid.fanUsername) ?? str(hid.fan?.username)
    out.fanUrl = str(hid.fanUrl) ?? str(hid.fan?.url)
    if (typeof hid.isFanVerified === 'boolean') out.verified = hid.isFanVerified
  }
  const page = dataBlob(html, 'data-blob', 'pagedata')
  const fan = page?.identities?.fan
  if (fan && typeof fan === 'object') {
    out.fanId ||= num(fan.id) || null
    out.username ??= str(fan.username)
    out.fanUrl ??= str(fan.url)
    if (out.verified === undefined && typeof fan.verified === 'boolean') out.verified = fan.verified
  }
  const fd = page?.fan_data
  if (fd && typeof fd === 'object') {
    out.fanId ||= num(fd.fan_id) || null
    out.username ??= str(fd.username)
  }
  return out.fanId || out.username || out.fanUrl ? out : null
}

// ---------------------------------------------------------------- collection API

export interface BcTrack {
  trackId: number
  trackNum: number
  title: string
  artist?: string
  durationMs: number
}

export interface CollectionPage {
  items: Json[]
  redownloadUrls: Record<string, string>
  tracklists: Record<string, Json[]>
  lastToken: string | null
  moreAvailable: boolean
}

export function parseCollectionPage(json: unknown): CollectionPage {
  if (!json || typeof json !== 'object') throw new SourceError('Bandcamp collection response is not JSON', 'parse')
  const j = json as Json
  if (j.error) throw new SourceError(`Bandcamp collection API: ${j.error_message ?? 'error'}`, 'parse')
  if (!Array.isArray(j.items)) throw new SourceError('Bandcamp collection response has no items', 'parse')
  const urls: Record<string, string> = {}
  for (const [k, v] of Object.entries(j.redownload_urls ?? {})) if (typeof v === 'string' && v) urls[k] = v
  return {
    items: j.items,
    redownloadUrls: urls,
    tracklists: j.tracklists && typeof j.tracklists === 'object' ? j.tracklists : {},
    lastToken: str(j.last_token) ?? null,
    moreAvailable: !!j.more_available,
  }
}

export function toTrack(t: Json, i: number): BcTrack | null {
  const id = num(t?.track_id ?? t?.id)
  if (!id) return null
  return {
    trackId: id,
    trackNum: num(t.track_num ?? t.track_number) ?? i + 1,
    title: str(t.title) ?? `Track ${i + 1}`,
    artist: str(t.artist),
    durationMs: Math.round((num(t.duration) ?? 0) * 1000),
  }
}

export interface BcCollectionItem {
  /** `${sale_item_type}${sale_item_id}`, the redownload_urls key. */
  key: string
  saleItemType: string
  saleItemId: number
  itemId: number
  itemType: BandcampItemType
  tralbumType: 'album' | 'track'
  tralbumId: number
  title: string
  artist: string
  itemUrl: string | null
  artId: number | null
  redownloadUrl: string | null
  hidden: boolean
  preorder: boolean
  physicalOnly: boolean
  downloadable: boolean
  purchased?: string
  trackCount?: number
  tracks?: BcTrack[]
}

function itemTypeOf(v: unknown): BandcampItemType {
  const s = String(v ?? '').toLowerCase()
  if (s === 'track' || s === 't') return 'track'
  if (s === 'package' || s === 'p') return 'package'
  return 'album'
}

/** Normalizes one collection entry; null for entries without an id/title (e.g. subscriptions). */
export function toCollectionItem(
  raw: Json,
  ctx: { redownloadUrls: Record<string, string>; tracklists?: Record<string, Json[]> },
  hidden = false,
): BcCollectionItem | null {
  const itemId = num(raw?.item_id)
  const title = str(raw?.item_title) ?? str(raw?.album_title)
  if (!itemId || !title) return null
  const itemType = itemTypeOf(raw.item_type)
  const saleItemType = str(raw.sale_item_type) ?? itemType[0]
  const saleItemId = num(raw.sale_item_id) ?? itemId
  const key = `${saleItemType}${saleItemId}`
  const tt = str(raw.tralbum_type)
  const tralbumType: 'album' | 'track' = tt ? (tt === 't' ? 'track' : 'album') : itemType === 'track' ? 'track' : 'album'
  const tralbumId = num(raw.tralbum_id) ?? (itemType === 'package' ? num(raw.album_id) : null) ?? itemId
  const redownloadUrl = ctx.redownloadUrls[key] ?? null
  const preorder = !!raw.is_preorder
  const rawTracks = ctx.tracklists?.[`${itemType[0]}${itemId}`] ?? ctx.tracklists?.[`${tralbumType[0]}${tralbumId}`]
  const tracks = Array.isArray(rawTracks) ? rawTracks.map(toTrack).filter((t): t is BcTrack => !!t) : undefined
  const purchasedMs = Date.parse(str(raw.purchased) ?? '')
  return {
    key,
    saleItemType,
    saleItemId,
    itemId,
    itemType,
    tralbumType,
    tralbumId,
    title,
    artist: str(raw.band_name) ?? str(raw.artist) ?? 'Unknown Artist',
    itemUrl: str(raw.item_url) ?? null,
    artId: num(raw.item_art_id ?? raw.item_art?.art_id) || null,
    redownloadUrl,
    hidden: hidden || !!raw.hidden,
    preorder,
    physicalOnly: itemType === 'package' && !redownloadUrl,
    downloadable: !!redownloadUrl && !preorder,
    purchased: Number.isFinite(purchasedMs) ? new Date(purchasedMs).toISOString() : undefined,
    trackCount: tracks?.length || num(raw.num_streamable_tracks) || undefined,
    tracks: tracks?.length ? tracks : undefined,
  }
}

// ---------------------------------------------------------------- download page

export interface BcDigitalItem {
  saleId: number | null
  itemId: number
  /** 'a' | 't' | 'p' */
  itemType: string
  tralbumType: 'album' | 'track'
  tralbumId: number | null
  title: string
  artist: string
  artId: number | null
  pageUrl: string | null
  releaseDate?: string
  preorder: boolean
  downloads: Record<string, { url: string; sizeMb?: string }>
  flacUrl: string | null
}

export interface DownloadPage {
  items: BcDigitalItem[]
  fanVerified?: boolean
  /** Bandcamp wants the fan to re-confirm their email before downloads work. */
  emailReauth: boolean
}

/** `#pagedata` of a redownload page → digital items with their per-format URLs; null if no pagedata. */
export function parseDownloadPage(html: string): DownloadPage | null {
  const page = dataBlob(html, 'data-blob', 'pagedata')
  if (!page || typeof page !== 'object') return null
  const list: Json[] = Array.isArray(page.digital_items) ? page.digital_items : Array.isArray(page.download_items) ? page.download_items : []
  const items: BcDigitalItem[] = []
  for (const d of list) {
    const itemId = num(d?.item_id)
    if (!itemId) continue
    const downloads: BcDigitalItem['downloads'] = {}
    for (const [enc, v] of Object.entries((d.downloads ?? {}) as Record<string, Json>)) {
      if (v && typeof v.url === 'string') downloads[enc] = { url: v.url, sizeMb: str(v.size_mb) }
    }
    const dt = str(d.download_type) ?? str(d.item_type)
    items.push({
      saleId: num(d.sale_id),
      itemId,
      itemType: str(d.item_type) ?? 'a',
      tralbumType: dt === 't' ? 'track' : 'album',
      tralbumId: num(d.tralbum_id ?? d.download_id),
      title: str(d.title) ?? '',
      artist: str(d.artist) ?? str(d.band_name) ?? '',
      artId: num(d.art_id) || null,
      pageUrl: str(d.page_url) ?? null,
      releaseDate: bcDate(d.release_date ?? d.package_release_date),
      preorder: !!d.is_preorder,
      downloads,
      flacUrl: downloads.flac?.url ?? null,
    })
  }
  // The live page always renders this block and toggles it client-side (`data-bind="visible: …"`), so
  // its presence only means a reauth when no item offers a download either.
  let emailReauth = false
  for (const t of scanTags(html)) {
    if (!/(^|\s)email-reauth-error(\s|$)/.test(t.attrs.class ?? '')) continue
    emailReauth = !/display\s*:\s*none/i.test(t.attrs.style ?? '') && !items.some((d) => Object.keys(d.downloads).length > 0)
    break
  }
  const verified = page.identities?.fan?.verified
  return { items, fanVerified: typeof verified === 'boolean' ? verified : undefined, emailReauth }
}

/** The digital item for a purchase: by sale id, then tralbum id, then the first one with downloads. */
export function pickDigitalItem(page: DownloadPage, want: { saleItemId?: number; tralbumId?: number }): BcDigitalItem | null {
  return (
    page.items.find((d) => want.saleItemId && d.saleId === want.saleItemId) ??
    page.items.find((d) => want.tralbumId && d.tralbumId === want.tralbumId) ??
    page.items.find((d) => Object.keys(d.downloads).length > 0) ??
    page.items[0] ??
    null
  )
}

// ---------------------------------------------------------------- statdownload

export interface StatResult {
  result: 'ok' | 'err' | 'unknown'
  downloadUrl?: string
  retryUrl?: string
  errorType?: string
}

/** `/download/…` → `/statdownload/…` with cache-busting `.rand` and `.vrs=1`; null for non-download URLs. */
export function toStatUrl(downloadUrl: string, rand: () => number = Math.random): string | null {
  let u: URL
  try {
    u = new URL(downloadUrl)
  } catch {
    return null
  }
  if (!u.pathname.startsWith('/download/')) return null
  u.pathname = u.pathname.replace('/download/', '/statdownload/')
  u.searchParams.set('.rand', String(Math.floor(rand() * 1e12)))
  u.searchParams.set('.vrs', '1')
  return u.toString()
}

/** Parses the statdownload JSONP (`Downloads.statResult({...})`, or the legacy `var _statDL_result = {...}`). */
export function parseStatResponse(body: string): StatResult | null {
  const text = /statResult\s*\(\s*(\{[\s\S]*\})\s*\)/.exec(body)?.[1] ?? /(\{[\s\S]*\})/.exec(body)?.[1]
  if (!text) return null
  let obj: Json
  try {
    obj = JSON.parse(text)
  } catch {
    // Legacy JS-object form: unquoted keys, single-quoted values.
    const pick = (k: string) => new RegExp(`["']?${k}["']?\\s*:\\s*["']([^"']*)["']`).exec(text)?.[1]?.replace(/\\\//g, '/')
    obj = { result: pick('result'), download_url: pick('download_url'), retry_url: pick('retry_url'), errortype: pick('errortype') }
  }
  if (!obj || typeof obj !== 'object' || !obj.result) return null
  const r = String(obj.result).toLowerCase()
  return {
    result: r === 'ok' ? 'ok' : r === 'err' || r === 'error' ? 'err' : 'unknown',
    downloadUrl: str(obj.download_url) ?? str(obj.url),
    retryUrl: str(obj.retry_url),
    errorType: str(obj.errortype),
  }
}

// ---------------------------------------------------------------- album / track page

export interface BcTralbum {
  id: number
  itemType: 'album' | 'track'
  title: string
  artist: string
  artId: number | null
  url: string | null
  releaseDate?: string
  preorder: boolean
  upc?: string
  tracks: BcTrack[]
  /** Name of the page owner (artist or label account). */
  bandName?: string
  /** Set when the page belongs to a label rather than the release's artist. */
  label?: string
  /** Track pages: the album the track belongs to. */
  albumTitle?: string
  albumTrackCount?: number
  tags: string[]
}

function keywordsOf(ld: Json): string[] {
  const k = ld?.keywords
  const list = Array.isArray(k) ? k : typeof k === 'string' ? k.split(',') : []
  return list.map((x: unknown) => (typeof x === 'string' ? x.trim() : '')).filter(Boolean)
}

/** Album/track page: `data-tralbum` (+ `data-embed`, `data-band`, ld+json) → release metadata. */
export function parseTralbum(html: string, pageUrl?: string): BcTralbum | null {
  const tr = dataBlob(html, 'data-tralbum')
  if (!tr || typeof tr !== 'object') return null
  const embed = dataBlob(html, 'data-embed') ?? {}
  const band = dataBlob(html, 'data-band') ?? {}
  const ld = ldJson(html).find((x) => /Music(Album|Recording)/.test(String(x?.['@type'] ?? ''))) ?? {}
  const cur = tr.current ?? {}
  const id = num(tr.id ?? cur.id)
  if (!id) return null
  const itemType = String(tr.item_type ?? cur.type ?? '').toLowerCase().startsWith('t') ? 'track' : 'album'
  const artist = str(tr.artist) ?? str(embed.artist) ?? str(ld.byArtist?.name) ?? 'Unknown Artist'
  const tracks = (Array.isArray(tr.trackinfo) ? tr.trackinfo : []).map(toTrack).filter((t: BcTrack | null): t is BcTrack => !!t)
  const bandName = str(band.name) ?? str(ld.publisher?.name) ?? str(metaContent(html, 'og:site_name'))
  const bk = matchKey(bandName)
  const ak = matchKey(artist)
  const isLabel = band.is_label === true || (!!bk && !!ak && !ak.includes(bk) && !bk.includes(ak))
  const tags = keywordsOf(ld)
  if (!tags.length) {
    const re = /<a\b[^>]*class\s*=\s*"[^"]*\btag\b[^"]*"[^>]*>([^<]+)<\/a>/g
    for (let m = re.exec(html); m; m = re.exec(html)) tags.push(decodeEntities(m[1]).trim())
  }
  const upc = str(cur.upc)
  const inAlbum = ld.inAlbum
  return {
    id,
    itemType,
    title: str(cur.title) ?? str(embed.album_title) ?? str(ld.name) ?? 'Untitled',
    artist,
    artId: num(tr.art_id ?? cur.art_id ?? embed.art_id) || null,
    url: str(tr.url) ?? str(embed.linkback) ?? str(ld['@id']) ?? pageUrl ?? null,
    releaseDate: bcDate(cur.release_date) ?? bcDate(tr.album_release_date) ?? bcDate(ld.datePublished),
    preorder: !!(tr.is_preorder || tr.album_is_preorder),
    upc: upc && /^\d{8,14}$/.test(upc) ? upc : undefined,
    tracks,
    bandName,
    label: isLabel ? bandName : undefined,
    albumTitle: itemType === 'track' ? str(inAlbum?.name) ?? str(embed.album_title) : undefined,
    albumTrackCount: itemType === 'track' ? num(inAlbum?.numTracks) ?? undefined : undefined,
    tags: [...new Set(tags)],
  }
}
