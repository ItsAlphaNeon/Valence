// Library service: owns the index DB, scanning/watching, playlists, plays and the library IPC.

import { shell } from 'electron'
import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { AppContext } from '@main/context'
import { openDb, type DB } from '@main/db/db'
import { Indexer, pathKey } from './indexer'
import { scanLibrary, type ScanResult } from './scanner'
import { watchLibrary, type WatchHandle } from './watcher'
import { createLibraryLookup, type LibraryLookupEx } from './lookup'
import { PlaylistStore, type SmartRules } from './playlists'
import { albumById, favoriteCounts, libraryStats, queryAlbums, queryAlbumsPage, queryArtists, queryGenres, queryTracks, trackById, tracksByIds } from './queries'
import { homeData, listeningStats, similarTracks } from './insights'
import { ArtCache, artUrl } from './art'
import { chooseRelPath, moveWithinLibrary, toAbs } from './organizer'
import { probeFile, type ProbeResult } from '@main/tags/read'
import { writeRating, writeTags } from '@main/tags/write'
import { handle } from '@main/ipc'
import { HlcClock } from '@main/sync/hlc'
import { DeviceLog, ensureValenceDir } from '@main/sync/device-log'
import { PlayLog, type PlayEvent } from '@main/sync/plays'
import { artistFavoriteKey, FavoritesLog } from '@main/sync/favorites'
import { ensureStignore } from '@main/sync/stignore'
import { Claims } from '@main/sync/claims'
import { DEFAULT_TEMPLATE, RIP_TEMPLATE } from '@shared/path-template'
import { kvGet } from '@main/db/db'
import { SETTINGS } from '@shared/ipc/settings'
import { LIB, type AlbumQuery, type EditTagsRequest, type EditTagsResult, type LibraryPlayItem, type SetLikedRequest, type StatsRange } from '@shared/ipc/library'
import type { LibraryCollection, TrackQuery, TrackRow, TrackTags } from '@shared/types'

export class LibraryService {
  readonly db: DB
  readonly indexer: Indexer
  readonly lookup: LibraryLookupEx
  readonly playlists: PlaylistStore
  readonly clock: HlcClock
  readonly deviceLog: DeviceLog
  readonly plays: PlayLog
  readonly favorites: FavoritesLog
  readonly claims: Claims
  readonly art: ArtCache
  private watcher: WatchHandle | null = null
  private scanPromise: Promise<ScanResult> | null = null
  private rescanQueued = false
  scanning = false

  constructor(private ctx: AppContext) {
    const { env } = ctx
    this.db = openDb(join(env.dataDir, 'valence.db'))
    this.indexer = new Indexer(this.db)
    this.lookup = createLibraryLookup(this.db)
    this.clock = new HlcClock(env.deviceId)
    this.deviceLog = new DeviceLog(env.libraryRoot, env.deviceId, this.clock)
    this.plays = new PlayLog(this.db, this.deviceLog, env.libraryRoot, env.deviceId)
    this.favorites = new FavoritesLog(this.db, this.deviceLog, this.clock, env.libraryRoot)
    this.claims = new Claims(env.libraryRoot, env.deviceId)
    this.playlists = new PlaylistStore(this.db, env.libraryRoot, this.lookup, (p) => shell.trashItem(p))
    // env.archiveDir changes when the user picks another archive folder, so read it per call.
    this.art = new ArtCache(this.db, env.libraryRoot, env.artCacheDir, () => [env.archiveDir, env.archivePendingDir])
  }

  get root(): string {
    return this.ctx.env.libraryRoot
  }

  template(): string {
    return this.ctx.settings.get('library.template', DEFAULT_TEMPLATE)
  }

  /** Path template for one track: rips live under their own top folder, everything else uses the library template. */
  templateFor(tags: TrackTags): string {
    return tags.hq_rip ? RIP_TEMPLATE : this.template()
  }

  async start(): Promise<void> {
    const { env, log } = this.ctx
    try {
      ensureValenceDir(env.libraryRoot, env.deviceId, { appVersion: env.appVersion })
      ensureStignore(env.libraryRoot)
      this.claims.sweep()
    } catch (e) {
      log.warn('library: could not prepare .valence', e)
    }
    this.playlists.indexAll()
    this.plays.ingest()
    this.ingestFavorites()
    this.registerIpc()
    // A schema upgrade added columns existing rows don't have yet: re-read every file once.
    const full = !!kvGet(this.db, 'library.fullRescanPending', 0)
    void this.rescan(full).then(
      () => full && this.db.prepare("DELETE FROM kv WHERE key = 'library.fullRescanPending'").run(),
      (e) => log.warn('library: initial scan failed', e),
    )
    this.watcher = watchLibrary(
      env.libraryRoot,
      (kind, rels) => {
        if (kind === 'valence') {
          if (this.plays.ingest()) this.ctx.broadcast(LIB.changed, { plays: true })
          if (this.ingestFavorites()) this.ctx.broadcast(LIB.changed, { favorites: true })
          if (rels.some((r) => r.startsWith('.valence/playlists/'))) this.reindexPlaylists()
          if (rels.some((r) => r.startsWith('.valence/themes/'))) this.ctx.broadcast(SETTINGS.themesChanged)
        } else if (kind === 'playlist') this.reindexPlaylists()
        else void this.onAudioChanged(rels)
      },
      { onRescan: () => void this.rescan() },
    )
  }

  stop(): void {
    this.watcher?.close()
    this.db.close()
  }

  /** Pulls other devices' favorites; returns how many changed (a bad log line never breaks startup). */
  private ingestFavorites(): number {
    try {
      return this.favorites.ingest()
    } catch (e) {
      this.ctx.log.warn('favorites: ingest failed', e)
      return 0
    }
  }

  private reindexPlaylists(): void {
    try {
      this.playlists.indexAll()
      this.ctx.broadcast(LIB.changed, { playlists: true })
    } catch (e) {
      this.ctx.log.warn('playlists: reindex failed', e)
    }
  }

  private async onAudioChanged(rels: string[]): Promise<void> {
    const onlyFiles = rels.every((r) => {
      try {
        return !statSync(toAbs(this.root, r)).isDirectory()
      } catch {
        return /\.[a-z0-9]{2,5}$/i.test(r)
      }
    })
    if (onlyFiles && rels.length < 200) await this.indexPaths(rels)
    else await this.rescan()
  }

  /** Full diff scan; concurrent calls coalesce. */
  rescan(force = false): Promise<ScanResult> {
    if (this.scanPromise) {
      this.rescanQueued = true
      return this.scanPromise
    }
    this.scanning = true
    this.scanPromise = (async () => {
      try {
        const r = await scanLibrary({
          root: this.root,
          db: this.db,
          indexer: this.indexer,
          force,
          onProgress: (done, total) => {
            if (total > 20 && (done % 25 === 0 || done === total)) this.ctx.broadcast(LIB.scanProgress, { done, total })
          },
        })
        for (const m of r.moved) this.playlists.pathMoved(m.from, m.to)
        if (r.added || r.updated || r.removed) {
          this.playlists.refreshMirrors()
          this.ctx.broadcast(LIB.changed, { full: true })
        }
        if (r.errors.length) this.ctx.log.warn(`scan: ${r.errors.length} unreadable files`, r.errors.slice(0, 5))
        return r
      } finally {
        this.scanning = false
        this.scanPromise = null
        this.ctx.broadcast(LIB.scanProgress, null)
        if (this.rescanQueued) {
          this.rescanQueued = false
          void this.rescan()
        }
      }
    })()
    return this.scanPromise
  }

  /** Indexes specific files right away (used after imports and tag edits). */
  async indexPaths(rels: string[]): Promise<ScanResult> {
    const r = await scanLibrary({ root: this.root, db: this.db, indexer: this.indexer, only: rels, force: true })
    for (const m of r.moved) this.playlists.pathMoved(m.from, m.to)
    if (r.added || r.updated || r.removed) {
      this.playlists.refreshMirrors()
      this.ctx.broadcast(LIB.changed, { albums: r.touchedAlbums })
    }
    return r
  }

  /** Indexes a file from an already-known probe (avoids a second read right after an import). */
  indexProbed(rel: string, probe: ProbeResult): number {
    const st = statSync(toAbs(this.root, rel))
    const r = this.indexer.upsert(rel, { size: st.size, mtimeMs: st.mtimeMs }, probe)
    this.indexer.flushAlbums()
    return r.id
  }

  playItem(t: TrackRow): LibraryPlayItem {
    return {
      id: t.valenceId ?? `t${t.id}`,
      trackId: t.id,
      path: toAbs(this.root, t.relPath),
      title: t.title,
      artist: t.artist,
      album: t.album,
      albumKey: t.albumId != null ? `a${t.albumId}` : undefined,
      trackNo: t.trackNo ?? undefined,
      discNo: t.discNo ?? undefined,
      durationMs: t.durationMs,
      artUrl: artUrl(t.artHash, 600),
      valenceId: t.valenceId ?? undefined,
      rg: {
        trackGain: t.rgTrackGain ?? undefined,
        trackPeak: t.rgTrackPeak ?? undefined,
        albumGain: t.rgAlbumGain ?? undefined,
        albumPeak: t.rgAlbumPeak ?? undefined,
      },
    }
  }

  recordPlay(p: { trackId: number; playedAt: number; ms: number; completed: boolean; skipped: boolean }): void {
    const t = trackById(this.db, p.trackId)
    if (!t) return
    const ev: PlayEvent = { trackKey: t.valenceId ?? `path:${t.relPath}`, playedAt: p.playedAt, ms: p.ms, completed: p.completed, skipped: p.skipped }
    this.plays.record(ev)
    this.ctx.broadcast(LIB.changed, { tracks: [t.id], plays: true })
  }

  async setRating(ids: number[], stars: number): Promise<void> {
    const rels: string[] = []
    for (const t of tracksByIds(this.db, ids)) {
      await writeRating(toAbs(this.root, t.relPath), stars)
      rels.push(t.relPath)
    }
    await this.indexPaths(rels)
  }

  /** Likes or unlikes tracks / albums (by id) or artists (by album artist name). */
  setLiked(req: SetLikedRequest, liked: boolean): void {
    const on = !!liked
    if (req?.kind === 'artist') {
      this.favorites.set('r', (req.names ?? []).filter((n) => typeof n === 'string').map(artistFavoriteKey), on)
      this.ctx.broadcast(LIB.changed, { favorites: true })
      return
    }
    const ids = (req?.ids ?? []).map(Number).filter(Number.isFinite)
    if (req?.kind === 'track') {
      this.favorites.set('t', tracksByIds(this.db, ids).map((t) => t.valenceId ?? `path:${t.relPath}`), on)
      this.ctx.broadcast(LIB.changed, { favorites: true, tracks: ids })
    } else if (req?.kind === 'album') {
      const rows = this.db.prepare('SELECT album_key FROM albums WHERE id IN (SELECT value FROM json_each(?))').all(JSON.stringify(ids)) as Array<{ album_key: string }>
      this.favorites.set('a', rows.map((r) => r.album_key), on)
      this.ctx.broadcast(LIB.changed, { favorites: true, albums: ids })
    }
  }

  /** album_key of each track's album, for following a liked album when tags move its tracks. */
  private albumKeysOf(ids: number[]): Map<number, string> {
    const rows = this.db
      .prepare('SELECT t.id, a.album_key FROM tracks t JOIN albums a ON a.id = t.album_id WHERE t.id IN (SELECT value FROM json_each(?))')
      .all(JSON.stringify(ids)) as Array<{ id: number; album_key: string }>
    return new Map(rows.map((r) => [r.id, r.album_key]))
  }

  async getTags(id: number): Promise<{ tags: TrackTags; hasArt: boolean } | null> {
    const t = trackById(this.db, id)
    if (!t) return null
    const p = await probeFile(toAbs(this.root, t.relPath), { covers: true })
    return { tags: p.tags, hasArt: !!p.picture }
  }

  /** Get Info edits: rewrite tags, then re-path the file per the template (user edits move on this device). */
  async editTags(req: EditTagsRequest, artwork?: { data: Buffer; mime: string } | null): Promise<EditTagsResult> {
    const res: EditTagsResult = { updated: 0, moved: 0, errors: [] }
    const changed: string[] = []
    const taken = new Set<string>()
    const albumsBefore = this.albumKeysOf(req.ids)
    for (const t of tracksByIds(this.db, req.ids)) {
      try {
        const abs = toAbs(this.root, t.relPath)
        const p = await probeFile(abs, { covers: true })
        const tags: TrackTags = { ...p.tags }
        for (const [k, v] of Object.entries(req.patch)) {
          if (v === null || v === '') delete (tags as Record<string, unknown>)[k]
          else (tags as Record<string, unknown>)[k] = v
        }
        await writeTags(abs, tags, { artwork: artwork === undefined ? p.picture : artwork })
        res.updated++
        const ext = t.relPath.slice(t.relPath.lastIndexOf('.') + 1)
        const target = await chooseRelPath(this.root, tags, ext, { template: this.templateFor(tags), isSelf: (r) => r.toLowerCase() === t.relPath.toLowerCase(), taken })
        taken.add(target.toLowerCase())
        if (target !== t.relPath) {
          await moveWithinLibrary(this.root, t.relPath, target)
          // Keep the row (id, added_at, path-keyed plays) by renaming it in place before re-indexing.
          this.db.prepare('UPDATE tracks SET rel_path = ?, path_key = ? WHERE id = ?').run(target, pathKey(target), t.id)
          this.db.prepare("UPDATE plays SET track_key = ? WHERE track_key = ?").run(`path:${target}`, `path:${t.relPath}`)
          // A like follows a path-keyed track (logged, so other devices follow too).
          if (!t.valenceId) this.favorites.moveKey('t', `path:${t.relPath}`, `path:${target}`)
          this.playlists.pathMoved(t.relPath, target)
          res.moved++
        }
        changed.push(target)
      } catch (e) {
        res.errors.push({ id: t.id, error: (e as Error).message })
      }
    }
    await this.indexPaths(changed)
    this.followLikedAlbums(albumsBefore)
    return res
  }

  /** A liked album whose tracks all moved to another album (new folder or title) stays liked there. */
  private followLikedAlbums(before: Map<number, string>): void {
    const liked = new Set([...before.values()].filter((k) => this.favorites.get('a', k)?.liked))
    if (!liked.size) return
    const after = this.albumKeysOf([...before.keys()])
    const exists = this.db.prepare('SELECT 1 FROM albums WHERE album_key = ?')
    for (const oldKey of liked) {
      if (exists.get(oldKey)) continue
      const votes = new Map<string, number>()
      for (const [id, k] of before) {
        const now = after.get(id)
        if (k === oldKey && now && now !== oldKey) votes.set(now, (votes.get(now) ?? 0) + 1)
      }
      const target = [...votes].sort((a, b) => b[1] - a[1])[0]?.[0]
      if (target) this.favorites.moveKey('a', oldKey, target)
    }
  }

  private registerIpc(): void {
    const db = this.db
    handle(LIB.stats, () => libraryStats(db, this.root, this.scanning))
    handle(LIB.tracks, (q: TrackQuery) => queryTracks(db, q))
    handle(LIB.trackIds, (q: TrackQuery) => queryTracks(db, { ...q, limit: q?.limit ?? 1_000_000, offset: 0 }).rows.map((r) => r.id))
    handle(LIB.track, (id: number) => trackById(db, id))
    handle(LIB.tracksByIds, (ids: number[]) => tracksByIds(db, ids))
    handle(LIB.albums, (q) => queryAlbums(db, q ?? {}))
    handle(LIB.albumsPage, (q: AlbumQuery) => queryAlbumsPage(db, q ?? {}))
    handle(LIB.album, (id: number) => {
      const album = albumById(db, id)
      return album ? { album, tracks: queryTracks(db, { albumId: id }).rows } : null
    })
    handle(LIB.artists, (q) => queryArtists(db, q ?? {}))
    handle(LIB.genres, (q) => queryGenres(db, q ?? {}))
    handle(LIB.artColor, (hash: string) => (hash ? this.art.color(String(hash)) : null))
    handle(LIB.search, (text: string, collection: LibraryCollection = 'main') => ({
      tracks: queryTracks(db, { search: text, limit: 50, collection }).rows,
      albums: queryAlbums(db, { search: text, limit: 24, collection }),
      artists: collection === 'rips' ? [] : queryArtists(db, { search: text, collection }).slice(0, 12),
    }))
    handle(LIB.rescan, (force?: boolean) => this.rescan(!!force).then((r) => ({ ...r, conflicts: r.conflicts.length, playlists: r.playlists.length })))
    handle(LIB.setRating, (ids: number[], stars: number) => this.setRating(ids, stars))
    handle(LIB.getTags, (id: number) => this.getTags(id))
    handle(LIB.editTags, (req: EditTagsRequest) => this.editTags(req))
    handle(LIB.setArtwork, (ids: number[], data: Uint8Array | null, mime?: string) =>
      this.editTags({ ids, patch: {} }, data ? { data: Buffer.from(data), mime: mime ?? 'image/jpeg' } : null),
    )
    handle(LIB.reveal, (id: number) => {
      const t = trackById(db, id)
      if (t) shell.showItemInFolder(toAbs(this.root, t.relPath))
    })
    handle(LIB.recordPlay, (p) => this.recordPlay(p))
    handle(LIB.playlists, () => this.playlists.list())
    handle(LIB.playlistTracks, (id: string) => this.playlistTracks(id))
    handle(LIB.createPlaylist, (name: string, trackIds: number[] = []) => {
      const id = this.playlists.create(name, this.relPaths(trackIds))
      this.ctx.broadcast(LIB.changed, { playlists: true })
      return id
    })
    handle(LIB.addToPlaylist, (id: string, trackIds: number[]) => {
      this.playlists.addItems(id, this.relPaths(trackIds))
      this.ctx.broadcast(LIB.changed, { playlists: true })
    })
    handle(LIB.setPlaylistItems, (id: string, trackIds: number[]) => {
      this.playlists.setItems(id, this.relPaths(trackIds))
      this.ctx.broadcast(LIB.changed, { playlists: true })
    })
    handle(LIB.renamePlaylist, async (id: string, name: string) => {
      const newId = await this.playlists.rename(id, name)
      this.ctx.broadcast(LIB.changed, { playlists: true })
      return newId
    })
    handle(LIB.deletePlaylist, async (id: string) => {
      await this.playlists.remove(id)
      this.ctx.broadcast(LIB.changed, { playlists: true })
    })
    handle(LIB.saveSmartPlaylist, (name: string, rules: SmartRules, id?: string) => {
      const r = this.playlists.saveSmart(name, rules, id)
      this.ctx.broadcast(LIB.changed, { playlists: true })
      return r
    })
    handle(LIB.playItems, (ids: number[]) => tracksByIds(db, ids).map((t) => this.playItem(t)))
    handle(LIB.setLiked, (req: SetLikedRequest, liked: boolean) => this.setLiked(req, liked))
    handle(LIB.favoriteCounts, () => favoriteCounts(db))
    handle(LIB.home, () => homeData(db))
    handle(LIB.listeningStats, (range: StatsRange) => listeningStats(db, range ?? '30d', libraryStats(db, this.root, this.scanning)))
    handle(LIB.similar, (seedTrackIds: number[], excludeIds: number[], n: number) =>
      similarTracks(db, Array.isArray(seedTrackIds) ? seedTrackIds : [], Array.isArray(excludeIds) ? excludeIds : [], n ?? 20),
    )
    handle(LIB.artOriginal, (albumId: number) => this.art.originalFor(albumId))
  }

  private relPaths(trackIds: number[]): string[] {
    return tracksByIds(this.db, trackIds).map((t) => t.relPath)
  }

  playlistTracks(id: string): TrackRow[] {
    const rels = this.playlists.items(id)
    if (!rels.length) return []
    const rows = this.db
      .prepare('SELECT id, rel_path FROM tracks WHERE rel_path IN (SELECT value FROM json_each(?))')
      .all(JSON.stringify(rels)) as Array<{ id: number; rel_path: string }>
    const idByPath = new Map(rows.map((r) => [r.rel_path, r.id]))
    return tracksByIds(this.db, rels.map((r) => idByPath.get(r)).filter((x): x is number => x !== undefined))
  }

  exists(rel: string): boolean {
    return existsSync(toAbs(this.root, rel))
  }
}
