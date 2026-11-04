import { useState } from 'react'
import type { TrackRow } from '@shared/types'
import { LIB } from '@shared/ipc/library'
import type { SmartField, SmartOp, SmartRule, SmartRules } from '@main/library/playlists'
import { errorMessage, invoke } from '../../lib/ipc'
import { longDuration, plural } from '../../lib/format'
import { useLib, useLibData } from '../../state/library'
import { addToQueue, playNext, playShuffled, playTracks } from '../../state/player'
import { setLiked } from '../../state/favorites'
import { navigate, toast, useUi } from '../../state/ui'
import { TrackTable } from '../../components/TrackTable'
import { ActionBar, Hero, PlayButton, useSourcePlaying } from '../../components/Hero'
import { Artwork, Button, Empty, IconButton, Segmented, Spinner, showMenu, usePrompt } from '../../components/ui'
import { Icon } from '../../components/Icon'

function Mosaic({ rows, onOpen }: { rows: TrackRow[]; onOpen: (hash: string) => void }) {
  const hashes = [...new Set(rows.map((r) => r.artHash).filter((h): h is string => !!h))].slice(0, 4)
  if (!hashes.length) return null
  return (
    <button className="hero-art-btn" title="View artwork" onClick={() => onOpen(hashes[0])}>
      {hashes.length < 4 ? (
        <Artwork hash={hashes[0]} px={600} className="hero-art" title={rows[0]?.album} />
      ) : (
        <span className="hero-art mosaic">
          {hashes.map((h) => (
            <Artwork key={h} hash={h} px={300} />
          ))}
        </span>
      )}
    </button>
  )
}

export function PlaylistView({ id }: { id: string }) {
  const info = useLib((s) => s.playlists.find((p) => p.id === id))
  const playlists = useLib((s) => s.playlists)
  const { data: rows, loading } = useLibData(() => invoke<TrackRow[]>(LIB.playlistTracks, id), [id], { playlists: true })
  const [promptNode, prompt] = usePrompt()
  const src = { kind: 'playlist' as const, id, title: info?.name }
  const now = useSourcePlaying((s) => s?.kind === 'playlist' && s.id === id)
  if (!info)
    return (
      <div className="view">
        {loading ? (
          <div className="center-spin">
            <Spinner />
          </div>
        ) : (
          <Empty icon="playlist" title="Playlist not found" />
        )}
      </div>
    )
  const list = rows ?? []
  const ids = list.map((r) => r.id)
  const total = list.reduce((n, r) => n + r.durationMs, 0)
  const kicker = info.kind === 'smart' ? 'Smart playlist' : info.kind === 'mirror' ? 'Mirrored playlist' : 'Playlist'
  const firstArt = list.find((r) => r.artHash)?.artHash
  const play = () => void playTracks(ids, 0, src)
  const rename = async () => {
    const name = await prompt({ title: 'Rename playlist', label: 'Name', initial: info.name, ok: 'Rename' })
    if (!name || name === info.name) return
    try {
      if (info.kind === 'smart') await invoke(LIB.saveSmartPlaylist, name, info.rules, id)
      else {
        const nid = await invoke<string>(LIB.renamePlaylist, id, name)
        if (nid && nid !== id) navigate({ view: 'playlist', id: nid })
      }
    } catch (err) {
      toast(errorMessage(err), 'error')
    }
  }
  const remove = () => {
    const i = playlists.findIndex((p) => p.id === id)
    void invoke(LIB.deletePlaylist, id).then(() => {
      toast(`Deleted “${info.name}”`, 'ok')
      const next = playlists[i + 1] ?? playlists[i - 1]
      navigate(next && next.id !== id ? { view: 'playlist', id: next.id } : { view: 'albums' })
    })
  }
  const more = (e: React.MouseEvent) =>
    showMenu(e, [
      { label: 'Play next', icon: 'queue', disabled: !ids.length, onClick: () => void playNext(ids) },
      { label: 'Add to queue', disabled: !ids.length, onClick: () => void addToQueue(ids) },
      { label: 'Add all to Favorites', icon: 'heart', disabled: !ids.length, onClick: () => void setLiked({ kind: 'track', ids }, true) },
      { label: 'Get Info', icon: 'info', disabled: !ids.length, onClick: () => useUi.getState().openGetInfo(ids) },
      { separator: true },
      ...(info.kind === 'smart' ? [{ label: 'Edit rules', icon: 'smart' as const, onClick: () => navigate({ view: 'smart', id }) }] : []),
      { label: 'Rename…', icon: 'edit', disabled: info.kind === 'mirror', onClick: () => void rename() },
      { label: 'Delete playlist', icon: 'trash', danger: true, onClick: remove },
    ])

  return (
    <div className="view">
      <Hero
        art={{ hash: firstArt, title: info.name }}
        tile={
          list.length && firstArt ? (
            <Mosaic rows={list} onOpen={(hash) => useUi.getState().openArt({ hash, title: info.name })} />
          ) : (
            <span className="hero-art playlist-tile">
              <Icon name={info.kind === 'smart' ? 'smart' : 'playlist'} size={72} />
            </span>
          )
        }
        kicker={kicker}
        title={info.name}
        play={ids.length ? play : undefined}
        info={
          <>
            {plural(list.length, 'song')}
            {total > 0 && `, ${longDuration(total)}`}
            {info.relPath && <span className="hero-dim mono"> · {info.relPath}</span>}
          </>
        }
      />
      <ActionBar>
        <PlayButton onPlay={play} current={now.current} playing={now.playing} title={`Play ${info.name}`} />
        <IconButton icon="shuffle" size={26} title="Shuffle" disabled={!ids.length} onClick={() => void playShuffled(ids, src)} />
        {info.kind === 'smart' && (
          <Button icon="smart" onClick={() => navigate({ view: 'smart', id })}>
            Edit rules
          </Button>
        )}
        <IconButton icon="more" size={26} title={`More options for ${info.name}`} onClick={more} />
      </ActionBar>
      <TrackTable
        rows={list}
        playlistId={id}
        source={src}
        showArt
        columns={['index', 'title', 'album', 'heart', 'time', 'rating']}
        emptyText={info.kind === 'static' ? 'Drag songs onto this playlist in the sidebar, or use “Add to playlist” from a song’s menu.' : 'No songs match these rules.'}
      />
      {promptNode}
    </div>
  )
}

// ---- Smart playlist editor ----

type FieldType = 'text' | 'number' | 'date' | 'bool' | 'rating' | 'duration'
const FIELDS: Array<{ field: SmartField; label: string; type: FieldType }> = [
  { field: 'title', label: 'Title', type: 'text' },
  { field: 'artist', label: 'Artist', type: 'text' },
  { field: 'albumArtist', label: 'Album artist', type: 'text' },
  { field: 'album', label: 'Album', type: 'text' },
  { field: 'genre', label: 'Genre', type: 'text' },
  { field: 'year', label: 'Year', type: 'number' },
  { field: 'rating', label: 'Rating', type: 'rating' },
  { field: 'playCount', label: 'Plays', type: 'number' },
  { field: 'skipCount', label: 'Skips', type: 'number' },
  { field: 'addedAt', label: 'Date added', type: 'date' },
  { field: 'lastPlayed', label: 'Last played', type: 'date' },
  { field: 'durationMs', label: 'Duration (s)', type: 'duration' },
  { field: 'codec', label: 'Format', type: 'text' },
  { field: 'lossless', label: 'Lossless', type: 'bool' },
  { field: 'source', label: 'Source', type: 'text' },
  { field: 'compilation', label: 'Compilation', type: 'bool' },
  // SiIvaGunner, SGFR or YouTube; any rule on it brings rips into the playlist ("is not" empty = every rip).
  { field: 'hqRip', label: 'High Quality Rip collection', type: 'text' },
  { field: 'liked', label: 'In Favorites', type: 'bool' },
]
const OPS: Record<FieldType, Array<{ op: SmartOp; label: string }>> = {
  text: [
    { op: 'contains', label: 'contains' },
    { op: 'notContains', label: 'does not contain' },
    { op: 'is', label: 'is' },
    { op: 'isNot', label: 'is not' },
    { op: 'startsWith', label: 'starts with' },
  ],
  number: [
    { op: 'is', label: 'is' },
    { op: 'gt', label: 'is greater than' },
    { op: 'lt', label: 'is less than' },
    { op: 'between', label: 'is between' },
  ],
  rating: [
    { op: 'is', label: 'is' },
    { op: 'gt', label: 'is more than' },
    { op: 'lt', label: 'is less than' },
  ],
  duration: [
    { op: 'gt', label: 'is longer than' },
    { op: 'lt', label: 'is shorter than' },
  ],
  date: [
    { op: 'inLast', label: 'in the last (days)' },
    { op: 'notInLast', label: 'not in the last (days)' },
  ],
  bool: [{ op: 'is', label: 'is' }],
}
const typeOf = (f: SmartField) => FIELDS.find((x) => x.field === f)?.type ?? 'text'

function defaultRule(field: SmartField = 'genre'): SmartRule {
  const t = typeOf(field)
  return { field, op: OPS[t][0].op, value: t === 'bool' ? true : t === 'text' ? '' : t === 'date' ? 30 : 0 }
}

/** Ratings are stored 0–100 and edited as stars; durations in ms and edited as seconds. */
function toUi(r: SmartRule): SmartRule {
  const t = typeOf(r.field)
  if (t === 'rating') return { ...r, value: Math.round(Number(r.value) / 20) }
  if (t === 'duration') return { ...r, value: Math.round(Number(r.value) / 1000) }
  return r
}
function fromUi(r: SmartRule): SmartRule {
  const t = typeOf(r.field)
  if (t === 'rating') return { ...r, value: Number(r.value) * 20 }
  if (t === 'duration') return { ...r, value: Number(r.value) * 1000 }
  if (t === 'number' || t === 'date') return { ...r, value: Number(r.value), value2: r.value2 != null ? Number(r.value2) : undefined }
  return r
}

export function SmartEditorView({ id }: { id?: string }) {
  const existing = useLib((s) => (id ? s.playlists.find((p) => p.id === id) : undefined))
  const [name, setName] = useState(existing?.name ?? 'New Smart Playlist')
  const [rules, setRules] = useState<SmartRules>(() =>
    existing?.rules ? { ...existing.rules, rules: existing.rules.rules.map(toUi) } : { match: 'all', rules: [defaultRule()], sort: 'random' },
  )
  const set = (i: number, r: SmartRule) => setRules({ ...rules, rules: rules.rules.map((x, k) => (k === i ? r : x)) })
  const save = async () => {
    try {
      const saved = await invoke<string>(LIB.saveSmartPlaylist, name.trim() || 'Smart Playlist', { ...rules, rules: rules.rules.map(fromUi) }, id)
      toast('Smart playlist saved', 'ok')
      navigate({ view: 'playlist', id: saved })
    } catch (e) {
      toast(errorMessage(e), 'error')
    }
  }
  return (
    <div className="view smart-editor">
      <div className="view-head">
        <div>
          <span className="hero-kicker">{id ? 'Edit smart playlist' : 'New smart playlist'}</span>
          <h1 className="view-title">
            <input className="title-input" value={name} onChange={(e) => setName(e.target.value)} aria-label="Playlist name" />
          </h1>
        </div>
      </div>
      <div className="card">
        <div className="row" style={{ marginBottom: 14 }}>
          <span>Match</span>
          <Segmented
            value={rules.match}
            onChange={(m) => setRules({ ...rules, match: m })}
            options={[
              { value: 'all', label: 'All rules' },
              { value: 'any', label: 'Any rule' },
            ]}
          />
        </div>
        {rules.rules.map((r, i) => {
          const t = typeOf(r.field)
          return (
            <div key={i} className="rule-row">
              <select value={r.field} onChange={(e) => set(i, defaultRule(e.target.value as SmartField))}>
                {FIELDS.map((f) => (
                  <option key={f.field} value={f.field}>
                    {f.label}
                  </option>
                ))}
              </select>
              <select className="op" value={r.op} onChange={(e) => set(i, { ...r, op: e.target.value as SmartOp })}>
                {OPS[t].map((o) => (
                  <option key={o.op} value={o.op}>
                    {o.label}
                  </option>
                ))}
              </select>
              {t === 'bool' ? (
                <select value={String(r.value)} onChange={(e) => set(i, { ...r, value: e.target.value === 'true' })}>
                  <option value="true">true</option>
                  <option value="false">false</option>
                </select>
              ) : t === 'rating' ? (
                <select value={String(r.value)} onChange={(e) => set(i, { ...r, value: Number(e.target.value) })}>
                  {[0, 1, 2, 3, 4, 5].map((s) => (
                    <option key={s} value={s}>
                      {s ? '★'.repeat(s) : 'No rating'}
                    </option>
                  ))}
                </select>
              ) : (
                <>
                  <input type={t === 'text' ? 'text' : 'number'} value={String(r.value)} onChange={(e) => set(i, { ...r, value: t === 'text' ? e.target.value : Number(e.target.value) })} />
                  {r.op === 'between' && <input type="number" value={String(r.value2 ?? '')} onChange={(e) => set(i, { ...r, value2: Number(e.target.value) })} />}
                </>
              )}
              <IconButton icon="close" title="Remove rule" disabled={rules.rules.length < 2} onClick={() => setRules({ ...rules, rules: rules.rules.filter((_, k) => k !== i) })} />
              <IconButton icon="plus" title="Add rule" onClick={() => setRules({ ...rules, rules: [...rules.rules.slice(0, i + 1), defaultRule(), ...rules.rules.slice(i + 1)] })} />
            </div>
          )
        })}
        <div className="row" style={{ marginTop: 16, flexWrap: 'wrap' }}>
          <label className="row">
            <input type="checkbox" className="toggle" checked={rules.limit != null} onChange={(e) => setRules({ ...rules, limit: e.target.checked ? 25 : undefined })} />
            Limit to
          </label>
          <input type="number" min={1} disabled={rules.limit == null} value={rules.limit ?? 25} onChange={(e) => setRules({ ...rules, limit: Math.max(1, Number(e.target.value)) })} style={{ width: 80 }} />
          <span>songs, selected by</span>
          <select value={rules.sort ?? 'random'} onChange={(e) => setRules({ ...rules, sort: e.target.value as SmartRules['sort'] })}>
            <option value="random">random</option>
            <option value="title">title</option>
            <option value="artist">artist</option>
            <option value="addedAt">most recently added</option>
            <option value="lastPlayed">most recently played</option>
            <option value="playCount">most played</option>
            <option value="rating">highest rated</option>
            <option value="likedAt">most recently liked</option>
          </select>
        </div>
      </div>
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <Button kind="ghost" onClick={() => useUi.getState().goBack()}>
          Cancel
        </Button>
        <Button kind="primary" icon="check" onClick={() => void save()}>
          Save
        </Button>
      </div>
      <p className="faint" style={{ fontSize: 12 }}>
        Smart playlists update live and sync to your other computers. They aren’t written as .m3u8 files, so phone players won’t see them.
      </p>
    </div>
  )
}
