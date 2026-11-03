// Get Info → MusicBrainz: identify the selected songs (the same matcher imports use), let the user
// pick a different release, preview every field that would change, then apply through editTags.

import { useState } from 'react'
import type { TrackTags } from '@shared/types'
import { IMPORT, type TrackLookupResult } from '@shared/ipc/import'
import { LIB, type EditTagsResult } from '@shared/ipc/library'
import { errorMessage, invoke } from '../../lib/ipc'
import { cx, plural } from '../../lib/format'
import { toast } from '../../state/ui'
import { Button, Spinner } from '../../components/ui'
import { CandidateRow } from '../import/ReviewTab'
import { pct, scoreKind } from '../import/common'
import '../import/import.css'

const LABELS: Partial<Record<keyof TrackTags, string>> = {
  title: 'Title',
  artist: 'Artist',
  artists: 'Artists',
  album: 'Album',
  albumartist: 'Album Artist',
  albumartists: 'Album Artists',
  artistsort: 'Sort Artist',
  albumartistsort: 'Sort Album Artist',
  tracknumber: 'Track',
  totaltracks: 'Tracks',
  discnumber: 'Disc',
  totaldiscs: 'Discs',
  date: 'Date',
  originaldate: 'Original date',
  genre: 'Genre',
  compilation: 'Compilation',
  isrc: 'ISRC',
  barcode: 'Barcode',
  label: 'Label',
  catalognumber: 'Catalog #',
  media: 'Media',
  musicbrainz_recordingid: 'MB recording',
  musicbrainz_trackid: 'MB track',
  musicbrainz_albumid: 'MB release',
  musicbrainz_releasegroupid: 'MB release group',
  musicbrainz_artistid: 'MB artist',
  musicbrainz_albumartistid: 'MB album artist',
  releasetype: 'Release type',
  releasestatus: 'Release status',
  releasecountry: 'Country',
}
/** Shown first; the rest (mostly ids) sit behind "and N more". */
const PROMINENT = new Set<string>(['title', 'artist', 'album', 'albumartist', 'tracknumber', 'discnumber', 'date', 'genre', 'label'])

function show(v: unknown): string {
  if (v == null || v === '') return '—'
  if (Array.isArray(v)) return v.join('; ')
  if (typeof v === 'boolean') return v ? 'Yes' : 'No'
  return String(v)
}

export function MusicBrainzLookup({ ids, tagsById, onApplied }: { ids: number[]; tagsById: Map<number, TrackTags>; onApplied: () => void }) {
  const [res, setRes] = useState<TrackLookupResult | null>(null)
  const [busy, setBusy] = useState<'lookup' | 'apply' | null>(null)
  const [picked, setPicked] = useState<string | null>(null)
  const [expanded, setExpanded] = useState(false)

  const lookup = async (releaseId?: string) => {
    setBusy('lookup')
    try {
      const r = await invoke<TrackLookupResult>(IMPORT.lookupTracks, ids, releaseId)
      setRes(r)
      setPicked(r.release?.releaseId ?? null)
    } catch (e) {
      toast(`MusicBrainz lookup failed: ${errorMessage(e)}`, 'error')
    } finally {
      setBusy(null)
    }
  }

  const changes = res?.changes.filter((c) => Object.keys(c.patch).length) ?? []
  const fieldCount = changes.reduce((n, c) => n + Object.keys(c.patch).length, 0)

  const apply = async () => {
    setBusy('apply')
    let moved = 0
    const errors: string[] = []
    try {
      for (const c of changes) {
        const r = await invoke<EditTagsResult>(LIB.editTags, { ids: [c.id], patch: c.patch })
        moved += r.moved
        errors.push(...r.errors.map((e) => e.error))
      }
      if (errors.length) toast(`${plural(errors.length, 'file')} couldn’t be saved: ${errors[0]}`, 'error')
      else toast(`Updated ${plural(changes.length, 'song')}${moved ? ` · ${plural(moved, 'file')} renamed to match` : ''}`, 'ok')
      onApplied()
    } catch (e) {
      toast(errorMessage(e), 'error')
    } finally {
      setBusy(null)
    }
  }

  if (!res)
    return (
      <div className="gi-mb">
        <p className="muted">
          Match {ids.length > 1 ? 'these songs' : 'this song'} against MusicBrainz, the same way imports are identified, and preview every tag it would change before anything is written.
        </p>
        <div className="row">
          <Button kind="primary" icon="search" disabled={!!busy} onClick={() => void lookup()}>
            {busy ? 'Looking up…' : 'Look up on MusicBrainz'}
          </Button>
          {busy && <Spinner />}
        </div>
      </div>
    )

  const others = res.candidates.filter((c) => c.releaseId !== res.release?.releaseId)
  return (
    <div className="gi-mb">
      <div className="row gi-mb-head">
        {res.release ? (
          <span className="grow ellipsis">
            <b>{res.release.title}</b> <span className="muted">— {res.release.artist}</span>
          </span>
        ) : (
          <span className="grow muted">No confident match.{others.length ? ' Pick a release below.' : ''}</span>
        )}
        {res.release && (
          <span className={cx('chip tnum', scoreKind(res.score))}>
            {res.status === 'auto' ? 'Match' : 'Possible'} {pct(res.score)}
          </span>
        )}
      </div>

      {res.release && (
        <section className="gi-mb-changes">
          {changes.length ? (
            changes.map((c) => {
              const cur = tagsById.get(c.id) ?? {}
              const keys = Object.keys(c.patch) as Array<keyof TrackTags>
              const main = expanded ? keys : keys.filter((k) => PROMINENT.has(k))
              const hidden = keys.length - main.length
              return (
                <div key={c.id} className="gi-mb-track">
                  <div className="gi-mb-track-title ellipsis">{c.title}</div>
                  {main.map((k) => (
                    <div key={k} className="gi-mb-diff">
                      <span className="faint">{LABELS[k] ?? k}</span>
                      <span className="gi-mb-old ellipsis" title={show(cur[k])}>
                        {show(cur[k])}
                      </span>
                      <span className="gi-mb-new ellipsis" title={show(c.patch[k])}>
                        {show(c.patch[k])}
                      </span>
                    </div>
                  ))}
                  {hidden > 0 && (
                    <button className="gi-mb-more faint" onClick={() => setExpanded(true)}>
                      and {plural(hidden, 'more field')}
                    </button>
                  )}
                </div>
              )
            })
          ) : (
            <p className="muted">The tags already match this release, so there's nothing to change.</p>
          )}
        </section>
      )}

      {others.length > 0 && (
        <details className="gi-mb-others" open={!res.release}>
          <summary>Other releases ({others.length})</summary>
          <div className="imp-cands" role="radiogroup" aria-label="Other releases">
            {others.map((c) => (
              <CandidateRow key={c.releaseId} c={c} picked={picked === c.releaseId} fileCount={ids.length} onPick={() => setPicked(c.releaseId)} />
            ))}
          </div>
          <div className="row gi-mb-use">
            <Button small disabled={!picked || picked === res.release?.releaseId || !!busy} onClick={() => picked && void lookup(picked)}>
              {busy === 'lookup' ? 'Loading…' : 'Use this release'}
            </Button>
          </div>
        </details>
      )}

      <div className="row gi-mb-actions">
        <Button kind="ghost" small disabled={!!busy} onClick={() => void lookup()}>
          Look up again
        </Button>
        <span className="grow" />
        {busy && <Spinner />}
        <Button kind="primary" disabled={!changes.length || !!busy} onClick={() => void apply()}>
          {busy === 'apply' ? 'Applying…' : changes.length ? `Apply ${plural(fieldCount, 'change')}` : 'Nothing to apply'}
        </Button>
      </div>
    </div>
  )
}
