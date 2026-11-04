// Full-size covers: the archived cover-original wins over the embedded picture, archive paths
// can't escape the archive folder, and the valence-art:// handler serves both URL forms.

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import sharp from 'sharp'
import { sandbox } from '../helpers/sandbox'
import { insertAlbum } from '../helpers/library-fixture'
import { openDb, type DB } from '@main/db/db'
import { ArtCache, artUrl, insideRoot } from '@main/library/art'

describe('original album art', () => {
  const sb = sandbox('art')
  const archive = join(sb.dir, 'Archive')
  let db: DB
  let art: ArtCache
  const ids: Record<string, number> = {}

  beforeAll(async () => {
    db = openDb(':memory:')
    ids.archived = insertAlbum(db, { title: 'Kept', artist: 'Band', relDir: 'Band/Kept', artHash: 'abc123' })
    ids.embedded = insertAlbum(db, { title: 'Only Tags', artist: 'Band', relDir: 'Band/Only Tags', artHash: 'def456' })
    ids.none = insertAlbum(db, { title: 'Bare', artist: 'Band', relDir: 'Band/Bare' })
    ids.escape = insertAlbum(db, { title: 'Sneaky', artist: 'Band', relDir: '../outside', artHash: 'fed789' })
    mkdirSync(join(archive, 'Band', 'Kept'), { recursive: true })
    const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#336699' } }).png().toBuffer()
    writeFileSync(join(archive, 'Band', 'Kept', 'cover-original.png'), png)
    mkdirSync(join(sb.dir, 'outside'), { recursive: true })
    writeFileSync(join(sb.dir, 'outside', 'cover-original.png'), png)
    art = new ArtCache(db, join(sb.dir, 'Music'), join(sb.dir, 'cache'), () => [null, archive])
  })
  afterAll(() => {
    db.close()
    sb.cleanup()
  })

  it('keeps archive paths inside the archive', () => {
    expect(insideRoot(archive, 'Band/Kept')).toBe(resolve(archive, 'Band', 'Kept'))
    expect(insideRoot(archive, '../outside')).toBeNull()
    expect(insideRoot(archive, 'Band/../../outside')).toBeNull()
    expect(insideRoot(archive, '')).toBeNull()
  })

  it('prefers the archived original, else the embedded picture at full size', () => {
    const a = art.originalFor(ids.archived)
    expect(a?.source).toBe('archive')
    expect(a?.url).toMatch(new RegExp(`^valence-art://original/${ids.archived}\\?v=\\d+$`))
    expect(art.originalFor(ids.embedded)).toEqual({ url: 'valence-art://img/def456?s=0', source: 'embedded' })
    expect(artUrl('def456', 0)).toBe('valence-art://img/def456?s=0')
    expect(art.originalFor(ids.none)).toBeNull()
    expect(art.originalFor(999)).toBeNull()
    // An album folder outside the archive is never read.
    expect(art.originalFor(ids.escape)).toEqual({ url: 'valence-art://img/fed789?s=0', source: 'embedded' })
  })

  it('serves both URL forms', async () => {
    const ok = await art.handle(new Request(art.originalFor(ids.archived)!.url))
    expect(ok.status).toBe(200)
    expect(ok.headers.get('content-type')).toBe('image/png')
    expect((await sharp(Buffer.from(await ok.arrayBuffer())).metadata()).width).toBe(8)
    expect((await art.handle(new Request(`valence-art://original/${ids.escape}`))).status).toBe(404)
    expect((await art.handle(new Request('valence-art://original/abc'))).status).toBe(404)
    // No track carries this hash, so there is no embedded picture to serve.
    expect((await art.handle(new Request('valence-art://img/def456?s=0'))).status).toBe(404)
  })
})
