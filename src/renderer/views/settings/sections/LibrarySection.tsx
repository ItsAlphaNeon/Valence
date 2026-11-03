import { useMemo, useState } from 'react'
import { invoke, errorMessage } from '../../../lib/ipc'
import { bytes, cx, longDuration, plural } from '../../../lib/format'
import { useLib } from '../../../state/library'
import { toast } from '../../../state/ui'
import { LIB } from '@shared/ipc/library'
import { DEFAULT_TEMPLATE, renderRelStem } from '@shared/path-template'
import type { TrackTags } from '@shared/types'
import { Button, ProgressBar, Spinner } from '../../../components/ui'
import { Icon } from '../../../components/Icon'
import { Card, PathLine, Row, SectionHead, Stat, StackRow, useAppInfo, useSettingValue } from '../controls'

interface RescanResult {
  added: number
  updated: number
  removed: number
  unchanged: number
  errors: Array<{ rel: string; error: string }>
  conflicts: number
  playlists: number
  moved: Array<{ from: string; to: string }>
  durationMs: number
}

const TOKENS: Array<{ token: string; desc: string }> = [
  { token: 'albumartist_primary', desc: 'First album artist (Various Artists for compilations)' },
  { token: 'albumartist', desc: 'Full album-artist credit' },
  { token: 'artist', desc: 'Track artist' },
  { token: 'album', desc: 'Album title' },
  { token: 'year', desc: 'Release year' },
  { token: 'title', desc: 'Track title' },
  { token: 'track', desc: 'Track number, two digits' },
  { token: 'disc', desc: 'Disc number' },
  { token: 'genre', desc: 'Genre' },
]
const KNOWN = new Set(TOKENS.map((t) => t.token))

const SAMPLES: Array<{ tags: TrackTags; ext: string }> = [
  { tags: { title: 'Harder, Better, Faster, Stronger', artist: 'Daft Punk', albumartist: 'Daft Punk', album: 'Discovery', date: '2001-03-12', tracknumber: 4, discnumber: 1, genre: 'Electronic' }, ext: 'mp3' },
  { tags: { title: 'Midnight City', artist: 'M83', albumartist: 'M83', album: 'Hurry Up, We’re Dreaming', tracknumber: 2, discnumber: 1, genre: 'Synth-pop' }, ext: 'mp3' },
]

/** Returns an error for templates main can't render sensibly. */
function templateError(t: string): string | null {
  if (!t.trim()) return 'The template can’t be empty.'
  let depth = 0
  for (const ch of t) {
    if (ch === '[') depth++
    else if (ch === ']') depth--
    if (depth < 0 || depth > 1) return 'Optional groups use one level of [ … ] brackets.'
  }
  if (depth !== 0) return 'An optional group is missing its closing ].'
  const unknown = [...t.matchAll(/\{(\w*)\}/g)].map((m) => m[1]).filter((k) => !KNOWN.has(k))
  if (unknown.length) return `Unknown token: {${unknown[0]}}`
  if (/[<>:"|?*\\]/.test(t.replace(/\{\w+\}/g, ''))) return 'The template contains characters that aren’t allowed in file names.'
  if (t.startsWith('/') || t.endsWith('/') || t.includes('//')) return 'Folders can’t be empty — check the slashes.'
  return null
}

function TemplateEditor() {
  const [saved, setSaved] = useSettingValue<string>('library.template', DEFAULT_TEMPLATE)
  const [draft, setDraft] = useState<string | null>(null)
  const text = draft ?? saved
  const error = templateError(text)
  const examples = useMemo(() => {
    if (error) return []
    try {
      return SAMPLES.map((s) => `${renderRelStem(text, s.tags)}.${s.ext}`)
    } catch {
      return []
    }
  }, [text, error])
  const commit = () => {
    if (draft === null) return
    const v = draft.trim()
    setDraft(null)
    if (v === saved) return
    const err = templateError(v)
    if (err) {
      toast(err, 'error')
      return
    }
    setSaved(v)
    toast('Path template saved', 'ok')
  }
  const noTitle = !error && !/\{title\}/.test(text)
  return (
    <StackRow
      label="File naming"
      desc={
        <>
          Where new imports are filed inside the library. <span className="mono">{'{token}'}</span> inserts a tag; <span className="mono">[ … ]</span> is dropped when a token inside it is empty; <span className="mono">/</span> starts a folder. Applies to
          new imports and tag edits — existing files aren’t moved.
        </>
      }
    >
      <div className="set-template">
        <input
          className={cx('mono', error && 'invalid')}
          value={text}
          spellCheck={false}
          aria-label="Path template"
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur()
            if (e.key === 'Escape') {
              setDraft(null)
              setTimeout(() => (e.target as HTMLInputElement).blur())
            }
          }}
        />
        {saved !== DEFAULT_TEMPLATE || draft !== null ? (
          <Button
            small
            kind="ghost"
            icon="undo"
            onClick={() => {
              setDraft(null)
              if (saved !== DEFAULT_TEMPLATE) {
                setSaved(DEFAULT_TEMPLATE)
                toast('Path template reset to default', 'ok')
              }
            }}
            title="Restore the default template"
          >
            Default
          </Button>
        ) : null}
      </div>
      {error ? (
        <div className="set-template-msg err">
          <Icon name="warning" size={13} /> {error}
        </div>
      ) : (
        <div className="set-examples">
          {examples.map((ex) => (
            <div key={ex} className="set-example">
              <span className="faint">e.g.</span> <span className="mono selectable">{ex}</span>
            </div>
          ))}
          {noTitle && (
            <div className="set-template-msg warn">
              <Icon name="warning" size={13} /> Without <span className="mono">{'{title}'}</span>, tracks of one album would share a name and get numbered suffixes.
            </div>
          )}
        </div>
      )}
      <div className="set-tokens">
        {TOKENS.map((t) => (
          <span key={t.token} className="chip mono" title={t.desc}>
            {`{${t.token}}`}
          </span>
        ))}
      </div>
      <div className="field-hint">
        Default: <span className="mono selectable">{DEFAULT_TEMPLATE}</span> — folders are laid out as <b>Artist / Album (Year) / Title</b>.
      </div>
    </StackRow>
  )
}

export function LibrarySection() {
  const { info } = useAppInfo()
  const stats = useLib((s) => s.stats)
  const scan = useLib((s) => s.scan)
  const [busy, setBusy] = useState<false | 'quick' | 'full'>(false)
  const [result, setResult] = useState<RescanResult | null>(null)
  const root = info?.libraryRoot ?? stats?.libraryRoot ?? null
  const scanning = !!busy || !!scan || !!stats?.scanning

  const rescan = async (force: boolean) => {
    setBusy(force ? 'full' : 'quick')
    setResult(null)
    try {
      const r = await invoke<RescanResult>(LIB.rescan, force)
      setResult(r)
      const changed = r.added + r.updated + r.removed
      toast(changed ? `Rescan finished: ${plural(changed, 'change')}` : 'Rescan finished: library is up to date', 'ok')
    } catch (e) {
      toast(`Rescan failed: ${errorMessage(e)}`, 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <SectionHead icon="songs" title="Library">
        Your music lives in plain folders you can sync with Syncthing. Valence indexes them and keeps tags and files in step.
      </SectionHead>

      <Card title="Location">
        <PathLine path={root} empty="Loading…" />
        <div className="set-stats">
          <Stat label="Songs" value={stats ? stats.tracks.toLocaleString() : '—'} />
          <Stat label="Albums" value={stats ? stats.albums.toLocaleString() : '—'} />
          <Stat label="Artists" value={stats ? stats.artists.toLocaleString() : '—'} />
          <Stat label="Listening time" value={stats ? longDuration(stats.durationMs) : '—'} />
          <Stat label="On disk" value={stats ? bytes(stats.bytes) : '—'} />
        </div>
      </Card>

      <Card title="Scan">
        <Row label="Rescan library" desc="Picks up files added, changed or removed outside Valence. Valence also watches the folder while it runs.">
          <Button icon="refresh" onClick={() => void rescan(false)} disabled={scanning}>
            Rescan
          </Button>
        </Row>
        <Row label="Full rescan" desc="Re-reads tags from every file, even ones that look unchanged. Slower.">
          <Button kind="ghost" onClick={() => void rescan(true)} disabled={scanning}>
            Full Rescan
          </Button>
        </Row>
        {scanning && (
          <div className="set-scan">
            <Spinner size={14} />
            <span className="muted tnum">{scan ? `Scanning ${scan.done.toLocaleString()} of ${scan.total.toLocaleString()}…` : busy === 'full' ? 'Re-reading every file…' : 'Scanning…'}</span>
            <div className="grow">
              <ProgressBar value={scan && scan.total ? scan.done / scan.total : 0} indeterminate={!scan || !scan.total} />
            </div>
          </div>
        )}
        {result && !scanning && (
          <div className="set-scan-result">
            <Icon name="check" size={14} />
            <span>
              Finished in {(result.durationMs / 1000).toFixed(1)} s — {result.added} added, {result.updated} updated, {result.removed} removed
              {result.moved.length ? `, ${result.moved.length} moved` : ''}
              {result.conflicts ? `, ${plural(result.conflicts, 'sync conflict')}` : ''}.
            </span>
            {result.errors.length > 0 && (
              <span className="chip err" title={result.errors.slice(0, 8).map((e) => `${e.rel}: ${e.error}`).join('\n')}>
                {plural(result.errors.length, 'file')} unreadable
              </span>
            )}
          </div>
        )}
      </Card>

      <Card title="Organization">
        <TemplateEditor />
      </Card>
    </>
  )
}
