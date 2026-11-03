import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { buildLoginUrl, createPkce, extractAuthCode, TOKENS_KEY, TidalAuth, UNIQUE_KEY } from '@main/sources/tidal/auth'
import { resolveConfig, TIDAL_DEFAULTS } from '@main/sources/tidal/config'
import { json, memorySecrets, memorySettings, router } from '../fixtures/tidal/support'

const cfg = resolveConfig(undefined, { apiV1: 'https://api.test/v1', authBase: 'https://auth.test/v1/oauth2' })

describe('tidal PKCE helpers', () => {
  it('matches the RFC 7636 appendix B vector', () => {
    const bytes = Buffer.from([
      116, 24, 223, 180, 151, 153, 224, 37, 79, 250, 96, 125, 216, 173, 187, 186, 22, 212, 37, 77, 105, 214, 191, 240, 91, 88, 5, 88, 83, 132, 141, 121,
    ])
    expect(createPkce(bytes)).toEqual({ verifier: 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk', challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM' })
    const r = createPkce()
    expect(r.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/)
  })

  it('builds the android login URL', () => {
    const u = new URL(buildLoginUrl(TIDAL_DEFAULTS, { challenge: 'CH', clientUniqueKey: 'abc123' }))
    expect(u.origin + u.pathname).toBe('https://login.tidal.com/authorize')
    expect(Object.fromEntries(u.searchParams)).toEqual({
      response_type: 'code',
      redirect_uri: 'https://tidal.com/android/login/auth',
      client_id: TIDAL_DEFAULTS.clientId,
      lang: 'EN',
      appMode: 'android',
      client_unique_key: 'abc123',
      code_challenge: 'CH',
      code_challenge_method: 'S256',
      restrict_signup: 'true',
    })
  })

  it('captures the code only from the redirect URI', () => {
    const r = TIDAL_DEFAULTS.redirectUri
    expect(extractAuthCode('https://tidal.com/android/login/auth?code=XYZ&lang=EN', r)).toEqual({ code: 'XYZ' })
    expect(extractAuthCode('https://www.tidal.com/android/login/auth?code=XYZ', r)).toEqual({ code: 'XYZ' })
    expect(extractAuthCode('https://tidal.com/android/login/auth?error=access_denied&error_description=Nope', r)).toEqual({ error: 'Nope' })
    expect(extractAuthCode('https://tidal.com/android/login/auth', r)).toEqual({ error: 'no authorization code in redirect' })
    expect(extractAuthCode('https://login.tidal.com/authorize?code=XYZ', r)).toBeNull()
    expect(extractAuthCode('https://tidal.com/android/login/authx?code=XYZ', r)).toBeNull()
    expect(extractAuthCode('http://tidal.com/android/login/auth?code=XYZ', r)).toBeNull()
    expect(extractAuthCode('not a url', r)).toBeNull()
  })

  it('lets settings override the rotating client pair', () => {
    const settings = memorySettings()
    const c = resolveConfig(settings)
    expect(c.clientId).toBe(TIDAL_DEFAULTS.clientId)
    settings.set('tidal.clientId', 'rotated-id')
    settings.set('tidal.clientSecret', 'rotated-secret')
    expect(c.clientId).toBe('rotated-id')
    expect(c.clientSecret).toBe('rotated-secret')
    expect({ ...c }.clientId).toBe('rotated-id')
  })
})

describe('TidalAuth', () => {
  const NOW = 1_700_000_000_000
  const transport = () =>
    router(
      (c) =>
        c.url.href === 'https://auth.test/v1/oauth2/token'
          ? json({ access_token: 'acc', refresh_token: 'ref', token_type: 'Bearer', expires_in: 7200, user_id: 42 })
          : undefined,
      (c) => (c.url.href === 'https://api.test/v1/sessions' ? json({ sessionId: 's-1', userId: 42, countryCode: 'NO' }) : undefined),
    )

  it('persists a stable client_unique_key', () => {
    const secrets = memorySecrets()
    const auth = new TidalAuth({ cfg, secrets, transport: transport() })
    const k = auth.clientUniqueKey()
    expect(k).toMatch(/^[0-9a-f]{16}$/)
    expect(auth.clientUniqueKey()).toBe(k)
    expect(secrets.get(UNIQUE_KEY)).toBe(k)
  })

  it('logs in via the injected window, exchanges the code with the matching verifier, and stores tokens', async () => {
    const secrets = memorySecrets()
    const t = transport()
    let challenge = ''
    const auth = new TidalAuth({
      cfg,
      secrets,
      transport: t,
      now: () => NOW,
      openLogin: async (url) => {
        challenge = new URL(url).searchParams.get('code_challenge')!
        return 'AUTH-CODE'
      },
    })
    expect(await auth.login()).toEqual({ loggedIn: true, userId: '42', countryCode: 'NO' })

    const post = new URLSearchParams(t.calls[0].body)
    expect(t.calls[0].method).toBe('POST')
    expect(t.calls[0].headers['content-type']).toBe('application/x-www-form-urlencoded')
    expect(Object.fromEntries(post)).toMatchObject({
      code: 'AUTH-CODE',
      client_id: cfg.clientId,
      grant_type: 'authorization_code',
      redirect_uri: cfg.redirectUri,
      client_unique_key: auth.clientUniqueKey(),
    })
    const verifier = post.get('code_verifier')!
    expect(createHash('sha256').update(verifier).digest('base64url')).toBe(challenge)
    expect(t.calls[1].headers.authorization).toBe('Bearer acc')

    const stored = JSON.parse(secrets.get(TOKENS_KEY)!)
    expect(stored).toMatchObject({ accessToken: 'acc', refreshToken: 'ref', userId: '42', countryCode: 'NO', sessionId: 's-1', expiresAt: NOW + 7_200_000 })
    expect(await auth.accessToken()).toBe('acc')
  })

  it('rejects a failed exchange as auth and stays logged out', async () => {
    const t = router(() => json({ error: 'invalid_grant', error_description: 'Code expired' }, 400))
    const auth = new TidalAuth({ cfg, secrets: memorySecrets(), transport: t, openLogin: async () => 'bad' })
    await expect(auth.login()).rejects.toMatchObject({ kind: 'auth' })
    expect(auth.status().loggedIn).toBe(false)
  })

  it('logout clears stored tokens and notifies', async () => {
    const secrets = memorySecrets()
    const changes: boolean[] = []
    const auth = new TidalAuth({ cfg, secrets, transport: transport(), openLogin: async () => 'c', onChange: (s) => changes.push(s.loggedIn) })
    await auth.login()
    auth.logout()
    expect(secrets.get(TOKENS_KEY)).toBeNull()
    expect(auth.status().loggedIn).toBe(false)
    expect(changes).toEqual([true, false])
    await expect(auth.accessToken()).rejects.toMatchObject({ kind: 'auth' })
  })
})
