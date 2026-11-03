// Get Info: edit tags for one or many tracks. Only fields the user touched are written; files are
// re-pathed by main when artist/album/title/year change.

import { useEffect, useMemo, useRef, useState } from 'react'
import type { TrackRow, TrackTags } from '@shared/types'
import { LIB, type EditTagsResult } from '@shared/ipc/library'
import { errorMessage, invoke, revealLabel } from '../../lib/ipc'
import { duration, plural, quality, relativeTime } from '../../lib/format'
import { toast, useUi } from '../../state/ui'
import { Artwork, Button, Modal, Segmented, Spinner, Stars } from '../../components/ui'
import { cx } from '../../lib/format'

type Kind = 'text' | 'int' | 'bool' | 'area'
interface FieldDef {
  key: keyof TrackTags
  label: string
  kind: Kind
  wide?: boolean
  /** Hidden when editing several tracks (per-track values). */
  single?: boolean
}

const DETAILS: FieldDef[] = [
  { key: 'title', label: 'Title', kind: 'text', wide: true, single: true },
  { key: 'artist', label: 'Artist', kind: 'text', wide: true },
  { key: 'album', label: 'Album', kind: 'text', wide: true },
  { key: 'albumartist', label: 'Album Artist', kind: 'text', wide: true },
  { key: 'genre', label: 'Genre', kind: 'text' },
  { key: 'date', label: 'Date (YYYY or YYYY-MM-DD)', kind: 'text' },
  { key: 'tracknumber', label: 'Track', kind: 'int', single: true },
  { key: 'totaltracks', label: 'of', kind: 'int' },
  { key: 'discnumber', label: 'Disc', kind: 'int' },
  { key: 'totaldiscs', label: 'of', kind: 'int' },
  { key: 'compilation', label: 'Compilation (Various Artists)', kind: 'bool' },
  { key: 'bpm', label: 'BPM', kind: 'int', single: true },
  { key: 'comment', label: 'Comment', kind: 'text', wide: true },
]
const SORTING: FieldDef[] = [
  { key: 'titlesort', label: 'Sort Title', kind: 'text', single: true },
  { key: 'artistsort', label: 'Sort Artist', kind: 'text' },
  { key: 'albumsort', label: 'Sort Album', kind: 'text' },
  { key: 'albumartistsort', label: 'Sort Album Artist', kind: 'text' },
  { key: 'label', label: 'Label', kind: 'text' },
  { key: 'catalognumber', label: 'Catalog #', kind: 'text' },
  { key: 'isrc', label: 'ISRC', kind: 'text', single: true },
  { key: 'barcode', label: 'Barcode', kind: 'text' },
  { key: 'copyright', label: 'Copyright', kind: 'text', wide: true },
]
const LYRICS: FieldDef[] = [{ key: 'lyrics', label: 'Lyrics (LRC timestamps make them synced)', kind: 'area', wide: true, single: true }]

type Values = Partial<Record<keyof TrackTags, unknown>>
const MIXED = Symbol('mixed')

function common(all: TrackTags[], key: keyof TrackTags): unknown {
  if (!all.length) return undefined
  const first = all[0][key]
  return all.every((t) => JSON.stringify(t[key] ?? null) === JSON.stringify(first ?? null)) ? first : MIXED
}

export function GetInfo() {
  const ids = useUi((s) => s.getInfo)
  const close = () => useUi.getState().openGetInfo(null)
  if (!ids) return null
  return <GetInfoModal key={ids.join(',')} ids={ids} onClose={close} />
}

function GetInfoModal({ ids, onClose }: { ids: number[]; onClose: () => void }) {
  const [rows, setRows] = useState<TrackRow[] | null>(null)
  const [tags, setTags] = useState<TrackTags[] | null>(null)
  const [hasArt, setHasArt] = useState(false)
  const [edits, setEdits] = useState<Values>({})
  const [tab, setTab] = useState<'details' | 'sorting' | 'lyrics' | 'file'>('details')
  const [saving, setSaving] = useState(false)
  const [art, setArt] = useState<{ data: Uint8Array; mime: string; url: string } | null | undefined>(undefined)
  const [dropping, setDropping] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)
  const multi = ids.length > 1

  useEffect(() => {
    let live = true
    void (async () => {
      const r = await invoke<TrackRow[]>(LIB.tracksByIds, ids)
      // Reading full tags means probing each file; cap it so a 2,000-track selection stays snappy.
      const sample = r.slice(0, 200)
      const t = await Promise.all(sample.map((x) => invoke<{ tags: TrackTags; hasArt: boolean } | null>(LIB.getTags, x.id)))
      if (!live) return
      setRows(r)
      setTags(t.map((x) => x?.tags ?? {}))
      setHasArt(t.some((x) => x?.hasArt))
    })().catch((e) => toast(errorMessage(e), 'error'))
    return () => {
      live = false
    }
  }, [ids])

  useEffect(() => () => void (art?.url && URL.revokeObjectURL(art.url)), [art])

  const base = useMemo(() => {
    const out: Values = {}
    if (!tags) return out
    for (const f of [...DETAILS, ...SORTING, ...LYRICS]) out[f.key] = common(tags, f.key)
    return out
  }, [tags])

  const value = (k: keyof TrackTags) => (k in edits ? edits[k] : base[k])
  const setValue = (k: keyof TrackTags, v: unknown) => setEdits({ ...edits, [k]: v })

  const loadImage = async (file: File | undefined) => {
    if (!file || !file.type.startsWith('image/')) return
    const data = new Uint8Array(await file.arrayBuffer())
    setArt({ data, mime: file.type, url: URL.createObjectURL(file) })
  }

  const save = async () => {
    setSaving(true)
    try {
      const patch: Values = {}
      for (const [k, v] of Object.entries(edits)) {
        if (v === MIXED) continue
        patch[k as keyof TrackTags] = v === '' ? null : v
      }
      let res: EditTagsResult | null = null
      if (art !== undefined) res = await invoke<EditTagsResult>(LIB.setArtwork, ids, art ? art.data : null, art?.mime)
      if (Object.keys(patch).length) res = await invoke<EditTagsResult>(LIB.editTags, { ids, patch })
      if (res?.errors.length) toast(`${plural(res.errors.length, 'file')} couldn’t be saved: ${res.errors[0].error}`, 'error')
      else if (res) toast(res.moved ? `Saved · ${plural(res.moved, 'file')} renamed to match` : 'Saved', 'ok')
      onClose()
    } catch (e) {
      toast(errorMessage(e), 'error')
    } finally {
      setSaving(false)
    }
  }

  const first = rows?.[0]
  const dirty = Object.keys(edits).length > 0 || art !== undefined
  const title = multi ? `${plural(ids.length, 'song')} selected` : (first?.title ?? 'Get Info')

  const renderField = (f: FieldDef) => {
    if (multi && f.single) return null
    const v = value(f.key)
    const mixed = v === MIXED
    const label = <span>{f.label}</span>
    if (f.kind === 'bool')
      return (
        <label key={f.key} className={cx('row', f.wide && 'wide')} style={{ gridColumn: '1 / -1' }}>
          <input type="checkbox" className="toggle" checked={!mixed && !!v} onChange={(e) => setValue(f.key, e.target.checked)} />
          {f.label}
          {mixed && <span className="faint">(mixed)</span>}
        </label>
      )
    if (f.kind === 'area')
      return (
        <label key={f.key} className="field wide">
          {label}
          <textarea rows={16} value={mixed ? '' : String(v ?? '')} placeholder={mixed ? 'Mixed' : ''} onChange={(e) => setValue(f.key, e.target.value)} />
        </label>
      )
    return (
      <label key={f.key} className={cx('field', f.wide && 'wide')}>
        {label}
        <input
          type={f.kind === 'int' ? 'number' : 'text'}
          className={cx(mixed && 'mixed')}
          value={mixed || v == null ? '' : String(v)}
          placeholder={mixed ? 'Mixed' : ''}
          onChange={(e) => setValue(f.key, f.kind === 'int' ? (e.target.value === '' ? '' : Math.max(0, Math.floor(Number(e.target.value)))) : e.target.value)}
        />
      </label>
    )
  }

  const artNode =
    art === null ? (
      <Artwork title={first?.album} />
    ) : art ? (
      <Artwork url={art.url} />
    ) : (
      <Artwork hash={first?.artHash} px={300} title={first?.album} />
    )

  return (
    <Modal
      title={title}
      onClose={onClose}
      width={640}
      footer={
        <>
          {!multi && first && (
            <Button kind="ghost" className="left" icon="folder" onClick={() => void invoke(LIB.reveal, first.id)}>
              {revealLabel}
            </Button>
          )}
          <Button kind="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button kind="primary" disabled={!dirty || saving} onClick={() => void save()}>
            {saving ? 'Saving…' : 'Save'}
          </Button>
        </>
      }
    >
      {!rows || !tags ? (
        <div className="center-spin">
          <Spinner />
        </div>
      ) : (
        <>
          <div className="gi-top">
            <div
              className={cx('gi-art', dropping && 'drop')}
              onDragOver={(e) => {
                if (e.dataTransfer.types.includes('Files')) {
                  e.preventDefault()
                  e.stopPropagation()
                  setDropping(true)
                }
              }}
              onDragLeave={() => setDropping(false)}
              onDrop={(e) => {
                e.preventDefault()
                e.stopPropagation()
                setDropping(false)
                void loadImage(e.dataTransfer.files[0])
              }}
            >
              {artNode}
              <div className="gi-art-actions">
                <Button small onClick={() => fileInput.current?.click()}>
                  Replace…
                </Button>
                {(hasArt || art) && art !== null && (
                  <Button small kind="ghost" onClick={() => setArt(null)}>
                    Remove
                  </Button>
                )}
              </div>
              <input ref={fileInput} type="file" accept="image/*" hidden onChange={(e) => void loadImage(e.target.files?.[0])} />
            </div>
            <div className="stack grow" style={{ gap: 4, minWidth: 0 }}>
              <div style={{ fontWeight: 650, fontSize: 15 }} className="ellipsis">
                {multi ? (common(tags, 'album') === MIXED ? 'Multiple albums' : String(tags[0].album ?? '')) : first?.title}
              </div>
              <div className="muted ellipsis">{multi ? (common(tags, 'albumartist') === MIXED ? 'Multiple artists' : String(tags[0].albumartist ?? '')) : `${first?.artist} — ${first?.album}`}</div>
              {!multi && first && (
                <div className="row" style={{ marginTop: 6 }}>
                  <Stars rating={first.rating} size={14} onRate={(s) => void invoke(LIB.setRating, [first.id], s).then(() => setRows([{ ...first, rating: s * 20 }]))} />
                </div>
              )}
              {!multi && first && <div className="faint" style={{ fontSize: 12 }}>{quality(first)} · {duration(first.durationMs)}</div>}
              {multi && ids.length > tags.length && <div className="faint" style={{ fontSize: 12 }}>Showing shared values from the first {tags.length}.</div>}
            </div>
          </div>
          <Segmented
            className="tabs"
            value={tab}
            onChange={setTab}
            options={[
              { value: 'details', label: 'Details' },
              { value: 'sorting', label: 'Sorting & IDs' },
              ...(!multi ? [{ value: 'lyrics' as const, label: 'Lyrics' }] : []),
              ...(!multi ? [{ value: 'file' as const, label: 'File' }] : []),
            ]}
          />
          {tab === 'details' && <div className="form-grid">{DETAILS.map(renderField)}</div>}
          {tab === 'sorting' && <div className="form-grid">{SORTING.map(renderField)}</div>}
          {tab === 'lyrics' && <div className="form-grid">{LYRICS.map(renderField)}</div>}
          {tab === 'file' && first && <FileInfo row={first} tags={tags[0]} />}
        </>
      )}
    </Modal>
  )
}

function FileInfo({ row, tags }: { row: TrackRow; tags: TrackTags }) {
  const kv: Array<[string, string]> = [
    ['Location', row.relPath],
    ['Format', quality(row)],
    ['Sample rate', `${(row.sampleRate / 1000).toFixed(1)} kHz`],
    ['Bit rate', `${Math.round(row.bitrate / 1000)} kbps`],
    ['Duration', duration(row.durationMs)],
    ['Added', relativeTime(row.addedAt)],
    ['Plays', String(row.playCount)],
    ['Source', row.source ?? 'import'],
    ['ReplayGain', row.rgTrackGain != null ? `${row.rgTrackGain.toFixed(2)} dB track${row.rgAlbumGain != null ? ` · ${row.rgAlbumGain.toFixed(2)} dB album` : ''}` : '—'],
    ['MusicBrainz recording', tags.musicbrainz_recordingid ?? '—'],
    ['MusicBrainz release', tags.musicbrainz_albumid ?? '—'],
    ['AcoustID', tags.acoustid_id ?? '—'],
    ['TIDAL track', row.tidalTrackId ?? '—'],
    ['Bandcamp item', row.bandcampItemId ?? '—'],
  ]
  return (
    <div className="kv" style={{ userSelect: 'text' }}>
      {kv.map(([k, v]) => (
        <FragmentRow key={k} k={k} v={v} />
      ))}
    </div>
  )
}

function FragmentRow({ k, v }: { k: string; v: string }) {
  return (
    <>
      <span>{k}</span>
      <span className={cx(/^[0-9a-f-]{36}$/.test(v) && 'mono', 'ellipsis')} title={v}>
        {v}
      </span>
    </>
  )
}
