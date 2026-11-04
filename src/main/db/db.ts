import Database from 'better-sqlite3'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { dirname } from 'node:path'
import { MIGRATIONS } from './schema'

export type DB = Database.Database

export function openDb(file: string): DB {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true })
  const db = new Database(file)
  db.pragma('journal_mode = WAL')
  db.pragma('synchronous = NORMAL')
  db.pragma('foreign_keys = ON')
  db.pragma('busy_timeout = 5000')
  db.pragma('cache_size = -32000')
  if (file !== ':memory:') backupBeforeUpgrade(db, file)
  migrate(db)
  return db
}

/**
 * Before an existing database is upgraded, keep a consistent copy next to it
 * (`valence.db.before-v3.bak`). Migrations are additive, so this is a second line of defence, not
 * the plan. A failed backup is reported but doesn't block the upgrade.
 */
export function backupBeforeUpgrade(db: DB, file: string): string | null {
  const version = db.pragma('user_version', { simple: true }) as number
  if (version === 0 || version >= MIGRATIONS.length) return null
  const target = `${file}.before-v${MIGRATIONS.length}.bak`
  try {
    if (existsSync(target)) rmSync(target)
    db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`)
    return target
  } catch (e) {
    console.error(`[db] backup before upgrade failed (${target})`, e)
    return null
  }
}

/**
 * Applies pending migrations in order. Every migration is additive (new tables, indexes and
 * defaulted columns), so a database stays readable by older builds; a database already newer than
 * this build (opened by a later version) is left untouched.
 */
export function migrate(db: DB): void {
  const version = db.pragma('user_version', { simple: true }) as number
  for (let v = version; v < MIGRATIONS.length; v++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[v])
      db.pragma(`user_version = ${v + 1}`)
    })()
  }
}

export function kvGet<T>(db: DB, key: string, fallback: T): T {
  const row = db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as { value: string } | undefined
  if (!row) return fallback
  try {
    return JSON.parse(row.value) as T
  } catch {
    return fallback
  }
}

export function kvSet(db: DB, key: string, value: unknown): void {
  db.prepare('INSERT INTO kv(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, JSON.stringify(value))
}
