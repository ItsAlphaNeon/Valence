// Small helpers shared by the Import tabs.

import { errorMessage, invoke } from '../../lib/ipc'
import { plural } from '../../lib/format'
import { toast, useUi } from '../../state/ui'
import { IMPORT, type ImportSummary } from '@shared/ipc/import'
import { decodeSourceQuality, type QualityInfo } from '@shared/quality'
import type { IconName } from '../../components/Icon'

export type ImportTab = 'queue' | 'review' | 'reports'

export function goTab(tab: ImportTab): void {
  useUi.getState().navigate({ view: 'import', tab }, { replace: true })
}

export function openReport(reportId: string): void {
  useUi.getState().navigate({ view: 'import', tab: 'reports', reportId })
}

const SOURCE_LABEL: Record<string, string> = { tidal: 'TIDAL', bandcamp: 'Bandcamp', import: 'Files' }
const SOURCE_ICON: Record<string, IconName> = { tidal: 'wave', bandcamp: 'disc', import: 'folder' }

export const sourceLabel = (s: string): string => SOURCE_LABEL[s] ?? s.charAt(0).toUpperCase() + s.slice(1)
export const sourceIcon = (s: string): IconName => SOURCE_ICON[s] ?? 'download'

export async function run<T>(channel: string, args: unknown[], failure: string): Promise<T | undefined> {
  try {
    return await invoke<T>(channel, ...args)
  } catch (e) {
    toast(`${failure}: ${errorMessage(e)}`, 'error')
    return undefined
  }
}

/** Like run, for calls whose result doesn't matter: true when it succeeded. */
export async function attempt(channel: string, args: unknown[], failure: string): Promise<boolean> {
  try {
    await invoke(channel, ...args)
    return true
  } catch (e) {
    toast(`${failure}: ${errorMessage(e)}`, 'error')
    return false
  }
}

export async function chooseAndImport(kind: 'folder' | 'files'): Promise<void> {
  const ids = await run<string[]>(IMPORT.chooseAndImport, [kind], 'Couldn’t start the import')
  if (!ids?.length) return
  toast(`Queued ${plural(ids.length, 'import')}`, 'ok')
  goTab('queue')
}

export async function openInboxFolder(): Promise<void> {
  const err = await run<string>(IMPORT.openInbox, [], 'Couldn’t open the Inbox')
  if (err) toast(err, 'error')
}

/** Formats a quality value from a report (encoded "lossless:24:96000" string or a QualityInfo). */
export function fmtQuality(q: unknown): string | null {
  const info: QualityInfo | null = typeof q === 'string' ? decodeSourceQuality(q) : q && typeof q === 'object' && 'lossless' in q ? (q as QualityInfo) : null
  if (!info) return typeof q === 'string' && q ? q : null
  if (info.lossless) {
    const khz = info.sampleRate ? `${(info.sampleRate / 1000).toFixed(info.sampleRate % 1000 ? 1 : 0)} kHz` : ''
    return [`${info.codec ? info.codec.toUpperCase() : 'Lossless'}`, info.bitDepth ? `${info.bitDepth}-bit` : '', khz].filter(Boolean).join(' ')
  }
  const codec = (info.codec ?? 'lossy').toUpperCase()
  return info.bitrate ? `${codec} ${Math.round(info.bitrate / 1000)} kbps` : codec
}

export const pct = (score: number): string => `${Math.round(Math.max(0, Math.min(1, score)) * 100)}%`

export function scoreKind(score: number): 'ok' | 'warn' | '' {
  return score >= 0.85 ? 'ok' : score >= 0.6 ? 'warn' : ''
}

export const IDENTIFIED_LABEL: Record<ImportSummary['identified'], string> = {
  auto: 'Matched on MusicBrainz',
  manual: 'Release chosen by you',
  review: 'Imported without a confirmed match',
  unmatched: 'No MusicBrainz match',
  source: 'Tagged from the source',
}

export function basename(p: string | undefined | null): string {
  if (!p) return ''
  return p.split(/[\\/]/).pop() ?? p
}

/** Day-bucket label for list grouping: Today, Yesterday, or a date. */
export function dayLabel(ts: number): string {
  const d = new Date(ts)
  const today = new Date()
  const start = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const days = Math.round((start(today) - start(d)) / 86400000)
  if (days <= 0) return 'Today'
  if (days === 1) return 'Yesterday'
  if (days < 7) return d.toLocaleDateString(undefined, { weekday: 'long' })
  return d.toLocaleDateString(undefined, { year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric', month: 'long', day: 'numeric' })
}
