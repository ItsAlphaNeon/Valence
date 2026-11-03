// Static TIDAL endpoints and client identity. Credentials mirror python-tidal (EbbLabs/python-tidal,
// tidalapi/session.py @ e575e33, 2026-10-13); TIDAL rotates them, so settings can override.

import type { SettingsStore } from '../../context'

export interface TidalConfig {
  apiV1: string
  apiV2: string
  authBase: string
  loginBase: string
  redirectUri: string
  clientId: string
  clientSecret: string
  userAgent: string
  clientVersion: string
  locale: string
  partition: string
  imageBase: string
  scope: string
}

export const TIDAL_DEFAULTS: Readonly<TidalConfig> = Object.freeze({
  apiV1: 'https://api.tidal.com/v1',
  apiV2: 'https://api.tidal.com/v2',
  authBase: 'https://auth.tidal.com/v1/oauth2',
  loginBase: 'https://login.tidal.com',
  redirectUri: 'https://tidal.com/android/login/auth',
  // PKCE client (python-tidal `client_id_pkce` / `client_secret_pkce`)
  clientId: '6BDSRdpK9hqEBTgU',
  clientSecret: 'xeuPmY7nbpZ9IIbLAcQ93shka1VNheUAqN6IcszjTG8=',
  userAgent:
    'Mozilla/5.0 (Linux; Android 12; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/91.0.4472.114 Safari/537.36',
  clientVersion: '2025.7.16',
  locale: 'en_US',
  partition: 'persist:tidal',
  imageBase: 'https://resources.tidal.com/images',
  scope: 'r_usr+w_usr+w_sub',
})

export const SETTING_CLIENT_ID = 'tidal.clientId'
export const SETTING_CLIENT_SECRET = 'tidal.clientSecret'

/**
 * Builds the effective config. clientId/clientSecret are live getters over `settings`, so a
 * rotated pair set at runtime takes effect on the next request without re-registering.
 */
export function resolveConfig(settings?: SettingsStore, overrides: Partial<TidalConfig> = {}): TidalConfig {
  const cfg: TidalConfig = { ...TIDAL_DEFAULTS, ...overrides }
  if (!settings) return cfg
  const live = (key: string, fallback: string) => {
    const v = settings.get<string>(key, '')
    return typeof v === 'string' && v.trim() ? v.trim() : fallback
  }
  return Object.defineProperties(cfg, {
    clientId: { get: () => live(SETTING_CLIENT_ID, overrides.clientId ?? TIDAL_DEFAULTS.clientId), enumerable: true },
    clientSecret: { get: () => live(SETTING_CLIENT_SECRET, overrides.clientSecret ?? TIDAL_DEFAULTS.clientSecret), enumerable: true },
  })
}

/** Image URL for a TIDAL image uuid (dashes become path separators). */
export function imageUrl(uuid: string | null | undefined, size: 'origin' | 80 | 160 | 320 | 640 | 750 | 1080 | 1280, base = TIDAL_DEFAULTS.imageBase): string | null {
  if (!uuid) return null
  const path = uuid.replace(/-/g, '/')
  return size === 'origin' ? `${base}/${path}/origin.jpg` : `${base}/${path}/${size}x${size}.jpg`
}
