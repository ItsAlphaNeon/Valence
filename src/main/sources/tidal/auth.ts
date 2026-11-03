// TIDAL PKCE login, token storage and refresh. Electron-free: the login window is injected
// (default: ./login-window), so everything here runs under vitest with a fake transport.

import { createHash, randomBytes } from 'node:crypto'
import type { Logger, SecretStore } from '../../context'
import { SourceError, type Transport } from '../../import/source-types'
import type { TidalConfig } from './config'
import type { TidalSession } from './types'

export const TOKENS_KEY = 'tidal.tokens'
export const UNIQUE_KEY = 'tidal.clientUniqueKey'
/** Refresh this long before the access token expires. */
export const EXPIRY_MARGIN_MS = 2 * 60_000

export interface TidalTokens {
  accessToken: string
  refreshToken: string
  tokenType: string
  /** epoch ms */
  expiresAt: number
  userId: string
  countryCode: string
  sessionId?: string
  /** The client pair that issued the tokens; refresh must use the same one. */
  clientId: string
  clientSecret: string
}

export interface TidalAuthStatus {
  loggedIn: boolean
  userId: string | null
  countryCode: string | null
}

export type CodeCapture = { code: string } | { error: string }

/** Opens the login UI for `loginUrl` and resolves with the authorization code. */
export type LoginOpener = (loginUrl: string, cfg: TidalConfig) => Promise<string>

export const base64url = (buf: Buffer): string => buf.toString('base64url')

export function createPkce(bytes: Buffer = randomBytes(32)): { verifier: string; challenge: string } {
  const verifier = base64url(bytes)
  return { verifier, challenge: base64url(createHash('sha256').update(verifier, 'ascii').digest()) }
}

export function buildLoginUrl(cfg: TidalConfig, p: { challenge: string; clientUniqueKey: string }): string {
  const q = new URLSearchParams({
    response_type: 'code',
    redirect_uri: cfg.redirectUri,
    client_id: cfg.clientId,
    lang: 'EN',
    appMode: 'android',
    client_unique_key: p.clientUniqueKey,
    code_challenge: p.challenge,
    code_challenge_method: 'S256',
    restrict_signup: 'true',
  })
  return `${cfg.loginBase}/authorize?${q}`
}

/**
 * Pure redirect check used by the login window: null when `url` is not the redirect target,
 * otherwise the captured code (or the error TIDAL reported).
 */
export function extractAuthCode(url: string, redirectUri: string): CodeCapture | null {
  let u: URL
  let r: URL
  try {
    u = new URL(url)
    r = new URL(redirectUri)
  } catch {
    return null
  }
  if (u.protocol !== r.protocol || u.hostname.replace(/^www\./, '') !== r.hostname.replace(/^www\./, '')) return null
  const base = r.pathname.replace(/\/+$/, '')
  if (u.pathname !== base && !u.pathname.startsWith(base + '/')) return null
  const code = u.searchParams.get('code')
  if (code) return { code }
  return { error: u.searchParams.get('error_description') || u.searchParams.get('error') || 'no authorization code in redirect' }
}

export interface TidalAuthDeps {
  cfg: TidalConfig
  secrets: SecretStore
  transport: Transport
  openLogin?: LoginOpener
  now?: () => number
  log?: Logger
  onChange?: (s: TidalAuthStatus) => void
}

async function readJson(res: Response): Promise<any> {
  const text = await res.text()
  try {
    return text ? JSON.parse(text) : {}
  } catch {
    return { raw: text }
  }
}

export class TidalAuth {
  private cached: TidalTokens | null | undefined
  private refreshing: Promise<TidalTokens> | null = null
  private loggingIn: Promise<TidalAuthStatus> | null = null
  private readonly now: () => number

  constructor(private readonly deps: TidalAuthDeps) {
    this.now = deps.now ?? Date.now
  }

  tokens(): TidalTokens | null {
    if (this.cached !== undefined) return this.cached
    const raw = this.deps.secrets.get(TOKENS_KEY)
    try {
      const t = raw ? (JSON.parse(raw) as TidalTokens) : null
      this.cached = t?.accessToken && t.refreshToken ? t : null
    } catch {
      this.cached = null
    }
    return this.cached
  }

  status(): TidalAuthStatus {
    const t = this.tokens()
    return { loggedIn: !!t, userId: t?.userId ?? null, countryCode: t?.countryCode ?? null }
  }

  session(): { userId: string; countryCode: string } | null {
    const t = this.tokens()
    return t ? { userId: t.userId, countryCode: t.countryCode } : null
  }

  clientUniqueKey(): string {
    let k = this.deps.secrets.get(UNIQUE_KEY)
    if (!k) {
      k = randomBytes(8).toString('hex')
      this.deps.secrets.set(UNIQUE_KEY, k)
    }
    return k
  }

  /** Opens the login window, exchanges the code and stores the tokens. Single-flight. */
  login(): Promise<TidalAuthStatus> {
    this.loggingIn ??= this.doLogin().finally(() => (this.loggingIn = null))
    return this.loggingIn
  }

  private async doLogin(): Promise<TidalAuthStatus> {
    const { cfg } = this.deps
    const { verifier, challenge } = createPkce()
    const url = buildLoginUrl(cfg, { challenge, clientUniqueKey: this.clientUniqueKey() })
    const open = this.deps.openLogin ?? (await import('./login-window')).openLoginWindow
    const code = await open(url, cfg)
    await this.exchangeCode(code, verifier)
    return this.status()
  }

  async exchangeCode(code: string, verifier: string): Promise<TidalTokens> {
    const { cfg } = this.deps
    const clientId = cfg.clientId
    const clientSecret = cfg.clientSecret
    const json = await this.postToken({
      code,
      client_id: clientId,
      grant_type: 'authorization_code',
      redirect_uri: cfg.redirectUri,
      scope: cfg.scope,
      code_verifier: verifier,
      client_unique_key: this.clientUniqueKey(),
    })
    const tokenType = json.token_type || 'Bearer'
    const sess = await this.fetchSession(tokenType, json.access_token)
    const tokens: TidalTokens = {
      accessToken: json.access_token,
      refreshToken: json.refresh_token,
      tokenType,
      expiresAt: this.now() + Number(json.expires_in ?? 3600) * 1000,
      userId: String(sess?.userId ?? json.user_id ?? json.user?.userId ?? ''),
      countryCode: sess?.countryCode ?? json.user?.countryCode ?? 'US',
      sessionId: sess?.sessionId,
      clientId,
      clientSecret,
    }
    if (!tokens.accessToken || !tokens.refreshToken) throw new SourceError('TIDAL login returned no tokens', 'auth')
    this.persist(tokens)
    return tokens
  }

  /** A valid access token, refreshed proactively when it is about to expire. */
  async accessToken(): Promise<string> {
    const t = this.tokens()
    if (!t) throw new SourceError('Not logged in to TIDAL', 'auth')
    if (t.expiresAt - this.now() > EXPIRY_MARGIN_MS) return t.accessToken
    return (await this.refresh(t.accessToken)).accessToken
  }

  /**
   * Refreshes the access token at most once for concurrent callers. `stale` is the token the
   * caller used: if another caller already replaced it, the fresh tokens are returned as-is.
   */
  refresh(stale?: string): Promise<TidalTokens> {
    const t = this.tokens()
    if (!t) return Promise.reject(new SourceError('Not logged in to TIDAL', 'auth'))
    if (this.refreshing) return this.refreshing
    if (stale && stale !== t.accessToken && t.expiresAt - this.now() > EXPIRY_MARGIN_MS) return Promise.resolve(t)
    this.refreshing = this.doRefresh(t).finally(() => (this.refreshing = null))
    return this.refreshing
  }

  private async doRefresh(t: TidalTokens): Promise<TidalTokens> {
    let json: any
    try {
      json = await this.postToken({
        grant_type: 'refresh_token',
        refresh_token: t.refreshToken,
        client_id: t.clientId,
        client_secret: t.clientSecret,
        scope: this.deps.cfg.scope,
      })
    } catch (e) {
      if (e instanceof SourceError && e.kind === 'auth') {
        this.deps.log?.warn('TIDAL refresh token rejected; login required', e.message)
        this.clear()
      }
      throw e
    }
    const next: TidalTokens = {
      ...t,
      accessToken: json.access_token,
      tokenType: json.token_type || t.tokenType,
      expiresAt: this.now() + Number(json.expires_in ?? 3600) * 1000,
      // TIDAL rotates refresh tokens; the old one is dead once a new one is issued.
      refreshToken: json.refresh_token || t.refreshToken,
    }
    if (!next.accessToken) throw new SourceError('TIDAL refresh returned no access token', 'auth')
    this.persist(next)
    return next
  }

  logout(): void {
    this.clear()
  }

  private clear(): void {
    this.deps.secrets.set(TOKENS_KEY, null)
    this.cached = null
    this.deps.onChange?.(this.status())
  }

  private persist(t: TidalTokens): void {
    this.deps.secrets.set(TOKENS_KEY, JSON.stringify(t))
    this.cached = t
    this.deps.onChange?.(this.status())
  }

  private async postToken(form: Record<string, string>): Promise<any> {
    let res: Response
    try {
      res = await this.deps.transport(`${this.deps.cfg.authBase}/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', 'User-Agent': this.deps.cfg.userAgent },
        body: new URLSearchParams(form).toString(),
      })
    } catch (e) {
      throw new SourceError(`TIDAL auth request failed: ${(e as Error).message}`, 'network')
    }
    const json = await readJson(res)
    if (res.ok) return json
    const msg = `TIDAL auth failed (${res.status}): ${json.error_description || json.error || json.userMessage || 'unknown error'}`
    if (res.status === 429 || res.status >= 500) throw new SourceError(msg, res.status === 429 ? 'rate-limit' : 'network')
    throw new SourceError(msg, 'auth')
  }

  private async fetchSession(tokenType: string, accessToken: string): Promise<TidalSession | null> {
    const { cfg } = this.deps
    try {
      const res = await this.deps.transport(`${cfg.apiV1}/sessions`, {
        headers: { authorization: `${tokenType} ${accessToken}`, 'x-tidal-client-version': cfg.clientVersion, 'User-Agent': cfg.userAgent },
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return (await res.json()) as TidalSession
    } catch (e) {
      this.deps.log?.warn('TIDAL sessions lookup failed', (e as Error).message)
      return null
    }
  }
}
