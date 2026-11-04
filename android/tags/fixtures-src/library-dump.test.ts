// Opt-in, read-only: records how the desktop reads every audio file in a library, for the Kotlin
// LibraryDiffTest. Skipped unless VALENCE_DUMP names the output JSON. From the repo root:
//   VALENCE_DUMP=/tmp/library.json [VALENCE_LIBRARY=~/Music] npx vitest run --config android/tags/fixtures-src/vitest.config.mts library-dump
//   VALENCE_TAGS_DIFF=/tmp/library.json ./gradlew :tags:test --tests app.valence.tags.LibraryDiffTest   (in android/)

import { it } from 'vitest'
import { createHash } from 'node:crypto'
import { readdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { probeFile } from '@main/tags/read'

const OUT = process.env.VALENCE_DUMP
const ROOT = process.env.VALENCE_LIBRARY || join(homedir(), 'Music')
const EXT = /\.(mp3|flac|m4a|mp4|aac|ogg|oga|opus|wav|aif|aiff)$/i

function walk(d: string, out: string[]): void {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    const p = join(d, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (EXT.test(e.name)) out.push(p)
  }
}

it.skipIf(!OUT)('dumps the desktop reading of a library', async () => {
  const files: string[] = []
  walk(ROOT, files)
  files.sort()
  const res: Record<string, unknown> = {}
  for (const f of files) {
    try {
      const p = await probeFile(f, { covers: true })
      res[f] = {
        tags: p.tags,
        format: p.format,
        tagTypes: p.tagTypes,
        picture: p.picture
          ? { mime: p.picture.mime, length: p.picture.data.length, sha256: createHash('sha256').update(p.picture.data).digest('hex') }
          : null,
      }
    } catch (e) {
      res[f] = { error: String(e) }
    }
  }
  writeFileSync(OUT!, JSON.stringify(res))
}, 3_600_000)
