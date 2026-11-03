// TIDAL session state (status, login/logout) and download actions for the TIDAL view.

import { create } from 'zustand'
import {
  TIDAL_IPC,
  type TidalAlbumSummary,
  type TidalDownloadResult,
  type TidalPlaylistDownloadResult,
  type TidalStatus,
  type TidalTrackSummary,
} from '@shared/ipc/tidal'
import { invoke, on } from '../../lib/ipc'
import { useLib } from '../../state/library'
import { navigate, toast } from '../../state/ui'
import { addPending, reportSourceError } from './source-kit'
import { parseSourceError, playlistResultText, tidalAlbumKeys, tidalPlaylistKey } from './source-helpers'

interface TidalSession {
  status: TidalStatus | null
  /** Status could not be read at all (main not ready / handler missing). */
  error: unknown
  loggingIn: boolean
  /** Bumped on every successful login so pages that failed with an auth error reload. */
  epoch: number
}

export const useTidalSession = create<TidalSession>(() => ({ status: null, error: null, loggingIn: false, epoch: 0 }))

let wired = false

/**
 * Logging in (logged-out → logged-in, or an explicit re-login) bumps the epoch. `since` is the epoch
 * when an explicit login started, so a status broadcast that already bumped it isn't counted twice.
 */
function setStatus(status: TidalStatus, since?: number): void {
  useTidalSession.setState((s) => {
    const bump = status.loggedIn && (since !== undefined ? s.epoch === since : !s.status?.loggedIn)
    return { status, error: null, epoch: bump ? s.epoch + 1 : s.epoch }
  })
}

/** Subscribes to status broadcasts once and (re)reads the status. Safe to call on every mount. */
export function initTidalSession(): void {
  if (!wired) {
    wired = true
    on<[TidalStatus]>(TIDAL_IPC.statusChanged, (status) => setStatus(status))
  }
  void refreshTidalStatus()
}

export async function refreshTidalStatus(): Promise<void> {
  try {
    setStatus(await invoke<TidalStatus>(TIDAL_IPC.status))
  } catch (error) {
    useTidalSession.setState((s) => ({ error, status: s.status }))
  }
}

export async function tidalLogin(): Promise<void> {
  if (useTidalSession.getState().loggingIn) return
  useTidalSession.setState({ loggingIn: true })
  const since = useTidalSession.getState().epoch
  try {
    const status = await invoke<TidalStatus>(TIDAL_IPC.login)
    setStatus(status, since)
    if (status.loggedIn) toast('Logged in to TIDAL', 'ok')
  } catch (e) {
    const { message } = parseSourceError(e)
    if (/cancel/i.test(message)) toast('TIDAL login cancelled')
    else reportSourceError('tidal', e)
  } finally {
    useTidalSession.setState({ loggingIn: false })
  }
}

export async function tidalLogout(): Promise<void> {
  try {
    const status = await invoke<TidalStatus>(TIDAL_IPC.logout)
    useTidalSession.setState({ status })
    toast('Logged out of TIDAL')
  } catch (e) {
    reportSourceError('tidal', e)
  }
}

/** Reports an IPC failure; auth failures also re-read the status so the view can fall back to login. */
export function tidalError(e: unknown): void {
  const c = reportSourceError('tidal', e, () => void tidalLogin())
  if (c.kind === 'auth') void refreshTidalStatus()
}

const viewQueue = { label: 'View Queue', run: () => navigate({ view: 'import', tab: 'queue' }) }

function queuedToast(text: string): void {
  const paused = useLib.getState().pausedSources.tidal
  toast(paused ? `${text} — TIDAL downloads are paused` : text, 'ok', viewQueue)
}

export async function downloadAlbum(a: Pick<TidalAlbumSummary, 'id' | 'upc' | 'title'>, onlyMissing = false): Promise<void> {
  try {
    const r = await invoke<TidalDownloadResult>(TIDAL_IPC.download, { kind: 'album', id: a.id, ...(onlyMissing ? { onlyMissing: true } : {}) })
    addPending([...new Set([...r.releaseKeys, ...tidalAlbumKeys(a)])], [r.jobId])
    queuedToast(onlyMissing ? `Queued missing tracks of ${a.title}` : `Queued ${a.title}`)
  } catch (e) {
    tidalError(e)
  }
}

export async function downloadTrack(t: Pick<TidalTrackSummary, 'id' | 'title'>): Promise<void> {
  try {
    const r = await invoke<TidalDownloadResult>(TIDAL_IPC.download, { kind: 'track', id: t.id })
    addPending([...new Set([...r.releaseKeys, `tidal:track:${t.id}`])], [r.jobId])
    queuedToast(`Queued ${t.title}`)
  } catch (e) {
    tidalError(e)
  }
}

/** Track from a pasted link (no metadata lookup exists for a bare track id). */
export async function downloadTrackById(id: string): Promise<boolean> {
  try {
    const r = await invoke<TidalDownloadResult>(TIDAL_IPC.download, { kind: 'track', id })
    addPending([...new Set([...r.releaseKeys, `tidal:track:${id}`])], [r.jobId])
    queuedToast(`Queued ${r.title.replace(/^TIDAL · /, '')}`)
    return true
  } catch (e) {
    tidalError(e)
    return false
  }
}

export async function downloadTidalPlaylist(p: { uuid: string; title: string }): Promise<TidalPlaylistDownloadResult | null> {
  try {
    const r = await invoke<TidalPlaylistDownloadResult>(TIDAL_IPC.downloadPlaylist, p.uuid)
    if (r.jobIds.length) addPending([tidalPlaylistKey(p.uuid)], r.jobIds)
    const text = `${p.title}: ${playlistResultText(r)}`
    if (r.queued) queuedToast(text)
    else toast(`${text}. Playlist saved to your library.`, 'ok')
    return r
  } catch (e) {
    tidalError(e)
    return null
  }
}
