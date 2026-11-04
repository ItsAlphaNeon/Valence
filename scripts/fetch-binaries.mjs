// Downloads the chromaprint `fpcalc` binary for this platform (or all with --all)
// into resources/bin/<platform>-<arch>/. ffmpeg comes from the ffmpeg-static package.
import { mkdir, writeFile, readdir, copyFile, rm, chmod, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'

const VERSION = '1.6.2'
const BASE = `https://github.com/acoustid/chromaprint/releases/download/v${VERSION}`
const TARGETS = {
  'win32-x64': `chromaprint-fpcalc-${VERSION}-windows-x86_64.zip`,
  'darwin-arm64': `chromaprint-fpcalc-${VERSION}-macos-arm64.tar.gz`,
  'darwin-x64': `chromaprint-fpcalc-${VERSION}-macos-x86_64.tar.gz`,
  'linux-x64': `chromaprint-fpcalc-${VERSION}-linux-x86_64.tar.gz`,
  'linux-arm64': `chromaprint-fpcalc-${VERSION}-linux-arm64.tar.gz`,
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const wanted = process.argv.includes('--all') ? Object.keys(TARGETS) : [`${process.platform}-${process.arch}`]

async function findFile(dir, name) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name)
    if (entry.isDirectory()) {
      const hit = await findFile(p, name)
      if (hit) return hit
    } else if (entry.name === name) return p
  }
  return null
}

for (const target of wanted) {
  const asset = TARGETS[target]
  if (!asset) {
    console.warn(`[fetch-binaries] no fpcalc build for ${target}, skipping`)
    continue
  }
  const exe = target.startsWith('win32') ? 'fpcalc.exe' : 'fpcalc'
  const outDir = join(root, 'resources', 'bin', target)
  const outFile = join(outDir, exe)
  if (existsSync(outFile) && (await stat(outFile)).size > 0) {
    console.log(`[fetch-binaries] ${target}: already present`)
    continue
  }
  console.log(`[fetch-binaries] ${target}: downloading ${asset}`)
  const res = await fetch(`${BASE}/${asset}`)
  if (!res.ok) throw new Error(`download failed ${res.status} for ${asset}`)
  const work = join(tmpdir(), `valence-fpcalc-${target}-${Date.now()}`)
  await mkdir(work, { recursive: true })
  const archive = join(work, asset)
  await writeFile(archive, Buffer.from(await res.arrayBuffer()))
  // Windows' bundled bsdtar handles zip and tar.gz; GNU tar from Git Bash misreads C: paths
  const tar = process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar'
  const r = spawnSync(tar, ['-xf', archive, '-C', work], { stdio: 'inherit' })
  if (r.status !== 0) throw new Error(`tar failed for ${asset}`)
  const found = await findFile(work, exe)
  if (!found) throw new Error(`${exe} not found in ${asset}`)
  await mkdir(outDir, { recursive: true })
  // Copy, not rename: the temp folder can be on another drive (C: vs D: on CI runners).
  await copyFile(found, outFile)
  if (!target.startsWith('win32')) await chmod(outFile, 0o755)
  await rm(work, { recursive: true, force: true })
  console.log(`[fetch-binaries] ${target}: ${outFile}`)
}
