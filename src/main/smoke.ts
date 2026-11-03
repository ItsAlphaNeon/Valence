// `electron . --smoke`: verifies native modules and bundled binaries load inside Electron main.

import { app } from 'electron'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { ffmpegPath, fpcalcPath } from './platform/binaries'

const run = promisify(execFile)

type Check = { name: string; ok: boolean; detail: string }

async function check(name: string, fn: () => Promise<string> | string): Promise<Check> {
  try {
    return { name, ok: true, detail: await fn() }
  } catch (e) {
    return { name, ok: false, detail: e instanceof Error ? e.message : String(e) }
  }
}

export async function runSmoke(): Promise<void> {
  const results: Check[] = []
  results.push(
    await check('better-sqlite3', async () => {
      const { default: Database } = await import('better-sqlite3')
      const db = new Database(':memory:')
      db.exec("CREATE VIRTUAL TABLE t USING fts5(x); INSERT INTO t VALUES ('hello world')")
      const row = db.prepare("SELECT count(*) AS n FROM t WHERE t MATCH 'hello'").get() as { n: number }
      const v = db.prepare('select sqlite_version() as v').get() as { v: string }
      db.close()
      return `sqlite ${v.v}, fts5 rows=${row.n}`
    }),
  )
  results.push(
    await check('node:sqlite', async () => {
      const { DatabaseSync } = await import('node:sqlite')
      const db = new DatabaseSync(':memory:')
      const v = db.prepare('select sqlite_version() as v').get() as { v: string }
      db.close()
      return `sqlite ${v.v}`
    }),
  )
  results.push(
    await check('sharp', async () => {
      const { default: sharp } = await import('sharp')
      const buf = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#336699' } }).jpeg().toBuffer()
      const meta = await sharp(buf).resize(32, 32).toBuffer({ resolveWithObject: true })
      return `jpeg ${buf.length}B, resized ${meta.info.width}x${meta.info.height}, libvips ${sharp.versions.vips}`
    }),
  )
  results.push(
    await check('node-taglib-sharp', async () => {
      const tl = await import('node-taglib-sharp')
      return `exports: File=${typeof tl.File}, Id3v2Settings=${typeof tl.Id3v2Settings}`
    }),
  )
  results.push(
    await check('music-metadata', async () => {
      const mm = await import('music-metadata')
      return `parseFile=${typeof mm.parseFile}`
    }),
  )
  results.push(
    await check('ffmpeg', async () => {
      const p = ffmpegPath()
      const { stdout } = await run(p, ['-hide_banner', '-encoders'], { maxBuffer: 8 << 20 })
      const enc = ['libmp3lame', 'flac', 'libopus', 'aac'].filter((e) => new RegExp(`\\s${e}\\s`).test(stdout))
      const { stdout: ver } = await run(p, ['-version'])
      return `${ver.split('\n')[0]} | encoders: ${enc.join(',')}`
    }),
  )
  results.push(
    await check('fpcalc', async () => {
      const p = fpcalcPath()
      if (!p) throw new Error('fpcalc not found')
      const { stdout } = await run(p, ['-version'])
      return stdout.trim()
    }),
  )
  results.push(await check('paths', () => `music=${app.getPath('music')} userData=${app.getPath('userData')}`))
  results.push(await check('electron', () => `electron ${process.versions.electron}, node ${process.versions.node}, chrome ${process.versions.chrome}`))

  process.stdout.write(`VALENCE_SMOKE ${JSON.stringify(results)}\n`)
  app.exit(results.every((r) => r.ok || r.name === 'node:sqlite') ? 0 : 1)
}
