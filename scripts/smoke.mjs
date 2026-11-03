// Runs `electron . --smoke` and prints the native-module/binary load report.
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const require = createRequire(import.meta.url)
const electron = require('electron')
const userData = mkdtempSync(join(tmpdir(), 'valence-smoke-'))

const child = spawn(electron, ['.', '--smoke'], {
  env: { ...process.env, VALENCE_USER_DATA: userData, ELECTRON_ENABLE_LOGGING: '0' },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let out = ''
child.stdout.on('data', (d) => (out += d))
child.stderr.on('data', (d) => process.stderr.write(d))
child.on('exit', (code) => {
  const line = out.split('\n').find((l) => l.startsWith('VALENCE_SMOKE '))
  if (!line) {
    console.error('No smoke report; exit code', code, '\n', out)
    process.exit(1)
  }
  const results = JSON.parse(line.slice('VALENCE_SMOKE '.length))
  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name.padEnd(18)} ${r.detail}`)
  process.exit(code ?? 1)
})
