// Playlists. Regular playlists live canonically as ~/Music/Playlists/<Name>.m3u8 (relative paths,
// readable on the phone). Smart playlists and source-playlist mirrors are JSON documents in
// ~/Music/.valence/playlists/. The DB only indexes them.

import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { DB } from '@main/db/db'
import type { BadgeQueryTrack, PlaylistMirror } from '@main/context'
import { foldKey, sanitizeComponent } from '@shared/sanitize'
import { parseM3u, unionMerge, writeM3u, type M3uEntry } from '@main/sync/m3u'
import { valenceDir } from '@main/sync/device-log'
import type { LibraryLookupEx } from './lookup'
import { toAbs } from './organizer'

export const PLAYLISTS_DIR = 'Playlists'

/**
 * Rule fields. Boolean fields (lossless, compilation, liked) take op 'is' or 'isNot' with a
 * boolean value: { field: 'liked', op: 'is', value: true } is "is liked",
 * { field: 'liked', op: 'is', value: false } (or op 'isNot', value true) is "is not liked".
 * `liked` means the track itself is in favorites.
 */
export type SmartField =
  | 'title' | 'artist' | 'album' | 'albumArtist' | 'genre' | 'year' | 'rating' | 'playCount' | 'skipCount'
  | 'addedAt' | 'lastPlayed' | 'durationMs' | 'codec' | 'lossless' | 'source' | 'compilation' | 'hqRip' | 'liked'
export type SmartOp = 'is' | 'isNot' | 'contains' | 'notContains' | 'startsWith' | 'gt' | 'lt' | 'between' | 'inLast' | 'notInLast'
export interface SmartRule {
  field: SmartField
  op: SmartOp
  value: string | number | boolean
  value2?: number
}
export interface SmartRules {
  match: 'all' | 'any'
  rules: SmartRule[]
  limit?: number
  sort?: 'random' | 'title' | 'artist' | 'addedAt' | 'lastPlayed' | 'playCount' | 'rating' | 'likedAt'
}

export interface PlaylistInfo {
  id: string
  name: string
  kind: 'static' | 'smart' | 'mirror'
  relPath: string | null
  sourceKey: string | null
  rules: SmartRules | null
  count: number
  updatedAt: number
}

const FIELD_SQL: Record<SmartField, string> = {
  title: 't.title',
  artist: 't.artist',
  album: 't.album',
  albumArtist: 't.album_artist',
  genre: 't.genre',
  year: 't.year',
  rating: 't.rating',
  playCount: 'coalesce(ps.play_count, 0)',
  skipCount: 'coalesce(ps.skip_count, 0)',
  addedAt: 't.added_at',
  lastPlayed: 'ps.last_played',
  durationMs: 't.duration_ms',
  codec: 't.codec',
  lossless: 't.lossless',
  source: 't.source',
  compilation: 't.compilation',
  hqRip: 't.hq_rip',
  liked: "(SELECT count(*) FROM favorites f WHERE f.kind = 't' AND f.item_key = coalesce(t.valence_id, 'path:' || t.rel_path) AND f.liked = 1)",
}

export function smartSql(rules: SmartRules, now = Date.now()): { sql: string; params: unknown[] } {
  const parts: string[] = []
  const params: unknown[] = []
  for (const r of rules.rules) {
    const col = FIELD_SQL[r.field]
    if (!col) continue
    const v = typeof r.value === 'boolean' ? (r.value ? 1 : 0) : r.value
    switch (r.op) {
      case 'is':
        parts.push(typeof v === 'string' ? `${col} = ? COLLATE NOCASE` : `${col} = ?`)
        params.push(v)
        break
      case 'isNot':
        parts.push(typeof v === 'string' ? `coalesce(${col}, '') <> ? COLLATE NOCASE` : `coalesce(${col}, -1) <> ?`)
        params.push(v)
        break
      case 'contains':
        parts.push(`${col} LIKE ?`)
        params.push(`%${v}%`)
        break
      case 'notContains':
        parts.push(`coalesce(${col}, '') NOT LIKE ?`)
        params.push(`%${v}%`)
        break
      case 'startsWith':
        parts.push(`${col} LIKE ?`)
        params.push(`${v}%`)
        break
      case 'gt':
        parts.push(`${col} > ?`)
        params.push(v)
        break
      case 'lt':
        parts.push(`${col} < ?`)
        params.push(v)
        break
      case 'between':
        parts.push(`${col} BETWEEN ? AND ?`)
        params.push(v, r.value2 ?? v)
        break
      case 'inLast':
        parts.push(`${col} > ?`)
        params.push(now - Number(v) * 86400000)
        break
      case 'notInLast':
        parts.push(`(${col} IS NULL OR ${col} <= ?)`)
        params.push(now - Number(v) * 86400000)
        break
    }
  }
  const where = parts.length ? parts.join(rules.match === 'any' ? ' OR ' : ' AND ') : '1'
  const order =
    rules.sort === 'random'
      ? 'random()'
      : rules.sort === 'addedAt'
        ? 't.added_at DESC'
        : rules.sort === 'lastPlayed'
          ? 'ps.last_played DESC'
          : rules.sort === 'playCount'
            ? 'coalesce(ps.play_count, 0) DESC'
            : rules.sort === 'rating'
              ? 't.rating DESC'
              : rules.sort === 'likedAt'
                ? "(SELECT f.at FROM favorites f WHERE f.kind = 't' AND f.item_key = coalesce(t.valence_id, 'path:' || t.rel_path) AND f.liked = 1) DESC"
                : rules.sort === 'title'
                  ? 't.title COLLATE NOCASE'
                  : 't.album_artist COLLATE NOCASE, t.year, t.album COLLATE NOCASE, coalesce(t.disc_no, 1), t.track_no'
  // Rips stay out of smart playlists unless a rule asks about them.
  const rips = rules.rules.some((r) => r.field === 'hqRip') ? '' : " AND t.hq_rip = ''"
  const sql = `SELECT t.rel_path FROM tracks t LEFT JOIN play_stats ps ON ps.track_key = coalesce(t.valence_id, 'path:' || t.rel_path)
    WHERE (${where})${rips} ORDER BY ${order}${rules.limit ? ` LIMIT ${Math.floor(rules.limit)}` : ''}`
  return { sql, params }
}

function staticId(relPath: string): string {
  return 'm3u-' + createHash('sha1').update(foldKey(relPath)).digest('hex').slice(0, 16)
}

/** A regular playlist's name: its file name. */
const nameOf = (relPath: string): string => relPath.slice(relPath.lastIndexOf('/') + 1).replace(/\.m3u8?$/i, '')

interface SmartDoc {
  id: string
  name: string
  rules: SmartRules
  updatedAt: number
}
interface MirrorDoc {
  id: string
  name: string
  sourceKey: string
  tracks: BadgeQueryTrack[]
  relPath: string
  updatedAt: number
}

export class PlaylistStore implements PlaylistMirror {
  constructor(
    private db: DB,
    private root: string,
    private lookup: LibraryLookupEx,
    private trash: (absPath: string) => Promise<void>,
  ) {}

  private docsDir(): string {
    return join(valenceDir(this.root), 'playlists')
  }

  private readDocs<T>(prefix: string): T[] {
    const dir = this.docsDir()
    if (!existsSync(dir)) return []
    const out: T[] = []
    for (const f of readdirSync(dir)) {
      if (!f.startsWith(prefix) || !f.endsWith('.json') || f.includes('.sync-conflict-')) continue
      try {
        out.push(JSON.parse(readFileSync(join(dir, f), 'utf8')) as T)
      } catch {
        /* skip */
      }
    }
    return out
  }

  private writeDoc(name: string, doc: unknown): void {
    mkdirSync(this.docsDir(), { recursive: true })
    const file = join(this.docsDir(), name)
    writeFileSync(file + '.valence-tmp', JSON.stringify(doc, null, 1))
    renameSync(file + '.valence-tmp', file)
  }

  private writePlaylistFile(relPath: string, items: string[]): void {
    const entries: M3uEntry[] = items.map((rel) => {
      const r = this.db.prepare('SELECT title, artist, duration_ms FROM tracks WHERE rel_path = ?').get(rel) as
        | { title: string; artist: string; duration_ms: number }
        | undefined
      return { relPath: rel, title: r ? `${r.artist} - ${r.title}` : undefined, durationSec: r ? r.duration_ms / 1000 : undefined }
    })
    const abs = toAbs(this.root, relPath)
    mkdirSync(join(this.root, PLAYLISTS_DIR), { recursive: true })
    writeFileSync(abs + '.valence-tmp', writeM3u(relPath, entries))
    renameSync(abs + '.valence-tmp', abs)
  }

  private upsertRow(p: { id: string; name: string; kind: string; relPath: string | null; rules?: SmartRules | null; sourceKey?: string | null; items: string[] }): void {
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO playlists(id, name, kind, m3u_rel_path, rules_json, source_key, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET name = excluded.name, kind = excluded.kind, m3u_rel_path = excluded.m3u_rel_path,
             rules_json = excluded.rules_json, source_key = excluded.source_key, updated_at = excluded.updated_at`,
        )
        .run(p.id, p.name, p.kind, p.relPath, p.rules ? JSON.stringify(p.rules) : null, p.sourceKey ?? null, Date.now())
      this.db.prepare('DELETE FROM playlist_items WHERE playlist_id = ?').run(p.id)
      const ins = this.db.prepare('INSERT INTO playlist_items(playlist_id, pos, rel_path) VALUES (?, ?, ?)')
      p.items.forEach((rel, i) => ins.run(p.id, i, rel))
    })()
  }

  /** Re-indexes every playlist from disk (m3u files + smart/mirror docs). */
  indexAll(): void {
    const seen = new Set<string>()
    const mirrors = this.readDocs<MirrorDoc>('mirror-')
    const mirrorByPath = new Map(mirrors.map((m) => [foldKey(m.relPath), m]))
    const dir = join(this.root, PLAYLISTS_DIR)
    if (existsSync(dir)) {
      const files = readdirSync(dir).filter((f) => /\.m3u8?$/i.test(f) && !f.includes('.valence-tmp'))
      // Union-merge Syncthing conflict copies into their playlist.
      for (const f of files.filter((f) => f.includes('.sync-conflict-'))) {
        const base = f.replace(/\.sync-conflict-[^.]*/, '')
        const baseRel = `${PLAYLISTS_DIR}/${base}`
        const confRel = `${PLAYLISTS_DIR}/${f}`
        if (!existsSync(toAbs(this.root, baseRel))) continue
        const a = parseM3u(readFileSync(toAbs(this.root, baseRel), 'utf8'), baseRel, this.root)
        const b = parseM3u(readFileSync(toAbs(this.root, confRel), 'utf8'), confRel, this.root)
        this.writePlaylistFile(baseRel, unionMerge(a, b).map((e) => e.relPath))
        void this.trash(toAbs(this.root, confRel))
      }
      for (const f of files.filter((f) => !f.includes('.sync-conflict-'))) {
        const rel = `${PLAYLISTS_DIR}/${f}`
        const mirror = mirrorByPath.get(foldKey(rel))
        const id = mirror?.id ?? staticId(rel)
        const items = parseM3u(readFileSync(toAbs(this.root, rel), 'utf8'), rel, this.root).map((e) => e.relPath)
        this.upsertRow({ id, name: mirror?.name ?? f.replace(/\.m3u8?$/i, ''), kind: mirror ? 'mirror' : 'static', relPath: rel, sourceKey: mirror?.sourceKey, items })
        seen.add(id)
      }
    }
    for (const s of this.readDocs<SmartDoc>('smart-')) {
      this.upsertRow({ id: s.id, name: s.name, kind: 'smart', relPath: null, rules: s.rules, items: [] })
      seen.add(s.id)
    }
    const all = this.db.prepare('SELECT id FROM playlists').all() as Array<{ id: string }>
    for (const { id } of all) if (!seen.has(id)) this.db.prepare('DELETE FROM playlists WHERE id = ?').run(id)
  }

  list(): PlaylistInfo[] {
    const rows = this.db
      .prepare('SELECT p.*, (SELECT count(*) FROM playlist_items i WHERE i.playlist_id = p.id) AS n FROM playlists p ORDER BY p.name COLLATE NOCASE')
      .all() as Array<Record<string, any>>
    return rows.map((r) => {
      const rules = r.rules_json ? (JSON.parse(r.rules_json) as SmartRules) : null
      let count = r.n as number
      if (rules) {
        const { sql, params } = smartSql(rules)
        count = (this.db.prepare(`SELECT count(*) n FROM (${sql})`).get(...params) as { n: number }).n
      }
      return { id: r.id, name: r.name, kind: r.kind, relPath: r.m3u_rel_path, sourceKey: r.source_key, rules, count, updatedAt: r.updated_at }
    })
  }

  /** Library-relative paths in playlist order (smart playlists are evaluated now). */
  items(id: string): string[] {
    const p = this.db.prepare('SELECT kind, rules_json FROM playlists WHERE id = ?').get(id) as { kind: string; rules_json: string | null } | undefined
    if (!p) return []
    if (p.kind === 'smart' && p.rules_json) {
      const { sql, params } = smartSql(JSON.parse(p.rules_json))
      return (this.db.prepare(sql).all(...params) as Array<{ rel_path: string }>).map((r) => r.rel_path)
    }
    return (this.db.prepare('SELECT rel_path FROM playlist_items WHERE playlist_id = ? ORDER BY pos').all(id) as Array<{ rel_path: string }>).map((r) => r.rel_path)
  }

  private freeName(name: string): string {
    const base = sanitizeComponent(name || 'Playlist', 60)
    const dir = join(this.root, PLAYLISTS_DIR)
    const existing = new Set(existsSync(dir) ? readdirSync(dir).map(foldKey) : [])
    for (let n = 1; n < 1000; n++) {
      const file = `${base}${n > 1 ? ` (${n})` : ''}.m3u8`
      if (!existing.has(foldKey(file))) return `${PLAYLISTS_DIR}/${file}`
    }
    return `${PLAYLISTS_DIR}/${base} ${randomUUID().slice(0, 6)}.m3u8`
  }

  create(name: string, items: string[] = []): string {
    const rel = this.freeName(name)
    this.writePlaylistFile(rel, items)
    const id = staticId(rel)
    this.upsertRow({ id, name: rel.slice(PLAYLISTS_DIR.length + 1).replace(/\.m3u8$/i, ''), kind: 'static', relPath: rel, items })
    return id
  }

  /** Replaces a playlist's songs. Editing a mirrored playlist makes it a regular one (see detach);
   *  returns the playlist's id afterwards. */
  setItems(id: string, items: string[]): string {
    return this.writeItems(id, items, true)
  }

  addItems(id: string, items: string[]): string {
    return this.setItems(id, [...this.items(id), ...items])
  }

  private writeItems(id: string, items: string[], userEdit: boolean): string {
    const p = this.db.prepare('SELECT * FROM playlists WHERE id = ?').get(id) as Record<string, any> | undefined
    if (!p || p.kind === 'smart' || !p.m3u_rel_path) throw new Error('Not an editable playlist')
    this.writePlaylistFile(p.m3u_rel_path, items)
    if (userEdit && p.kind === 'mirror') {
      const newId = this.detach(id, p.m3u_rel_path)
      this.upsertRow({ id: newId, name: nameOf(p.m3u_rel_path), kind: 'static', relPath: p.m3u_rel_path, items })
      return newId
    }
    this.upsertRow({ id, name: p.name, kind: p.kind, relPath: p.m3u_rel_path, sourceKey: p.source_key, items })
    return id
  }

  /** The docs in .valence/playlists that belong to playlist `id`, found by the id inside (as on the
   *  phone), Syncthing conflict copies included. */
  private docFilesFor(prefix: string, id: string): string[] {
    const dir = this.docsDir()
    if (!existsSync(dir)) return []
    return readdirSync(dir)
      .filter((f) => f.startsWith(prefix) && f.endsWith('.json'))
      .map((f) => join(dir, f))
      .filter((file) => {
        try {
          return (JSON.parse(readFileSync(file, 'utf8')) as { id?: unknown }).id === id
        } catch {
          return false
        }
      })
  }

  /** Merges `patch` into playlist `id`'s docs where they are (not into conflict copies). */
  private updateDocs(prefix: string, id: string, patch: Record<string, unknown>): void {
    for (const f of this.docFilesFor(prefix, id)) {
      if (f.includes('.sync-conflict-')) continue
      const doc = JSON.parse(readFileSync(f, 'utf8')) as Record<string, unknown>
      this.writeDoc(basename(f), { ...doc, ...patch, updatedAt: Date.now() })
    }
  }

  /**
   * Cuts a mirrored playlist loose from its source: its doc goes, so downloading the source again
   * and refreshMirrors() no longer rewrite it, and from then on it's a regular playlist with the
   * id every device derives from its file. Drops the old row and returns the new id.
   */
  private detach(id: string, relPath: string): string {
    for (const f of this.docFilesFor('mirror-', id)) rmSync(f, { force: true })
    this.db.prepare('DELETE FROM playlist_items WHERE playlist_id = ?').run(id)
    this.db.prepare('DELETE FROM playlists WHERE id = ?').run(id)
    return staticId(relPath)
  }

  async rename(id: string, name: string): Promise<string> {
    const p = this.db.prepare('SELECT * FROM playlists WHERE id = ?').get(id) as Record<string, any> | undefined
    if (!p) throw new Error('No such playlist')
    if (p.kind === 'smart') {
      this.updateDocs('smart-', id, { name })
      this.db.prepare('UPDATE playlists SET name = ? WHERE id = ?').run(name, id)
      return id
    }
    const items = this.items(id)
    const rel = this.freeName(name)
    this.writePlaylistFile(rel, items)
    await this.trash(toAbs(this.root, p.m3u_rel_path))
    this.db.prepare('DELETE FROM playlists WHERE id = ?').run(id)
    if (p.kind === 'mirror') {
      // Renaming isn't editing: the mirror keeps its source (as on the phone) and its id.
      this.updateDocs('mirror-', id, { name: nameOf(rel), relPath: rel })
      this.upsertRow({ id, name: nameOf(rel), kind: 'mirror', relPath: rel, sourceKey: p.source_key, items })
      return id
    }
    const newId = staticId(rel)
    this.upsertRow({ id: newId, name: nameOf(rel), kind: 'static', relPath: rel, items })
    return newId
  }

  async remove(id: string): Promise<void> {
    const p = this.db.prepare('SELECT * FROM playlists WHERE id = ?').get(id) as Record<string, any> | undefined
    if (!p) return
    if (p.m3u_rel_path) await this.trash(toAbs(this.root, p.m3u_rel_path))
    if (p.kind === 'smart' || p.kind === 'mirror') for (const f of this.docFilesFor(`${p.kind}-`, id)) await this.trash(f)
    this.db.prepare('DELETE FROM playlists WHERE id = ?').run(id)
  }

  saveSmart(name: string, rules: SmartRules, id?: string): string {
    const docId = id ?? `smart-${randomUUID()}`
    this.writeDoc(`smart-${docId.replace(/^smart-/, '')}.json`, { id: docId, name, rules, updatedAt: Date.now() } satisfies SmartDoc)
    this.upsertRow({ id: docId, name, kind: 'smart', relPath: null, rules, items: [] })
    return docId
  }

  /** Mirrors a source playlist: writes the m3u8 with whatever is in the library now; refreshMirrors() fills in later imports. */
  mirror(req: { name: string; sourceKey: string; tracks: BadgeQueryTrack[] }): void {
    const id = 'mirror-' + createHash('sha1').update(req.sourceKey).digest('hex').slice(0, 16)
    const existing = this.readDocs<MirrorDoc>('mirror-').find((m) => m.id === id)
    const relPath = existing?.relPath ?? this.freeName(req.name)
    const doc: MirrorDoc = { id, name: req.name, sourceKey: req.sourceKey, tracks: req.tracks, relPath, updatedAt: Date.now() }
    this.writeDoc(`${id}.json`, doc)
    this.writeMirror(doc)
  }

  private writeMirror(doc: MirrorDoc): number {
    const items = doc.tracks.map((t) => this.lookup.resolve(t)).filter((p): p is string => !!p)
    this.writePlaylistFile(doc.relPath, items)
    this.upsertRow({ id: doc.id, name: doc.name, kind: 'mirror', relPath: doc.relPath, sourceKey: doc.sourceKey, items })
    return doc.tracks.length - items.length
  }

  /** Re-resolves mirrors that are still missing tracks (call after imports). */
  refreshMirrors(): void {
    for (const doc of this.readDocs<MirrorDoc>('mirror-')) {
      const have = (this.db.prepare('SELECT count(*) n FROM playlist_items WHERE playlist_id = ?').get(doc.id) as { n: number }).n
      if (have < doc.tracks.length) this.writeMirror(doc)
    }
  }

  /** Rewrites playlist entries after a file moved inside the library. */
  pathMoved(fromRel: string, toRel: string): void {
    const ids = this.db.prepare('SELECT DISTINCT playlist_id FROM playlist_items WHERE rel_path = ?').all(fromRel) as Array<{ playlist_id: string }>
    for (const { playlist_id } of ids) {
      const items = this.items(playlist_id).map((r) => (r === fromRel ? toRel : r))
      try {
        this.writeItems(playlist_id, items, false) // not an edit: a mirror stays a mirror
      } catch {
        /* smart playlists need no rewrite */
      }
    }
  }
}
