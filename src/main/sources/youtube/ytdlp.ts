// yt-dlp, fetched on first use from the official GitHub release (checked against its SHA2-256SUMS)
// into <dataDir>/bin and self-updated daily, because YouTube changes often enough that a bundled copy
// would go stale. YouTube needs a JavaScript runtime; Valence's own Electron serves as one
// (ELECTRON_RUN_AS_NODE=1), so nothing else has to be installed.

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { SourceError, type Transport } from '@main/import/source-types'
import { ffmpegPath } from '@main/platform/binaries'

const RELEASE = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/'
const UPDATE_EVERY_MS = 24 * 3600_000

export function ytDlpAsset(platform = process.platform, arch = process.arch): string {
  if (platform === 'win32') return arch === 'ia32' ? 'yt-dlp_x86.exe' : 'yt-dlp.exe'
  if (platform === 'darwin') return 'yt-dlp_macos'
  return arch === 'arm64' ? 'yt-dlp_linux_aarch64' : 'yt-dlp_linux'
}

/** The SHA-256 for `asset` in a SHA2-256SUMS file ("<hex>  <name>" lines). */
export function sumFor(sums: string, asset: string): string | null {
  for (const line of sums.split(/\r?\n/)) {
    const m = /^([0-9a-f]{64})\s+\*?(.+)$/i.exec(line.trim())
    if (m && m[2].trim() === asset) return m[1].toLowerCase()
  }
  return null
}

export interface RunResult {
  code: number
  stdout: string
  stderr: string
}

export interface YtDlpOptions {
  dataDir: string
  transport: Transport
  /** JS runtime for YouTube's challenges: "node:<path>" (default: this Electron as node). */
  jsRuntime?: string | null
  /** Persisted "last update check" time. */
  lastUpdate?: { get(): number; set(ms: number): void }
  log?: { warn(msg: string, extra?: unknown): void; info(msg: string, extra?: unknown): void }
}

export class YtDlp {
  private ready: Promise<string> | null = null
  private version: string | null = null

  constructor(private opts: YtDlpOptions) {}

  get path(): string {
    return join(this.opts.dataDir, 'bin', process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp')
  }

  /** Path of a working binary: downloads it on first use and updates it at most once a day. */
  ensure(): Promise<string> {
    return (this.ready ??= this.prepare().catch((e) => {
      this.ready = null
      throw e
    }))
  }

  private async prepare(): Promise<string> {
    const p = this.path
    if (!existsSync(p) || statSync(p).size < 1_000_000) await this.download(p)
    else if (Date.now() - (this.opts.lastUpdate?.get() ?? 0) > UPDATE_EVERY_MS) {
      const r = await this.exec(p, ['-U'], { timeoutMs: 120_000 }).catch((e) => ({ code: -1, stdout: '', stderr: String(e) }))
      if (r.code !== 0) this.opts.log?.warn('yt-dlp: self-update failed; keeping the current version', r.stderr.slice(-400))
      this.opts.lastUpdate?.set(Date.now())
    }
    this.version = (await this.exec(p, ['--version'], { timeoutMs: 30_000 })).stdout.trim() || null
    return p
  }

  async currentVersion(): Promise<string | null> {
    if (this.version) return this.version
    if (!existsSync(this.path)) return null
    try {
      return (this.version = (await this.exec(this.path, ['--version'], { timeoutMs: 30_000 })).stdout.trim() || null)
    } catch {
      return null
    }
  }

  private async download(dest: string): Promise<void> {
    const asset = ytDlpAsset()
    this.opts.log?.info(`yt-dlp: downloading ${asset}`)
    const get = async (name: string) => {
      let res: Response
      try {
        res = await this.opts.transport(RELEASE + name, { redirect: 'follow' })
      } catch (e) {
        throw new SourceError(`Couldn't download yt-dlp: ${(e as Error)?.message ?? e}`, 'network')
      }
      if (!res.ok) throw new SourceError(`Couldn't download yt-dlp: HTTP ${res.status}`, 'network')
      return Buffer.from(await res.arrayBuffer())
    }
    const [bin, sums] = await Promise.all([get(asset), get('SHA2-256SUMS')])
    const want = sumFor(sums.toString('utf8'), asset)
    const got = createHash('sha256').update(bin).digest('hex')
    if (!want || want !== got) throw new SourceError('The downloaded yt-dlp failed its checksum check; not using it', 'parse')
    mkdirSync(dirname(dest), { recursive: true })
    const tmp = `${dest}.part`
    writeFileSync(tmp, bin)
    if (process.platform !== 'win32') chmodSync(tmp, 0o755)
    renameSync(tmp, dest)
    this.opts.lastUpdate?.set(Date.now())
  }

  /** Arguments every run gets: no user config, our ffmpeg, Electron as the JS runtime. */
  baseArgs(): string[] {
    const runtime = this.opts.jsRuntime === undefined ? `node:${process.execPath}` : this.opts.jsRuntime
    let ffmpeg: string | null = null
    try {
      ffmpeg = ffmpegPath()
    } catch {
      /* yt-dlp can still list playlists without ffmpeg */
    }
    return ['--ignore-config', '--no-colors', ...(runtime ? ['--js-runtimes', runtime] : []), ...(ffmpeg ? ['--ffmpeg-location', ffmpeg] : [])]
  }

  async run(args: string[], opts: { signal?: AbortSignal; onLine?: (line: string) => void; timeoutMs?: number } = {}): Promise<RunResult> {
    const bin = await this.ensure()
    return this.exec(bin, [...this.baseArgs(), ...args], opts)
  }

  private exec(bin: string, args: string[], opts: { signal?: AbortSignal; onLine?: (line: string) => void; timeoutMs?: number } = {}): Promise<RunResult> {
    return new Promise((resolve, reject) => {
      if (opts.signal?.aborted) return reject(new SourceError('Cancelled', 'cancelled'))
      const child = spawn(bin, args, { windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', PYTHONIOENCODING: 'utf-8' } })
      let stdout = ''
      let stderr = ''
      let partial = ''
      child.stdout.setEncoding('utf8')
      child.stderr.setEncoding('utf8')
      child.stdout.on('data', (d: string) => {
        stdout += d
        if (!opts.onLine) return
        const lines = (partial + d).split(/\r?\n|\r/)
        partial = lines.pop() ?? ''
        for (const l of lines) if (l) opts.onLine(l)
      })
      child.stderr.on('data', (d: string) => {
        stderr += d
        if (stderr.length > 1 << 20) stderr = stderr.slice(-(1 << 19))
      })
      const kill = () => child.kill('SIGKILL')
      const timer = opts.timeoutMs ? setTimeout(kill, opts.timeoutMs) : null
      opts.signal?.addEventListener('abort', kill, { once: true })
      child.on('error', (e) => reject(new SourceError(`Couldn't run yt-dlp: ${e.message}`, 'network')))
      child.on('close', (code) => {
        if (timer) clearTimeout(timer)
        opts.signal?.removeEventListener('abort', kill)
        if (opts.signal?.aborted) return reject(new SourceError('Cancelled', 'cancelled'))
        resolve({ code: code ?? -1, stdout, stderr })
      })
    })
  }
}

/** A yt-dlp failure → a SourceError the import queue can act on. */
export function ytDlpError(stderr: string, what: string): SourceError {
  const tail = stderr.split(/\r?\n/).filter((l) => /ERROR|error/.test(l)).slice(-2).join(' ').replace(/^ERROR:\s*/, '') || stderr.trim().split(/\r?\n/).pop() || 'unknown error'
  if (/HTTP Error 429|Too Many Requests|rate.?limit/i.test(stderr)) return new SourceError(`YouTube is rate limiting: ${tail}`, 'rate-limit', 15 * 60_000)
  if (/Sign in to confirm you.?re not a bot|confirm you are not a robot|captcha/i.test(stderr)) return new SourceError(`YouTube asked to confirm you're not a bot. Wait a while, then resume from Import. (${tail})`, 'abuse')
  if (/Private video|Video unavailable|has been removed|not available in your country|members-only|This video is no longer available/i.test(stderr)) return new SourceError(`${what}: ${tail}`, 'unavailable')
  if (/Unable to download|Connection|timed out|getaddrinfo|ECONN/i.test(stderr)) return new SourceError(`${what}: ${tail}`, 'network')
  return new SourceError(`${what}: ${tail}`, 'parse')
}

/** "[download]  45.3% of ~ 3.10MiB …" → 0.453 */
export function downloadFraction(line: string): number | null {
  const m = /\[download\]\s+(\d+(?:\.\d+)?)%/.exec(line)
  return m ? Math.min(1, Number(m[1]) / 100) : null
}

export function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(file, 'utf8')) as T
}
