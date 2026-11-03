// Record/replay transport for metadata tests. Responses live as readable JSON files plus an
// index.json mapping request key → { file, status }. Unknown requests replay as 404.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import type { Transport } from '@main/import/source-types'

type Index = Record<string, { file: string; status: number }>

const h = (s: string) => createHash('sha1').update(s).digest('hex').slice(0, 10)

function fileName(url: string, key: string): string {
  const u = new URL(url)
  const p = u.pathname.replace(/^\/ws\/2\//, '').replace(/^\/api\//, '').replace(/^\/v2\//, '')
  const id = /^(release|recording|release-group)\/([0-9a-f-]{36})$/.exec(p)
  if (id) return `${id[1]}-${id[2]}.json`
  const host = u.hostname.split('.').slice(-2, -1)[0]
  return `${host}-${p.replace(/[^a-z0-9]+/gi, '-')}-${h(key)}.json`
}

export interface FixtureTransport {
  transport: Transport
  misses: string[]
  requests: string[]
}

export function fixtureTransport(dir: string, mode: 'replay' | 'record' = process.env.VALENCE_RECORD ? 'record' : 'replay'): FixtureTransport {
  const indexFile = join(dir, 'index.json')
  const load = (): Index => (existsSync(indexFile) ? (JSON.parse(readFileSync(indexFile, 'utf8')) as Index) : {})
  const misses: string[] = []
  const requests: string[] = []
  const transport: Transport = async (url, init) => {
    const body = typeof init?.body === 'string' ? init.body : ''
    const key = body ? `${init?.method ?? 'GET'} ${url}\n${body}` : url
    requests.push(key)
    const index = load()
    const hit = index[key]
    if (hit) return new Response(readFileSync(join(dir, hit.file), 'utf8'), { status: hit.status, headers: { 'Content-Type': 'application/json' } })
    if (mode !== 'record') {
      misses.push(key)
      return new Response('{"error":"not recorded"}', { status: 404 })
    }
    const res = await fetch(url, init)
    const text = await res.text()
    if (res.status === 503 || res.status === 429) return new Response(text, { status: res.status, headers: res.headers })
    mkdirSync(dir, { recursive: true })
    const file = fileName(url, key)
    writeFileSync(join(dir, file), text)
    index[key] = { file, status: res.status }
    writeFileSync(indexFile, JSON.stringify(index, null, 1))
    return new Response(text, { status: res.status, headers: { 'Content-Type': 'application/json' } })
  }
  return { transport, misses, requests }
}
