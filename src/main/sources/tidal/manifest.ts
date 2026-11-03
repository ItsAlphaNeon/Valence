// Decodes TIDAL playback manifests (BTS JSON or MPEG-DASH) into a flat list of URLs to fetch.
// Any sign of encryption is refused with SourceError('drm'); protected streams are never handled.

import { XMLParser } from 'fast-xml-parser'
import { SourceError } from '../../import/source-types'

export const BTS_MIME = 'application/vnd.tidal.bts'
export const DASH_MIME = 'application/dash+xml'

export interface StreamManifest {
  kind: 'bts' | 'dash'
  /** Container mime type, e.g. audio/flac or audio/mp4. */
  mimeType: string
  /** e.g. "flac", "mp4a.40.2" */
  codecs: string
  /** Every URL in download order (DASH: init then media segments). */
  urls: string[]
  /** DASH only */
  init?: string
  segments?: string[]
  sampleRate?: number
}

function decodeBase64(b64: string): string {
  if (!b64 || typeof b64 !== 'string') throw new SourceError('Empty TIDAL manifest', 'parse')
  return Buffer.from(b64, 'base64').toString('utf8')
}

/** Decodes the base64 `manifest` of a playbackinfo response. */
export function decodeManifest(manifestMimeType: string, manifestB64: string): StreamManifest {
  const mime = (manifestMimeType || '').toLowerCase()
  const text = decodeBase64(manifestB64)
  if (mime.includes(BTS_MIME)) return parseBts(text)
  if (mime.includes(DASH_MIME)) return parseDash(text)
  // Some responses mislabel; sniff before giving up.
  const t = text.trimStart()
  if (t.startsWith('{')) return parseBts(text)
  if (t.startsWith('<')) return parseDash(text)
  throw new SourceError(`Unsupported TIDAL manifest type: ${manifestMimeType || 'unknown'}`, 'unavailable')
}

export function parseBts(text: string): StreamManifest {
  let j: any
  try {
    j = JSON.parse(text)
  } catch (e) {
    throw new SourceError(`Invalid BTS manifest: ${(e as Error).message}`, 'parse')
  }
  const enc = String(j.encryptionType ?? 'NONE').toUpperCase()
  if (enc !== 'NONE' || (j.keyId != null && j.keyId !== '')) throw new SourceError(`Protected stream (encryption ${enc}) refused`, 'drm')
  const urls: string[] = Array.isArray(j.urls) ? j.urls.filter((u: unknown) => typeof u === 'string' && u) : []
  if (!urls.length) throw new SourceError('BTS manifest has no URLs', 'parse')
  return { kind: 'bts', mimeType: String(j.mimeType ?? ''), codecs: String(j.codecs ?? '').toLowerCase(), urls }
}

const ARRAYS = new Set(['Period', 'AdaptationSet', 'Representation', 'S', 'SegmentTemplate', 'BaseURL', 'ContentProtection'])

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@',
  removeNSPrefix: true,
  parseAttributeValue: false,
  parseTagValue: false,
  trimValues: true,
  isArray: (name) => ARRAYS.has(name),
})

type Node = Record<string, any>

const attr = (n: Node | undefined, name: string): string | undefined => {
  const v = n?.[`@${name}`]
  return v == null ? undefined : String(v)
}
const num = (v: string | undefined, fallback: number): number => {
  const n = Number(v)
  return v != null && Number.isFinite(n) ? n : fallback
}
const text = (n: unknown): string => (typeof n === 'string' ? n : typeof n === 'object' && n ? String((n as Node)['#text'] ?? '') : '')

/** ISO-8601 duration (PT1M2.5S) → seconds. */
export function isoDurationSeconds(d: string | undefined): number {
  const m = /^P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(d ?? '')
  if (!m) return 0
  return Number(m[1] ?? 0) * 86400 + Number(m[2] ?? 0) * 3600 + Number(m[3] ?? 0) * 60 + Number(m[4] ?? 0)
}

/** Expands $RepresentationID$, $Bandwidth$, $Number$, $Time$ (with optional %0Nd widths). */
function fillTemplate(tpl: string, vars: Record<string, string | number>): string {
  return tpl.replace(/\$(\w*)(?:%0(\d+)d)?\$/g, (all, name: string, width?: string) => {
    if (name === '') return '$'
    const v = vars[name]
    if (v === undefined) return all
    const s = String(v)
    return width ? s.padStart(Number(width), '0') : s
  })
}

function resolveUrl(u: string, bases: string[]): string {
  let out = u
  for (let i = bases.length - 1; i >= 0 && !/^[a-z][a-z0-9+.-]*:/i.test(out); i--) {
    try {
      out = new URL(out, bases[i]).toString()
    } catch {
      /* keep relative */
    }
  }
  return out
}

function isAudio(as: Node): boolean {
  const reps: Node[] = as.Representation ?? []
  const mt = attr(as, 'mimeType') ?? attr(reps[0], 'mimeType') ?? ''
  return attr(as, 'contentType') === 'audio' || mt.startsWith('audio') || !!attr(as, 'codecs') || reps.some((r) => !!attr(r, 'codecs'))
}

export function parseDash(xml: string): StreamManifest {
  // Checked on the raw text so protection at any level (MPD, Period, set, representation) counts.
  if (/<(?:\w+:)?ContentProtection\b/i.test(xml) || /\b(?:\w+:)?default_KID\s*=/i.test(xml) || /<(?:\w+:)?pssh\b/i.test(xml)) {
    throw new SourceError('Protected DASH stream (ContentProtection) refused', 'drm')
  }
  let doc: Node
  try {
    doc = parser.parse(xml)
  } catch (e) {
    throw new SourceError(`Invalid DASH manifest: ${(e as Error).message}`, 'parse')
  }
  const mpd: Node | undefined = doc.MPD
  if (!mpd) throw new SourceError('DASH manifest has no MPD element', 'parse')
  const period: Node | undefined = mpd.Period?.[0]
  const sets: Node[] = period?.AdaptationSet ?? []
  const set = sets.find((s) => attr(s, 'group') === 'main') ?? sets.find(isAudio) ?? sets[0]
  if (!set) throw new SourceError('DASH manifest has no AdaptationSet', 'parse')
  const reps: Node[] = set.Representation ?? [{}]
  const rep = reps.reduce((best, r) => (num(attr(r, 'bandwidth'), 0) > num(attr(best, 'bandwidth'), 0) ? r : best), reps[0])

  // Representation-level SegmentTemplate attributes override AdaptationSet-level ones.
  const setTpl: Node = set.SegmentTemplate?.[0] ?? {}
  const repTpl: Node = rep.SegmentTemplate?.[0] ?? {}
  const tpl: Node = { ...setTpl, ...repTpl }
  const media = attr(tpl, 'media')
  const initialization = attr(tpl, 'initialization')
  if (!media) throw new SourceError('DASH manifest has no SegmentTemplate@media', 'parse')

  const bases = [mpd, period, set, rep].map((n) => text(n?.BaseURL?.[0])).filter(Boolean)
  const repId = attr(rep, 'id') ?? ''
  const bandwidth = attr(rep, 'bandwidth') ?? ''
  const startNumber = num(attr(tpl, 'startNumber'), 1)
  const timescale = num(attr(tpl, 'timescale'), 1)
  const timeline: Node[] = (repTpl.SegmentTimeline ?? setTpl.SegmentTimeline)?.S ?? []

  // Segment start times; count = Σ(r+1). r=-1 repeats to the end of the period.
  const times: number[] = []
  if (timeline.length) {
    const totalTicks = isoDurationSeconds(attr(period, 'duration') ?? attr(mpd, 'mediaPresentationDuration')) * timescale
    let t = 0
    timeline.forEach((s, i) => {
      if (attr(s, 't') != null) t = num(attr(s, 't'), t)
      const d = num(attr(s, 'd'), 0)
      let r = num(attr(s, 'r'), 0)
      if (r < 0) {
        const next = timeline[i + 1]
        const end = next && attr(next, 't') != null ? num(attr(next, 't'), totalTicks) : totalTicks
        r = d > 0 ? Math.max(0, Math.ceil((end - t) / d) - 1) : 0
      }
      for (let k = 0; k <= r; k++) {
        times.push(t)
        t += d
      }
    })
  } else {
    const dur = num(attr(tpl, 'duration'), 0)
    const total = isoDurationSeconds(attr(period, 'duration') ?? attr(mpd, 'mediaPresentationDuration'))
    const count = dur > 0 ? Math.ceil((total * timescale) / dur) : 0
    for (let k = 0; k < count; k++) times.push(k * dur)
  }
  if (!times.length) throw new SourceError('DASH manifest has no segments', 'parse')

  const vars = { RepresentationID: repId, Bandwidth: bandwidth }
  const segments = times.map((time, i) => resolveUrl(fillTemplate(media, { ...vars, Number: startNumber + i, Time: time }), bases))
  const init = initialization ? resolveUrl(fillTemplate(initialization, vars), bases) : undefined

  return {
    kind: 'dash',
    mimeType: attr(rep, 'mimeType') ?? attr(set, 'mimeType') ?? 'audio/mp4',
    codecs: (attr(rep, 'codecs') ?? attr(set, 'codecs') ?? '').toLowerCase(),
    urls: init ? [init, ...segments] : segments,
    init,
    segments,
    sampleRate: num(attr(rep, 'audioSamplingRate') ?? attr(set, 'audioSamplingRate'), 0) || undefined,
  }
}

/** True for codecs we can keep losslessly as FLAC. */
export function isLosslessCodec(codecs: string): boolean {
  const c = codecs.toLowerCase()
  return c.includes('flac') || c.includes('alac')
}
