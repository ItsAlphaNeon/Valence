// Needs Review: loose imports MusicBrainz couldn't match confidently. Pick a release, search for one,
// or import with the files' own tags.

import { useMemo, useState } from 'react'
import { cx, duration, plural } from '../../lib/format'
import { useLib } from '../../state/library'
import { toast } from '../../state/ui'
import { IMPORT, type JobInfo, type JobReview, type ReviewCandidate } from '@shared/ipc/import'
import { Button, Empty, Spinner } from '../../components/ui'
import { Icon } from '../../components/Icon'
import { attempt, pct, run, scoreKind, sourceLabel } from './common'

function mostCommon(xs: string[]): string {
  const counts = new Map<string, number>()
  for (const x of xs) if (x.trim()) counts.set(x.trim(), (counts.get(x.trim()) ?? 0) + 1)
  let best = ''
  let n = 0
  for (const [k, c] of counts) if (c > n) [best, n] = [k, c]
  return best
}

export function CandidateRow({ c, picked, onPick, fileCount, relevance }: { c: ReviewCandidate; picked: boolean; onPick: () => void; fileCount: number; relevance?: boolean }) {
  const year = c.date?.slice(0, 4)
  const meta = [c.artist, c.date, c.country, c.format, plural(c.trackCount, 'track')].filter(Boolean)
  const mismatch = c.trackCount !== fileCount
  return (
    <button role="radio" aria-checked={picked} className={cx('imp-cand', picked && 'on')} onClick={onPick} onDoubleClick={onPick} title={`MusicBrainz release ${c.releaseId}`}>
      <span className="imp-radio" aria-hidden />
      <span className="list-main">
        <span className="imp-cand-title">
          <span className="ellipsis">{c.title}</span>
          {year && <span className="faint tnum">({year})</span>}
          {c.type && <span className="chip imp-mini">{c.type}</span>}
          {c.status && c.status.toLowerCase() !== 'official' && <span className="chip imp-mini warn">{c.status}</span>}
        </span>
        <span className="list-sub">{meta.join(' · ')}</span>
      </span>
      {mismatch && (
        <span className="chip warn imp-mini" title={`This release has ${c.trackCount} tracks; you’re importing ${fileCount} files`}>
          {c.trackCount} vs {fileCount}
        </span>
      )}
      <span className={cx('chip tnum imp-score', scoreKind(c.score))} title={relevance ? 'MusicBrainz search relevance' : 'Match confidence'}>
        {pct(c.score)}
      </span>
    </button>
  )
}

function ReviewDetail({ job, review }: { job: JobInfo; review: JobReview }) {
  const files = review.tracks
  const [picked, setPicked] = useState<string | null>(review.status === 'review' ? (review.candidates[0]?.releaseId ?? null) : null)
  const [busy, setBusy] = useState<null | 'resolve' | 'asis' | 'skip'>(null)
  const [q, setQ] = useState(() => ({ artist: mostCommon(files.map((t) => t.artist)), album: mostCommon(files.map((t) => t.album)) || job.title, barcode: '' }))
  const [results, setResults] = useState<ReviewCandidate[] | null>(null)
  const [searching, setSearching] = useState(false)
  const all = useMemo(() => [...review.candidates, ...(results ?? [])], [review.candidates, results])
  const pickedC = all.find((c) => c.releaseId === picked) ?? null
  const totalMs = files.reduce((s, t) => s + (t.durationMs || 0), 0)

  const search = async () => {
    if (!q.album.trim() && !q.barcode.trim()) {
      toast('Enter an album title or a barcode to search', 'info')
      return
    }
    setSearching(true)
    const r = await run<ReviewCandidate[]>(IMPORT.searchReleases, [{ artist: q.artist.trim() || undefined, album: q.album.trim() || undefined, barcode: q.barcode.trim() || undefined }], 'Search failed')
    setSearching(false)
    if (!r) return
    const known = new Set(review.candidates.map((c) => c.releaseId))
    setResults(r.filter((c) => !known.has(c.releaseId)))
    if (!r.length) toast('No releases found', 'info')
  }

  const resolve = async (choice: { releaseId: string } | { asIs: true }) => {
    setBusy('releaseId' in choice ? 'resolve' : 'asis')
    const ok = await attempt(IMPORT.resolveReview, [job.id, choice], 'Couldn’t continue the import')
    setBusy(null)
    if (ok) toast('releaseId' in choice ? `Importing as “${pickedC?.title ?? 'the chosen release'}”` : `Importing “${job.title}” with its own tags`, 'ok')
  }

  const skip = async () => {
    setBusy('skip')
    const ok = await attempt(IMPORT.cancel, [job.id], 'Couldn’t cancel the import')
    setBusy(null)
    if (ok) toast(`Skipped “${job.title}”`, 'info')
  }

  return (
    <div className="imp-review-detail">
      <div className="imp-review-head">
        <div className="grow">
          <h2 className="imp-review-title">{job.title}</h2>
          <div className="imp-review-meta">
            <span className="chip imp-src">{sourceLabel(job.source)}</span>
            <span>
              {plural(files.length, 'file')} · {duration(totalMs)}
            </span>
            {review.status === 'unmatched' ? (
              <span className="chip warn">No confident match</span>
            ) : (
              <span className={cx('chip', scoreKind(review.score))}>Best match {pct(review.score)}</span>
            )}
          </div>
        </div>
      </div>

      <section className="card glass imp-panel">
        <h3>Files</h3>
        <div className="imp-files" role="table">
          {files.map((t) => (
            <div key={t.index} className="imp-file" role="row">
              <span className="faint tnum">{t.index + 1}</span>
              <span className="imp-file-main">
                <span className="ellipsis">{t.title || <span className="faint">Untitled</span>}</span>
                {t.relPath && (
                  <span className="mono faint ellipsis imp-file-path" title={t.relPath}>
                    {t.relPath}
                  </span>
                )}
              </span>
              <span className="muted ellipsis">{t.artist}</span>
              <span className="muted ellipsis">{t.album}</span>
              <span className="faint tnum imp-file-time">{duration(t.durationMs)}</span>
            </div>
          ))}
        </div>
      </section>

      <section className="card glass imp-panel">
        <h3>{review.candidates.length ? 'Possible releases' : 'No candidates found'}</h3>
        {review.candidates.length ? (
          <div className="imp-cands" role="radiogroup" aria-label="Candidate releases">
            {review.candidates.map((c) => (
              <CandidateRow key={c.releaseId} c={c} picked={picked === c.releaseId} onPick={() => setPicked(c.releaseId)} fileCount={files.length} />
            ))}
          </div>
        ) : (
          <p className="muted imp-panel-note">MusicBrainz didn’t return anything close. Search below, or import the files with their own tags.</p>
        )}

        <form
          className="imp-search"
          onSubmit={(e) => {
            e.preventDefault()
            void search()
          }}
        >
          <label className="field">
            <span>Artist</span>
            <input value={q.artist} onChange={(e) => setQ({ ...q, artist: e.target.value })} placeholder="Artist" spellCheck={false} />
          </label>
          <label className="field">
            <span>Album</span>
            <input value={q.album} onChange={(e) => setQ({ ...q, album: e.target.value })} placeholder="Album title" spellCheck={false} />
          </label>
          <label className="field imp-search-barcode">
            <span>Barcode</span>
            <input value={q.barcode} onChange={(e) => setQ({ ...q, barcode: e.target.value })} placeholder="Optional" inputMode="numeric" spellCheck={false} />
          </label>
          <button type="submit" className="btn btn-default imp-search-btn" disabled={searching}>
            {searching ? <Spinner size={14} /> : <Icon name="search" size={15} />}
            <span>Search MusicBrainz</span>
          </button>
        </form>

        {results && (
          <>
            <div className="imp-subhead">
              Search results <span className="faint tnum">{results.length}</span>
            </div>
            {results.length ? (
              <div className="imp-cands" role="radiogroup" aria-label="Search results">
                {results.map((c) => (
                  <CandidateRow key={c.releaseId} c={c} picked={picked === c.releaseId} onPick={() => setPicked(c.releaseId)} fileCount={files.length} relevance />
                ))}
              </div>
            ) : (
              <p className="muted imp-panel-note">Nothing new — try a shorter title or the barcode from the case.</p>
            )}
          </>
        )}
      </section>

      <div className="imp-review-bar glass glass-strong">
        <Button kind="ghost" className="btn-danger" onClick={() => void skip()} disabled={!!busy} title="Cancel this import; the files stay where they are">
          Don’t Import
        </Button>
        <span className="grow imp-review-bar-text ellipsis">{pickedC ? `${pickedC.title} — ${pickedC.artist}` : 'Choose a release, or import with the files’ own tags.'}</span>
        <Button onClick={() => void resolve({ asIs: true })} disabled={!!busy} title="Keep the tags already in the files">
          {busy === 'asis' ? 'Importing…' : 'Import As-Is'}
        </Button>
        <Button kind="primary" onClick={() => pickedC && void resolve({ releaseId: pickedC.releaseId })} disabled={!pickedC || !!busy}>
          {busy === 'resolve' ? 'Importing…' : 'Use This Release'}
        </Button>
      </div>
    </div>
  )
}

export function ReviewTab() {
  const jobs = useLib((s) => s.jobs)
  const review = useMemo(() => jobs.filter((j) => j.status === 'review' && j.review).sort((a, b) => a.createdAt - b.createdAt), [jobs])
  const [sel, setSel] = useState<string | null>(null)
  const cur = review.find((j) => j.id === sel) ?? review[0]

  if (!cur) {
    return (
      <Empty icon="check" title="Nothing needs review">
        <span>When Valence can’t confidently match an import to a MusicBrainz release, it waits here for you to pick the right one.</span>
      </Empty>
    )
  }

  return (
    <div className={cx('imp-review', review.length > 1 && 'multi')}>
      {review.length > 1 && (
        <nav className="imp-review-list" aria-label="Imports needing review">
          {review.map((j) => (
            <button key={j.id} className={cx('imp-review-item', j.id === cur.id && 'on')} onClick={() => setSel(j.id)}>
              <span className="list-title">{j.title}</span>
              <span className="list-sub">
                {plural(j.review!.tracks.length, 'file')} · {j.review!.status === 'unmatched' ? 'no match' : `best ${pct(j.review!.score)}`}
              </span>
            </button>
          ))}
        </nav>
      )}
      <ReviewDetail key={cur.id} job={cur} review={cur.review!} />
    </div>
  )
}
