// YouTube playlist → season albums. Syncs the user's public SiIvaGunner playlist on startup, every six
// hours and on demand; queues uploads not yet in the library; keeps each season album numbered by
// upload time; owns the season table and covers (re-filing and re-embedding when they change).
//
// Numbering is per season: an import renumbers its own season once the batch is done, and startup
// renumbers only the seasons left out of order (a renumber cut short by quitting, or rips numbered
// by an older version). Ties in upload time go by video id, then path, so every device numbers a
// season the same way and they never fight over the tags through Syncthing.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import sharp from 'sharp'
import type { AppContext } from '@main/context'
import type { LibraryService } from '@main/library/service'
import { HQRIP_IPC, type SeasonDef, type SeasonInfo, type YoutubeEntry, type YoutubeStatus } from '@shared/ipc/hqrip'
import { SIIVAGUNNER_CHANNEL_ID } from './metadata'
import { parseFlatPlaylist, playlistUrl, type PlaylistEntry } from './playlist'
import { placeholderSvg, seasonAlbum, seasonFor, SeasonStore, validateSeasons } from './seasons'
import { ytDlpError, type YtDlp } from './ytdlp'

export const PLAYLIST_KEY = 'library.rips.youtubePlaylist'
export const AUTOSYNC_KEY = 'rips.youtube.autoSync'
const SYNC_EVERY_MS = 6 * 3600_000
const FIRST_SYNC_DELAY_MS = 20_000
const RENUMBER_DELAY_MS = 15_000

type SeasonRow = { id: number; rel_path: string; youtube_uploaded: string | null; track_no: number | null; track_total: number | null }

/** Tracks whose number isn't their place in the season (rows in upload order), with the right one. */
export function misnumbered(rows: SeasonRow[]): Array<{ id: number; track: number; total: number }> {
  return rows.flatMap((r, i) => (r.track_no === i + 1 && r.track_total === rows.length ? [] : [{ id: r.id, track: i + 1, total: rows.length }]))
}

interface StateFile {
  lastSync: number | null
  playlistTitle: string | null
  entries: PlaylistEntry[]
  summary: string | null
  error: string | null
}

export class YoutubeService {
  private state: StateFile = { lastSync: null, playlistTitle: null, entries: [], summary: null, error: null }
  private syncing: Promise<YoutubeStatus> | null = null
  private timer: NodeJS.Timeout | null = null
  private firstTimer: NodeJS.Timeout | null = null
  private renumberTimers = new Map<string, NodeJS.Timeout>()
  private renumbering: Promise<unknown> = Promise.resolve()
  private placeholders = new Map<string, Buffer>()
  readonly seasons: SeasonStore

  constructor(
    private ctx: AppContext,
    private library: LibraryService,
    private ytdlp: YtDlp,
  ) {
    this.seasons = new SeasonStore(ctx.env.libraryRoot)
    try {
      this.state = { ...this.state, ...(JSON.parse(readFileSync(this.stateFile, 'utf8')) as StateFile) }
    } catch {
      /* first run */
    }
  }

  private get stateFile(): string {
    return join(this.ctx.env.dataDir, 'cache', 'youtube-playlist.json')
  }

  private saveState(): void {
    try {
      mkdirSync(join(this.ctx.env.dataDir, 'cache'), { recursive: true })
      writeFileSync(this.stateFile, JSON.stringify(this.state))
    } catch (e) {
      this.ctx.log.warn('youtube: could not save sync state', (e as Error).message)
    }
  }

  get url(): string | null {
    return playlistUrl(this.ctx.settings.get<string | null>(PLAYLIST_KEY, null))
  }

  get autoSync(): boolean {
    return this.ctx.settings.get(AUTOSYNC_KEY, true)
  }

  // ---- timer ----

  start(): void {
    this.reschedule()
    this.ctx.settings.onChange((k) => {
      if (k === PLAYLIST_KEY || k === AUTOSYNC_KEY) {
        this.reschedule()
        this.broadcast()
      }
    })
    // Once the startup scan has the index matching the disk, fix any season left out of order.
    void this.library.idle().then(() => {
      for (const album of this.misnumberedSeasons()) this.scheduleRenumber(album)
    })
  }

  stop(): void {
    this.stopSync()
    for (const t of this.renumberTimers.values()) clearTimeout(t)
    this.renumberTimers.clear()
  }

  private stopSync(): void {
    if (this.timer) clearInterval(this.timer)
    if (this.firstTimer) clearTimeout(this.firstTimer)
    this.timer = this.firstTimer = null
  }

  private reschedule(): void {
    // Only the sync timers: a pending renumber still has to happen.
    this.stopSync()
    if (!this.autoSync || !this.url) return
    const due = (this.state.lastSync ?? 0) + SYNC_EVERY_MS - Date.now()
    this.firstTimer = setTimeout(() => void this.sync().catch(() => {}), Math.max(FIRST_SYNC_DELAY_MS, Math.min(due, SYNC_EVERY_MS)))
    this.timer = setInterval(() => void this.sync().catch(() => {}), SYNC_EVERY_MS)
    this.firstTimer.unref?.()
    this.timer.unref?.()
  }

  // ---- status / sync ----

  private entryStates(): YoutubeEntry[] {
    const have = this.ctx.library.youtubeVideoIds?.() ?? new Set<string>()
    const active = this.ctx.imports.activeKeys()
    return this.state.entries.map((e) => {
      const q = active.get(`youtube:${e.id}`)
      const state: YoutubeEntry['state'] = have.has(e.id)
        ? 'in-library'
        : e.unavailable
          ? 'unavailable'
          : e.channelId !== SIIVAGUNNER_CHANNEL_ID
            ? 'not-siivagunner'
            : (q ?? 'missing')
      return { id: e.id, title: e.title, durationSec: e.durationSec, channel: e.channel, state }
    })
  }

  async status(): Promise<YoutubeStatus> {
    return {
      playlistUrl: this.url,
      autoSync: this.autoSync,
      syncing: !!this.syncing,
      lastSync: this.state.lastSync,
      playlistTitle: this.state.playlistTitle,
      entries: this.entryStates(),
      summary: this.state.summary,
      error: this.state.error,
      ytDlpVersion: await this.ytdlp.currentVersion(),
    }
  }

  private broadcast(): void {
    void this.status().then((s) => this.ctx.broadcast(HQRIP_IPC.youtubeChanged, s))
  }

  /** Reads the playlist and queues every SiIvaGunner upload that isn't in the library or queued yet. */
  sync(): Promise<YoutubeStatus> {
    return (this.syncing ??= this.doSync().finally(() => {
      this.syncing = null
      this.broadcast()
    }))
  }

  private async doSync(): Promise<YoutubeStatus> {
    const url = this.url
    if (!url) {
      this.state.error = 'Set your SiIvaGunner playlist link first'
      return this.status()
    }
    this.broadcast()
    try {
      const r = await this.ytdlp.run(['--flat-playlist', '-J', url], { timeoutMs: 10 * 60_000 })
      if (r.code !== 0) throw ytDlpError(r.stderr, 'Couldn’t read the playlist')
      const list = parseFlatPlaylist(r.stdout)
      const have = this.ctx.library.youtubeVideoIds?.() ?? new Set<string>()
      const active = this.ctx.imports.activeKeys()
      let queued = 0
      let skipped = 0
      let unavailable = 0
      for (const e of list.entries) {
        if (e.unavailable) unavailable++
        else if (e.channelId !== SIIVAGUNNER_CHANNEL_ID) skipped++
        else if (!have.has(e.id) && !active.has(`youtube:${e.id}`)) {
          this.ctx.imports.enqueue({ source: 'youtube', title: `YouTube · ${e.title}`, releaseKeys: [`youtube:${e.id}`], payload: { videoId: e.id, title: e.title } })
          queued++
        }
      }
      const inLib = list.entries.filter((e) => have.has(e.id)).length
      const waiting = list.entries.filter((e) => !have.has(e.id) && active.has(`youtube:${e.id}`)).length
      const parts = [queued ? `Queued ${queued} rip${queued === 1 ? '' : 's'}` : 'Nothing new']
      if (waiting) parts.push(`${waiting} still downloading`)
      if (inLib) parts.push(`${inLib} already in library`)
      if (skipped) parts.push(`${skipped} skipped (other channels)`)
      if (unavailable) parts.push(`${unavailable} unavailable`)
      this.state = { lastSync: Date.now(), playlistTitle: list.title, entries: list.entries, summary: parts.join(' · '), error: null }
    } catch (e) {
      this.state = { ...this.state, error: (e as Error).message }
      this.ctx.log.warn('youtube: playlist sync failed', (e as Error).message)
    }
    this.saveState()
    return this.status()
  }

  // ---- season albums ----

  /** A season's rips in upload order (the same order on every device). */
  private albumTracks(album: string): SeasonRow[] {
    return this.library.db
      .prepare("SELECT id, rel_path, youtube_uploaded, track_no, track_total FROM tracks WHERE hq_rip = 'YouTube' AND album = ? ORDER BY coalesce(youtube_uploaded, date), youtube_video_id, rel_path")
      .all(album) as never
  }

  /** Season albums with any track whose number doesn't match its place by upload time. */
  misnumberedSeasons(): string[] {
    const albums = this.library.db.prepare("SELECT DISTINCT album FROM tracks WHERE hq_rip = 'YouTube' AND album IS NOT NULL").all() as Array<{ album: string }>
    return albums.map((r) => r.album).filter((a) => misnumbered(this.albumTracks(a)).length > 0)
  }

  /** Provisional position for a new upload in its season album. */
  positionFor(album: string, uploaded: string): { track: number; total: number } {
    const rows = this.albumTracks(album)
    return { track: rows.filter((r) => (r.youtube_uploaded ?? '') < uploaded).length + 1, total: rows.length + 1 }
  }

  /** Renumbers a season by upload time, a little after the last import into it (a batch renumbers once). */
  scheduleRenumber(album: string): void {
    clearTimeout(this.renumberTimers.get(album))
    const t = setTimeout(() => {
      this.renumberTimers.delete(album)
      const busy = [...this.ctx.imports.activeKeys().keys()].some((k) => k.startsWith('youtube:'))
      if (busy) return this.scheduleRenumber(album)
      void this.renumber(album).catch((e) => this.ctx.log.warn(`youtube: renumbering ${album} failed`, (e as Error).message))
    }, RENUMBER_DELAY_MS)
    t.unref?.()
    this.renumberTimers.set(album, t)
  }

  /**
   * Writes track N of M (by upload time) into every track of a season album whose number is off.
   * One season at a time; returns how many tracks were rewritten.
   */
  renumber(album: string): Promise<number> {
    const run = this.renumbering.then(() => this.doRenumber(album))
    this.renumbering = run.catch(() => {})
    return run
  }

  private async doRenumber(album: string): Promise<number> {
    const edits = misnumbered(this.albumTracks(album))
    if (!edits.length) return 0
    const res = await this.library.editTagsEach(edits.map((e) => ({ id: e.id, patch: { tracknumber: e.track, totaltracks: e.total } })))
    if (res.errors.length) this.ctx.log.warn(`youtube: could not renumber ${res.errors.length} rip(s) in ${album}`, res.errors[0].error)
    return res.updated
  }

  async coverFor(season: SeasonDef, dir: string): Promise<string> {
    const custom = this.seasons.coverFile(season.key)
    if (existsSync(custom)) return custom
    const file = join(dir, `season-${season.key}.jpg`)
    writeFileSync(file, await this.placeholder(season))
    return file
  }

  private async placeholder(season: SeasonDef): Promise<Buffer> {
    const key = `${season.key}|${season.name}`
    let buf = this.placeholders.get(key)
    if (!buf) {
      const index = Math.max(0, this.seasons.list().findIndex((s) => s.key === season.key))
      buf = await sharp(Buffer.from(placeholderSvg(season, index))).jpeg({ quality: 90 }).toBuffer()
      this.placeholders.set(key, buf)
    }
    return buf
  }

  async seasonInfo(): Promise<SeasonInfo[]> {
    const counts = new Map(
      (this.library.db.prepare("SELECT album, count(*) n FROM tracks WHERE hq_rip = 'YouTube' GROUP BY album").all() as Array<{ album: string; n: number }>).map((r) => [r.album, r.n]),
    )
    const out: SeasonInfo[] = []
    for (const s of this.seasons.list()) {
      const custom = this.seasons.hasCover(s.key)
      const data = custom ? readFileSync(this.seasons.coverFile(s.key)) : await this.placeholder(s)
      const album = seasonAlbum(s)
      out.push({ ...s, album, tracks: counts.get(album) ?? 0, cover: `data:image/jpeg;base64,${data.toString('base64')}`, customCover: custom })
    }
    return out
  }

  /** Saves an edited season table and moves YouTube rips whose season (or season name) changed. */
  async setSeasons(input: SeasonDef[]): Promise<SeasonInfo[]> {
    const seasons = this.seasons.save(validateSeasons(input))
    const rows = this.library.db
      .prepare("SELECT id, album, coalesce(youtube_uploaded, date) AS up FROM tracks WHERE hq_rip = 'YouTube' AND coalesce(youtube_uploaded, date) IS NOT NULL")
      .all() as Array<{ id: number; album: string; up: string }>
    const touched = new Set<string>()
    for (const r of rows) {
      const s = seasonFor(r.up, seasons)
      const album = seasonAlbum(s)
      if (album === r.album) continue
      const cover = await this.readCover(s)
      await this.library.editTags({ ids: [r.id], patch: { album, hqr_release: `youtube:${s.key}` } }, cover)
      touched.add(album).add(r.album)
    }
    for (const a of touched) await this.renumber(a)
    this.ctx.broadcast(HQRIP_IPC.youtubeChanged, await this.status())
    return this.seasonInfo()
  }

  private async readCover(s: SeasonDef): Promise<{ data: Buffer; mime: string }> {
    const custom = this.seasons.coverFile(s.key)
    return { data: existsSync(custom) ? readFileSync(custom) : await this.placeholder(s), mime: 'image/jpeg' }
  }

  /** Sets (or with null, clears) a season's cover and embeds it into every track of that season. */
  async setSeasonCover(key: string, data: Uint8Array | null): Promise<SeasonInfo[]> {
    const s = this.seasons.list().find((x) => x.key === key)
    if (!s) throw new Error('Unknown season')
    const file = this.seasons.coverFile(key)
    if (data) {
      mkdirSync(join(this.seasons.dir, 'covers'), { recursive: true })
      // Normalized to a square-cropped JPEG so every player shows it the same way.
      writeFileSync(file, await sharp(Buffer.from(data)).resize(1200, 1200, { fit: 'cover', withoutEnlargement: true }).jpeg({ quality: 92 }).toBuffer())
    } else rmSync(file, { force: true })
    const ids = this.albumTracks(seasonAlbum(s)).map((r) => r.id)
    if (ids.length) await this.library.editTags({ ids, patch: {} }, await this.readCover(s))
    return this.seasonInfo()
  }
}
