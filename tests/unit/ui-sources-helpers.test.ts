import { describe, expect, it } from 'vitest'
import type { JobInfo } from '@shared/ipc/import'
import {
  activeJobsByKey,
  describeSourceError,
  jobForKeys,
  looksLikeTidalLink,
  parseSourceError,
  parseTidalRoute,
  pendingState,
  PENDING_GRACE_MS,
  playlistResultText,
  routeForLink,
  tidalAlbumKeys,
  tidalQualityChip,
  tidalReleaseType,
  tidalTrackKeys,
} from '../../src/renderer/views/tidal/source-helpers'

const job = (id: string, status: JobInfo['status'], releaseKeys: string[]): JobInfo => ({
  id,
  source: 'tidal',
  title: id,
  releaseKeys,
  status,
  stage: null,
  progress: 0,
  message: null,
  error: null,
  attempts: 0,
  reportId: null,
  review: null,
  createdAt: 0,
  updatedAt: 0,
})

describe('parseSourceError', () => {
  it('reads the [kind] prefix through the Electron wrapper', () => {
    const e = new Error("Error invoking remote method 'tidal:album': Error: [auth] Not logged in to TIDAL")
    expect(parseSourceError(e)).toEqual({ kind: 'auth', message: 'Not logged in to TIDAL' })
  })

  it('handles abuse and rate-limit kinds', () => {
    expect(parseSourceError(new Error("Error invoking remote method 'tidal:download': Error: [abuse] Account flagged")).kind).toBe('abuse')
    expect(parseSourceError('[rate-limit] Slow down').kind).toBe('rate-limit')
  })

  it('falls back to heuristics for untagged (Bandcamp) errors', () => {
    expect(parseSourceError(new Error("Error invoking remote method 'bandcamp:collection': SourceError: Not logged in to Bandcamp"))).toEqual({
      kind: 'auth',
      message: 'Not logged in to Bandcamp',
    })
    expect(parseSourceError(new Error('Bandcamp is rate limiting requests')).kind).toBe('rate-limit')
    expect(parseSourceError(new Error('Bandcamp request failed: ECONNRESET')).kind).toBe('network')
    expect(parseSourceError(new Error('Something odd')).kind).toBeNull()
  })

  it('ignores unknown bracket tags', () => {
    expect(parseSourceError('[weird] thing')).toEqual({ kind: null, message: '[weird] thing' })
  })

  it('describes errors for the UI', () => {
    expect(describeSourceError('TIDAL', '[abuse] x').title).toMatch(/paused downloads/)
    expect(describeSourceError('TIDAL', '[auth] x').title).toBe('Log in to TIDAL again')
    expect(describeSourceError('Bandcamp', 'boom').detail).toBe('boom')
  })
})

describe('job key matching', () => {
  const jobs = [
    job('a', 'queued', ['tidal:album:1', 'upc:123']),
    job('b', 'running', ['tidal:track:9']),
    job('c', 'done', ['tidal:album:2']),
    job('d', 'running', ['tidal:album:1']),
  ]
  const active = activeJobsByKey(jobs)

  it('indexes only queued/running jobs and prefers running', () => {
    expect(active.has('tidal:album:2')).toBe(false)
    expect(active.get('tidal:album:1')?.id).toBe('d')
    expect(active.get('upc:123')?.id).toBe('a')
  })

  it('matches album, track and album-of-track keys', () => {
    expect(tidalAlbumKeys({ id: '1', upc: '123' })).toEqual(['tidal:album:1', 'upc:123'])
    expect(tidalTrackKeys({ id: '9', album: { id: '1' } })).toEqual(['tidal:track:9', 'tidal:album:1'])
    expect(jobForKeys(active, tidalTrackKeys({ id: '7', album: { id: '1' } }))?.id).toBe('d')
    expect(jobForKeys(active, tidalTrackKeys({ id: '9', album: null }))?.status).toBe('running')
    expect(jobForKeys(active, ['tidal:album:3'])).toBeUndefined()
  })

  it('resolves pending downloads by job id with a grace period', () => {
    const p = { keys: ['k'], jobIds: ['x'], at: 1000 }
    expect(pendingState(p, [], 1000 + PENDING_GRACE_MS - 1)).toBe('queued')
    expect(pendingState(p, [], 1000 + PENDING_GRACE_MS + 1)).toBeNull()
    expect(pendingState(p, [job('x', 'running', [])], 1e12)).toBe('running')
    expect(pendingState(p, [job('x', 'done', [])], 1001)).toBeNull()
    const pl = { keys: ['tidal:playlist:u'], jobIds: ['x', 'y'], at: 0 }
    expect(pendingState(pl, [job('x', 'done', []), job('y', 'queued', [])], 1e12)).toBe('queued')
  })
})

describe('TIDAL routes and labels', () => {
  it('parses tabs', () => {
    expect(parseTidalRoute()).toEqual({ page: 'favorites', tab: 'albums' })
    expect(parseTidalRoute('tracks')).toEqual({ page: 'favorites', tab: 'tracks' })
    expect(parseTidalRoute('search', ' daft punk ')).toEqual({ page: 'search', query: 'daft punk' })
    expect(parseTidalRoute('album', '123')).toEqual({ page: 'album', id: '123' })
    expect(parseTidalRoute('album')).toEqual({ page: 'favorites', tab: 'albums' })
    expect(parseTidalRoute('bogus', '1')).toEqual({ page: 'favorites', tab: 'albums' })
  })

  it('maps links to routes', () => {
    expect(routeForLink({ kind: 'playlist', id: 'u' })).toEqual({ tab: 'playlist', id: 'u' })
    expect(routeForLink({ kind: 'track', id: '1' })).toBeNull()
    expect(looksLikeTidalLink('https://tidal.com/browse/album/1')).toBe(true)
    expect(looksLikeTidalLink('https://listen.tidal.com/album/1')).toBe(true)
    expect(looksLikeTidalLink('tidal://album/1')).toBe(true)
    expect(looksLikeTidalLink('tidal remix')).toBe(false)
  })

  it('labels quality and release type', () => {
    expect(tidalQualityChip('HI_RES_LOSSLESS')?.title).toMatch(/16-bit/)
    expect(tidalQualityChip('LOSSLESS')?.label).toBe('Lossless')
    expect(tidalQualityChip('HIGH')?.kind).toBe('warn')
    expect(tidalQualityChip(null)).toBeNull()
    expect(tidalReleaseType('EP')).toBe('EP')
    expect(tidalReleaseType('ALBUM', 2)).toBe('Album')
    expect(tidalReleaseType('', 2)).toBe('Single')
    expect(tidalReleaseType('ALBUM', 12)).toBe('Album')
  })

  it('summarises playlist downloads', () => {
    expect(playlistResultText({ queued: 3, alreadyInLibrary: 9, alreadyQueued: 0, unavailable: 1 })).toBe('Queued 3 tracks · 9 already in library · 1 unavailable')
    expect(playlistResultText({ queued: 0, alreadyInLibrary: 5, alreadyQueued: 1, unavailable: 0 })).toBe('Nothing new to download · 5 already in library · 1 already queued')
  })
})
