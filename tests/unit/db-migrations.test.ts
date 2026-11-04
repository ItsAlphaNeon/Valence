// The local database must stay backward compatible: shipped migrations are frozen, new ones are
// additive only, an older database upgrades in place with its rows intact (after a backup), and a
// database from a newer build opens untouched.

import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { openDb } from '@main/db/db'
import { MIGRATIONS } from '@main/db/schema'
import { sandbox } from '../helpers/sandbox'
import { insertAlbum, insertPlay, insertTrack } from '../helpers/library-fixture'

const sha = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 16)

/** Fingerprints of migrations already shipped. Append the new one's when adding a migration; never change these. */
const SHIPPED = ['bc49ddb7379c0054', 'f3b8154a3a333c77', 'a9f4581acb28bc58']

describe('database migrations', () => {
  it('never change once shipped', () => {
    expect(MIGRATIONS.length).toBeGreaterThanOrEqual(SHIPPED.length)
    expect(MIGRATIONS.slice(0, SHIPPED.length).map(sha)).toEqual(SHIPPED)
  })

  it('are additive after the first', () => {
    for (const [i, sql] of MIGRATIONS.entries()) {
      if (i === 0) continue
      const code = sql.replace(/--.*$/gm, '')
      expect(code, `migration ${i + 1}`).not.toMatch(/\bDROP\s+(TABLE|INDEX|VIEW|TRIGGER|COLUMN)\b/i)
      expect(code, `migration ${i + 1}`).not.toMatch(/\bRENAME\b/i)
      expect(code, `migration ${i + 1}`).not.toMatch(/\bDELETE\s+FROM\s+(?!kv\b)/i)
      for (const m of code.matchAll(/ADD\s+COLUMN\s+[^;,]+/gi)) {
        if (/NOT\s+NULL/i.test(m[0])) expect(m[0], `migration ${i + 1}: NOT NULL needs a DEFAULT`).toMatch(/DEFAULT/i)
      }
    }
  })

  it('upgrade an existing database in place, keeping its rows, after a backup', () => {
    const sb = sandbox('migrate')
    try {
      const file = join(sb.dir, 'valence.db')
      const old = new Database(file)
      old.exec(MIGRATIONS[0])
      old.pragma('user_version = 1')
      old.prepare("INSERT INTO albums(album_key, title, album_artist, rel_dir, added_at) VALUES ('k', 'Kept Album', 'Kept Artist', 'Kept Artist/Kept Album', 1)").run()
      old.prepare("INSERT INTO kv(key, value) VALUES ('ui.theme', '\"x\"')").run()
      old.close()

      const db = openDb(file)
      expect(db.pragma('user_version', { simple: true })).toBe(MIGRATIONS.length)
      expect(db.prepare('SELECT title, album_artist FROM albums').all()).toEqual([{ title: 'Kept Album', album_artist: 'Kept Artist' }])
      expect(db.prepare("SELECT value FROM kv WHERE key = 'ui.theme'").get()).toEqual({ value: '"x"' })
      db.close()

      const backup = `${file}.before-v${MIGRATIONS.length}.bak`
      expect(existsSync(backup)).toBe(true)
      const bak = new Database(backup, { readonly: true })
      expect(bak.pragma('user_version', { simple: true })).toBe(1)
      expect(bak.prepare('SELECT count(*) n FROM albums').get()).toEqual({ n: 1 })
      bak.close()
    } finally {
      try {
        sb.cleanup()
      } catch {
        /* Windows may still hold the WAL files for a moment */
      }
    }
  })

  it('upgrade a v2 database to favorites (v3) keeping its library and plays', () => {
    const sb = sandbox('migrate-v2')
    try {
      const file = join(sb.dir, 'valence.db')
      const old = new Database(file)
      old.exec(MIGRATIONS[0])
      old.exec(MIGRATIONS[1])
      old.pragma('user_version = 2')
      const album = insertAlbum(old, { title: 'Kept', artist: 'Someone', hqRip: '' })
      insertTrack(old, { rel: 'Someone/Kept/01.flac', title: 'One', artist: 'Someone', albumId: album, valenceId: 'v-1' })
      insertTrack(old, { rel: 'Someone/Kept/02.flac', title: 'Two', artist: 'Someone', albumId: album })
      insertPlay(old, { key: 'v-1', at: 1_700_000_000_000 })
      insertPlay(old, { key: 'path:Someone/Kept/02.flac', at: 1_700_000_100_000 })
      old.close()

      const db = openDb(file)
      expect(db.pragma('user_version', { simple: true })).toBe(MIGRATIONS.length)
      expect(db.prepare('SELECT count(*) n FROM tracks').get()).toEqual({ n: 2 })
      expect(db.prepare('SELECT count(*) n FROM plays').get()).toEqual({ n: 2 })
      expect(db.prepare('SELECT count(*) n FROM favorites').get()).toEqual({ n: 0 })
      // Plays join back to their tracks through the new key index.
      const joined = db
        .prepare("SELECT t.title FROM plays p JOIN tracks t ON coalesce(t.valence_id, 'path:' || t.rel_path) = p.track_key ORDER BY p.played_at")
        .all()
      expect(joined).toEqual([{ title: 'One' }, { title: 'Two' }])
      const plan = db
        .prepare("EXPLAIN QUERY PLAN SELECT id FROM tracks t WHERE coalesce(t.valence_id, 'path:' || t.rel_path) = ?")
        .all('v-1') as Array<{ detail: string }>
      expect(plan.map((r) => r.detail).join(' ')).toMatch(/tracks_item_key/)
      db.close()

      const bak = new Database(`${file}.before-v${MIGRATIONS.length}.bak`, { readonly: true })
      expect(bak.pragma('user_version', { simple: true })).toBe(2)
      expect(bak.prepare('SELECT count(*) n FROM plays').get()).toEqual({ n: 2 })
      bak.close()
    } finally {
      try {
        sb.cleanup()
      } catch {
        /* Windows may still hold the WAL files for a moment */
      }
    }
  })

  it('leave a database from a newer build alone', () => {
    const sb = sandbox('migrate-newer')
    try {
      const file = join(sb.dir, 'valence.db')
      const first = openDb(file)
      first.pragma(`user_version = ${MIGRATIONS.length + 5}`)
      first.close()
      const db = openDb(file)
      expect(db.pragma('user_version', { simple: true })).toBe(MIGRATIONS.length + 5)
      db.close()
      expect(existsSync(`${file}.before-v${MIGRATIONS.length}.bak`)).toBe(false)
    } finally {
      try {
        sb.cleanup()
      } catch {
        /* Windows may still hold the WAL files for a moment */
      }
    }
  })
})
