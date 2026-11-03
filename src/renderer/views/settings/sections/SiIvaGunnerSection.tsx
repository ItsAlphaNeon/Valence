// Settings → SiIvaGunner: the YouTube playlist that feeds the season albums, and the season table
// (names, start dates, covers). Saving the table re-files YouTube rips whose season changed.

import { useEffect, useRef, useState } from 'react'
import { HQRIP_IPC, type SeasonDef, type SeasonInfo } from '@shared/ipc/hqrip'
import { errorMessage, invoke } from '../../../lib/ipc'
import { plural, relativeTime } from '../../../lib/format'
import { navigate, toast } from '../../../state/ui'
import { Button, Spinner } from '../../../components/ui'
import { Card, CommitInput, Row, SectionHead, Toggle, useSettingValue } from '../controls'
import { AUTOSYNC_KEY, PLAYLIST_KEY, playlistError, useYoutubeStatus } from '../../rips/YoutubeTab'
import '../../rips/rips.css'

export function SiIvaGunnerSection() {
  const [url, setUrl] = useSettingValue<string | null>(PLAYLIST_KEY, null)
  const [auto, setAuto] = useSettingValue<boolean>(AUTOSYNC_KEY, true)
  const { status, sync, syncing } = useYoutubeStatus()
  return (
    <>
      <SectionHead icon="star" title="SiIvaGunner">
        High Quality Rips live in their own section of the library. Rip albums come from the official highquality.rip and SGFR mirrors (Get Rips);
        single rips come from your YouTube playlist and are filed into one album per channel season.
      </SectionHead>

      <Card title="YouTube playlist">
        <Row label="Playlist link" desc="A public playlist of SiIvaGunner uploads. Videos from other channels in it are skipped.">
          <CommitInput value={url ?? ''} placeholder="https://www.youtube.com/playlist?list=…" validate={playlistError} onCommit={(v) => setUrl(v || null)} width={360} ariaLabel="Playlist link" />
        </Row>
        <Row label="Sync automatically" desc="On startup and every 6 hours, on this computer. New uploads in the playlist download on their own.">
          <Toggle checked={auto} onChange={setAuto} label="Sync automatically" />
        </Row>
        <Row
          label="Sync now"
          desc={
            status?.lastSync
              ? `Last synced ${relativeTime(status.lastSync)}${status.summary ? ` · ${status.summary}` : ''}`
              : 'Not synced yet'
          }
        >
          <div className="row">
            <Button small kind="ghost" onClick={() => navigate({ view: 'hqrip', tab: 'youtube' })}>
              Show Playlist
            </Button>
            <Button icon="refresh" disabled={!status?.playlistUrl || syncing} onClick={() => void sync()}>
              {syncing ? 'Syncing…' : 'Sync Now'}
            </Button>
          </div>
        </Row>
        {status?.error && <p className="set-callout warn">{status.error}</p>}
      </Card>

      <SeasonsCard />
    </>
  )
}

function SeasonsCard() {
  const [seasons, setSeasons] = useState<SeasonInfo[] | null>(null)
  const [draft, setDraft] = useState<SeasonDef[] | null>(null)
  const [busy, setBusy] = useState(false)
  const pick = useRef<HTMLInputElement>(null)
  const coverFor = useRef<string | null>(null)

  useEffect(() => {
    invoke<SeasonInfo[]>(HQRIP_IPC.seasons).then(setSeasons, (e) => toast(errorMessage(e), 'error'))
  }, [])

  const rows: SeasonDef[] = draft ?? seasons ?? []
  const info = (key: string) => seasons?.find((s) => s.key === key)
  const dirty = !!draft
  const edit = (i: number, patch: Partial<SeasonDef>) => setDraft(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)))

  const save = async () => {
    if (!draft) return
    setBusy(true)
    try {
      setSeasons(await invoke<SeasonInfo[]>(HQRIP_IPC.setSeasons, draft.map(({ key, name, start }) => ({ key, name, start }))))
      setDraft(null)
      toast('Seasons saved · rips re-filed where their season changed', 'ok')
    } catch (e) {
      toast(errorMessage(e), 'error')
    } finally {
      setBusy(false)
    }
  }

  const setCover = async (key: string, file: File | null) => {
    setBusy(true)
    try {
      const data = file ? new Uint8Array(await file.arrayBuffer()) : null
      setSeasons(await invoke<SeasonInfo[]>(HQRIP_IPC.setSeasonCover, key, data))
      toast(file ? 'Cover set · embedded into every rip of that season' : 'Back to the placeholder cover', 'ok')
    } catch (e) {
      toast(errorMessage(e), 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card
      title="Seasons"
      aside={
        dirty ? (
          <div className="row">
            <Button small kind="ghost" disabled={busy} onClick={() => setDraft(null)}>
              Discard
            </Button>
            <Button small kind="primary" disabled={busy} onClick={() => void save()}>
              {busy ? 'Saving…' : 'Save Changes'}
            </Button>
          </div>
        ) : busy ? (
          <Spinner size={14} />
        ) : undefined
      }
    >
      <p className="faint" style={{ margin: '0 0 10px' }}>
        A YouTube rip goes into the latest season that started on or before its upload date. Covers apply right away; name and date changes apply when
        you save.
      </p>
      {!seasons ? (
        <Spinner />
      ) : (
        <div className="season-table">
          {rows.map((s, i) => {
            const meta = info(s.key)
            return (
              <div key={s.key} className="season-row">
                {meta ? <img src={meta.cover} alt="" /> : <span />}
                <input type="text" value={s.name} aria-label="Season name" onChange={(e) => edit(i, { name: e.target.value })} />
                <input type="date" value={s.start} aria-label="Season start" onChange={(e) => edit(i, { start: e.target.value })} />
                <span className="faint tnum season-count">{meta ? plural(meta.tracks, 'rip') : 'new'}</span>
                <span className="season-actions">
                  <Button
                    small
                    disabled={!meta || busy}
                    onClick={() => {
                      coverFor.current = s.key
                      pick.current?.click()
                    }}
                  >
                    Cover…
                  </Button>
                  {meta?.customCover && (
                    <Button small kind="ghost" disabled={busy} onClick={() => void setCover(s.key, null)}>
                      Reset
                    </Button>
                  )}
                  {!meta && (
                    <Button small kind="ghost" onClick={() => setDraft(rows.filter((_, j) => j !== i))}>
                      Remove
                    </Button>
                  )}
                </span>
              </div>
            )
          })}
          <div>
            <Button
              small
              icon="plus"
              onClick={() => {
                const n = rows.length + 1
                setDraft([...rows, { key: `s${Date.now().toString(36)}`, name: `Season ${n}`, start: new Date().toISOString().slice(0, 10) }])
              }}
            >
              Add Season
            </Button>
          </div>
        </div>
      )}
      <input
        ref={pick}
        type="file"
        accept="image/*"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0]
          e.target.value = ''
          if (f && coverFor.current) void setCover(coverFor.current, f)
        }}
      />
    </Card>
  )
}
