// Bandcamp session state, collection-update signal, persisted collection filters and download actions.

import { create } from 'zustand'
import { BANDCAMP_CHANNELS as CH, type BandcampItemSummary, type BandcampStatus } from '@shared/ipc/bandcamp'
import { invoke, on } from '../../lib/ipc'
import { useLib } from '../../state/library'
import { navigate, toast } from '../../state/ui'
import { addPending, reportSourceError } from '../tidal/source-kit'
import { parseSourceError } from '../tidal/source-helpers'
import { releaseKeyOf, type BcScope, type BcSort } from './helpers'

interface BandcampSession {
  status: BandcampStatus | null
  error: unknown
  loggingIn: boolean
  /** Bumped on `bandcamp:collection-updated`; the collection view re-reads when it changes. */
  collectionVersion: number
  /** Bumped on every successful login so pages that failed with an auth error reload. */
  epoch: number
}

export const useBandcampSession = create<BandcampSession>(() => ({ status: null, error: null, loggingIn: false, collectionVersion: 0, epoch: 0 }))

/** Same rule as TIDAL: logged-out → logged-in, or an explicit login that no broadcast already counted. */
function setStatus(status: BandcampStatus, since?: number): void {
  useBandcampSession.setState((s) => {
    const bump = status.loggedIn && (since !== undefined ? s.epoch === since : !s.status?.loggedIn)
    return { status, error: null, epoch: bump ? s.epoch + 1 : s.epoch }
  })
}

let wired = false

export function initBandcampSession(): void {
  if (!wired) {
    wired = true
    on<[BandcampStatus]>(CH.statusChanged, (s) => s && setStatus(s))
    on(CH.collectionUpdated, () => {
      useBandcampSession.setState((s) => ({ collectionVersion: s.collectionVersion + 1 }))
      void refreshBandcampStatus()
    })
  }
  void refreshBandcampStatus()
}

export async function refreshBandcampStatus(): Promise<void> {
  try {
    setStatus(await invoke<BandcampStatus>(CH.status))
  } catch (error) {
    useBandcampSession.setState({ error })
  }
}

export async function bandcampLogin(): Promise<void> {
  if (useBandcampSession.getState().loggingIn) return
  useBandcampSession.setState({ loggingIn: true })
  const since = useBandcampSession.getState().epoch
  try {
    const status = await invoke<BandcampStatus>(CH.login)
    setStatus(status, since)
    if (status.loggedIn) toast(status.username ? `Logged in to Bandcamp as ${status.username}` : 'Logged in to Bandcamp', 'ok')
    else toast('Bandcamp login was closed before finishing')
  } catch (e) {
    reportSourceError('bandcamp', e)
  } finally {
    useBandcampSession.setState({ loggingIn: false })
  }
}

export async function bandcampLogout(): Promise<void> {
  try {
    const status = await invoke<BandcampStatus>(CH.logout)
    useBandcampSession.setState({ status })
    toast('Logged out of Bandcamp')
  } catch (e) {
    reportSourceError('bandcamp', e)
  }
}

export function bandcampError(e: unknown): void {
  const c = reportSourceError('bandcamp', e, () => void bandcampLogin())
  if (c.kind === 'auth') void refreshBandcampStatus()
}

export const isAuthError = (e: unknown): boolean => parseSourceError(e).kind === 'auth'

const viewQueue = { label: 'View Queue', run: () => navigate({ view: 'import', tab: 'queue' }) }
const pausedSuffix = () => (useLib.getState().pausedSources.bandcamp ? ' — Bandcamp downloads are paused' : '')

export async function downloadPurchase(i: Pick<BandcampItemSummary, 'key' | 'title' | 'artist' | 'tralbumType' | 'tralbumId'>): Promise<void> {
  try {
    const jobId = await invoke<string>(CH.download, i.key)
    addPending([releaseKeyOf(i)], [jobId])
    toast(`Queued ${i.artist} — ${i.title}${pausedSuffix()}`, 'ok', viewQueue)
  } catch (e) {
    bandcampError(e)
  }
}

export async function downloadAllMissing(expected: BandcampItemSummary[]): Promise<number | null> {
  try {
    const n = await invoke<number>(CH.downloadAllMissing)
    // Show them as queued right away; the job broadcasts take over from there.
    if (n) addPending(expected.map(releaseKeyOf), [])
    toast(n ? `Queued ${n} ${n === 1 ? 'purchase' : 'purchases'} from Bandcamp${pausedSuffix()}` : 'Everything downloadable is already in your library or queued', n ? 'ok' : 'info', n ? viewQueue : undefined)
    return n
  } catch (e) {
    bandcampError(e)
    return null
  }
}

// ---- Collection view prefs (kept across navigation; sort persisted) ----

const SORT_KEY = 'valence.bandcamp.sort'

function loadSort(): BcSort {
  try {
    const v = localStorage.getItem(SORT_KEY)
    if (v === 'purchased' || v === 'artist' || v === 'title') return v
  } catch {
    /* ignore */
  }
  return 'purchased'
}

interface CollectionPrefs {
  text: string
  scope: BcScope
  sort: BcSort
  showHidden: boolean
  set(p: Partial<Omit<CollectionPrefs, 'set'>>): void
}

export const useCollectionPrefs = create<CollectionPrefs>((set) => ({
  text: '',
  scope: 'all',
  sort: loadSort(),
  showHidden: true,
  set(p) {
    if (p.sort)
      try {
        localStorage.setItem(SORT_KEY, p.sort)
      } catch {
        /* ignore */
      }
    set(p)
  },
}))
